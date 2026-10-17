import test from 'node:test';
import assert from 'node:assert/strict';

let createRecoveryController, createIndexedDBRecoveryStore;
try {
  ({createRecoveryController, createIndexedDBRecoveryStore} = await import('../frontend/draft-recovery.mjs'));
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes('draft-recovery.mjs')) throw error;
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const clone = value => value === undefined ? undefined : structuredClone(value);
const deferred = () => {let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject};};

function memoryStore() {
  const records = new Map();
  return {
    records, writes: [],
    async get(id) {return clone(records.get(id));},
    async put(record) {this.writes.push(clone(record)); records.set(record.recoveryId ?? record.id,clone(record));},
    async delete(id) {records.delete(id);},
    async deleteIfUnchanged(expected) {
      const key=expected.recoveryId ?? expected.id;
      if (JSON.stringify(records.get(key)) !== JSON.stringify(expected)) return false;
      records.delete(key);return true;
    },
    async list() {return [...records.values()].map(clone);},
  };
}

function harness(options = {}) {
  assert.equal(typeof createRecoveryController,'function','recovery controller implementation is missing');
  let current = {id:'a',content:'initial',metadata:{title:'A'},revision:'r0'};
  let time = 0, counter = 0;
  const timers = new Map(), states = [], storage = options.storage ?? memoryStore();
  const controller = createRecoveryController({
    storage, capture: () => current, onState: state => states.push(state), now: () => time,
    setTimer(callback,delay) {const id=++counter;timers.set(id,{callback,at:time+delay});return id;},
    clearTimer(id) {timers.delete(id);}, ...options,
  });
  return {
    controller, storage, states, timers,
    set(value) {current = value;},
    edit(content) {current={...current,content};controller.changed();},
    current: () => current,
    async advance(duration) {
      const until=time+duration;
      while (true) {
        const next=[...timers.entries()].filter(([,timer]) => timer.at<=until).sort((a,b) => a[1].at-b[1].at)[0];
        if (!next) break;
        time=next[1].at;timers.delete(next[0]);next[1].callback();await tick();
      }
      time=until;await tick();
    },
  };
}

test('idle edits persist after one second with metadata, base revision and timestamp', async () => {
  const h=harness();h.edit('new text');
  await h.advance(999);assert.equal(h.storage.writes.length,0);
  await h.advance(1);const record=await h.controller.read('a');
  assert.deepEqual({...record,recoveryId:undefined},{id:'a',content:'new text',metadata:{title:'A'},revision:'r0',updatedAt:0,recoveryId:undefined});
  assert.deepEqual(h.states.map(state=>state.status),['pending','saving','stored']);
  assert.ok(h.states.every(state=>state.id==='a' && Number.isFinite(state.time)));
});

test('continuous typing persists at the two second maximum deadline', async () => {
  const h=harness();h.edit('0');
  for (let i=1;i<=3;i++) {await h.advance(600);h.edit(String(i));}
  await h.advance(199);assert.equal(h.storage.writes.length,0);
  await h.advance(1);assert.equal(h.storage.writes[0].content,'3');
  h.edit('4');await h.advance(1000);assert.equal(h.storage.writes.at(-1).content,'4');
});

test('flush captures immediately and callers cannot mutate a queued recovery snapshot', async () => {
  const h=harness();h.set({id:'a',content:'immediate',metadata:{nested:{title:'original'}},revision:'base'});
  const flushed=h.controller.flush();h.current().metadata.nested.title='mutated';
  await flushed;
  assert.equal((await h.controller.read('a')).metadata.nested.title,'original');
  assert.equal(h.timers.size,0);
});

test('delayed writes remain serialized and an older completion cannot mark a newer edit stored', async () => {
  const storage=memoryStore(), started=[], gate=deferred(), original=storage.put.bind(storage);
  storage.put=async record=>{started.push(record.content);if(record.content==='first')await gate.promise;await original(record);};
  const h=harness({storage});h.edit('first');const first=h.controller.flush();await tick();
  h.edit('second');const second=h.controller.flush();await tick();assert.deepEqual(started,['first']);
  gate.resolve();await first;await second;
  assert.deepEqual(started,['first','second']);assert.equal((await h.controller.read('a')).content,'second');
  assert.equal(h.states.filter(state=>state.status==='stored').length,1);
});

test('a quota failure remains visible and a later flush retries the retained edit', async () => {
  const storage=memoryStore(), original=storage.put.bind(storage);let fail=true;
  storage.put=async record=>{if(fail){const error=new Error('disk full');error.name='QuotaExceededError';throw error;}await original(record);};
  const h=harness({storage});h.edit('must survive');await h.advance(1000);
  assert.equal(h.states.at(-1).status,'error');assert.equal(h.states.at(-1).error.name,'QuotaExceededError');
  fail=false;await h.controller.flush();assert.equal((await h.controller.read('a')).content,'must survive');
});

test('acknowledging an older save preserves newer input even without a changed notification', async () => {
  const h=harness();h.edit('saved text');await h.controller.flush();const acknowledged=h.current();
  h.set({...h.current(),content:'new input'});
  assert.equal(await h.controller.clearSaved(acknowledged),false);
  await h.controller.flush();assert.equal((await h.controller.read('a')).content,'new input');
});

test('metadata comparison uses exact JSON values and ignores object key order', async () => {
  const h=harness();h.set({id:'a',content:'text',metadata:{title:'A',cover:'one.png'},revision:'r1'});await h.controller.flush();
  assert.equal(await h.controller.clearSaved({id:'a',content:'text',metadata:{cover:'one.png',title:'A'}}),true);
  assert.equal(await h.controller.read('a'),null);
  h.set({id:'a',content:'text',metadata:{title:'A',cover:'two.png'},revision:'r2'});await h.controller.flush();
  assert.equal(await h.controller.clearSaved({id:'a',content:'text',metadata:{cover:'one.png',title:'A'}}),false);
  assert.equal((await h.controller.read('a')).metadata.cover,'two.png');
});

test('clear waits for an older outstanding write and keeps a newer generation queued after it', async () => {
  const storage=memoryStore(), gate=deferred(), original=storage.put.bind(storage);
  storage.put=async record=>{if(record.content==='first')await gate.promise;await original(record);};
  const h=harness({storage});h.edit('first');const first=h.controller.flush();await tick();
  const cleared=h.controller.clearSaved(h.current());h.edit('second');const second=h.controller.flush();
  gate.resolve();await first;assert.equal(await cleared,false);await second;
  assert.equal((await h.controller.read('a')).content,'second');
});

test('switching articles retains pending edits and a late save acknowledgement cannot remove them', async () => {
  const h=harness();h.edit('a-old');await h.controller.flush();const acknowledged=h.current();
  h.edit('a-new');h.set({id:'b',content:'b-new',metadata:{title:'B'},revision:'rb'});h.controller.changed();
  assert.equal(await h.controller.clearSaved(acknowledged),false);
  await h.advance(1000);
  assert.equal((await h.controller.read('a')).content,'a-new');assert.equal((await h.controller.read('b')).content,'b-new');
});

test('an edit during asynchronous recovery lookup protects its generation from old clear', async () => {
  const storage=memoryStore(), h=harness({storage});h.edit('old');await h.controller.flush();
  const gate=deferred(), original=storage.get.bind(storage);storage.get=async id=>{await gate.promise;return original(id);};
  const cleared=h.controller.clearSaved(h.current());await tick();h.edit('new');gate.resolve();
  assert.equal(await cleared,false);await h.controller.flush();assert.equal((await h.controller.read('a')).content,'new');
});

test('an old atomic clear completion cannot report a newer pending edit as stored', async () => {
  const storage=memoryStore(), h=harness({storage});h.edit('old');await h.controller.flush();
  const gate=deferred(), original=storage.deleteIfUnchanged.bind(storage);storage.deleteIfUnchanged=async expected=>{await gate.promise;return original(expected);};
  const cleared=h.controller.clearSaved(h.current());await tick();h.edit('new');gate.resolve();await cleared;
  assert.equal(h.states.at(-1).status,'pending');await h.controller.flush();
  assert.equal((await h.controller.read('a')).content,'new');
});

test('an old explicit discard completion cannot hide a newer pending generation', async () => {
  const storage=memoryStore(), h=harness({storage});h.edit('old');await h.controller.flush();
  const gate=deferred(), original=storage.delete.bind(storage);storage.delete=async id=>{await gate.promise;await original(id);};
  const discarded=h.controller.discard('a');await tick();h.edit('new');gate.resolve();await discarded;
  assert.equal(h.states.at(-1).status,'pending');await h.controller.flush();
  assert.equal((await h.controller.read('a')).content,'new');
});

test('restart can list/read persisted records and explicit discard leaves other articles intact', async () => {
  const h=harness();h.edit('A');await h.controller.flush();h.set({id:'b',content:'B',metadata:{title:'B'},revision:'rb'});await h.controller.flush();
  const restarted=harness({storage:h.storage});restarted.set(null);
  assert.deepEqual((await restarted.controller.list()).map(record=>record.id).sort(),['a','b']);
  assert.equal((await restarted.controller.read('a')).revision,'r0');await restarted.controller.discard('a');
  assert.equal(await restarted.controller.read('a'),null);assert.equal((await restarted.controller.read('b')).content,'B');
});

test('a count limit reports an error without evicting any previous unsaved record', async () => {
  const h=harness({maxRecords:1});h.edit('A');await h.controller.flush();h.set({id:'b',content:'B',metadata:{},revision:'rb'});
  await assert.rejects(h.controller.flush(),/limit/i);assert.equal((await h.controller.read('a')).content,'A');
  assert.equal(await h.controller.read('b'),null);assert.equal(h.states.at(-1).status,'error');
  await h.controller.discard('a');await h.controller.flush();assert.equal((await h.controller.read('b')).content,'B');
});

test('non-JSON metadata and UTF-8 content beyond five MiB fail explicitly without persistence', async () => {
  const h=harness();
  for (const metadata of [{when:new Date()}, {bad:undefined}, {bad:Infinity}, {bad:()=>{}}, {bad:1n}]) {
    h.set({id:'a',content:'text',metadata,revision:'r0'});await assert.rejects(h.controller.flush(),/JSON/i);
  }
  const circular={};circular.self=circular;h.set({id:'a',content:'text',metadata:circular,revision:'r0'});await assert.rejects(h.controller.flush(),/JSON/i);
  h.set({id:'a',content:'中'.repeat(2*1024*1024),metadata:{},revision:'r0'});await assert.rejects(h.controller.flush(),/5 MiB/);
  assert.equal(h.storage.writes.length,0);assert.equal(h.states.at(-1).status,'error');
});

test('IndexedDB unavailable and open failures reject through the storage API', async () => {
  assert.equal(typeof createIndexedDBRecoveryStore,'function','IndexedDB store implementation is missing');
  const unavailable=createIndexedDBRecoveryStore(null);await assert.rejects(unavailable.list(),/unavailable/i);
  const failed=createIndexedDBRecoveryStore({open(){const request={};queueMicrotask(()=>{request.error=new Error('denied');request.onerror();});return request;}});
  await assert.rejects(failed.put({id:'a',content:'A',metadata:{},revision:'r0',updatedAt:1}),/denied/);
});

test('two windows editing the same draft both survive restart as distinct recovery records', async () => {
  const storage=memoryStore(), first=harness({storage}), second=harness({storage});
  first.edit('first window unsaved');second.edit('second window unsaved');
  await Promise.all([first.controller.flush(),second.controller.flush()]);
  const restarted=harness({storage});restarted.set(null);
  const records=await restarted.controller.list();
  assert.equal(records.length,2);
  assert.ok(records.every(record=>record.id==='a' && typeof record.recoveryId==='string'));
  assert.notEqual(records[0].recoveryId,records[1].recoveryId);
  assert.deepEqual(records.map(record=>record.content).sort(),['first window unsaved','second window unsaved']);
  for(const record of records) assert.equal((await restarted.controller.read(record.recoveryId)).content,record.content);
  await assert.rejects(restarted.controller.read('a'),/ambiguous/i);
  await assert.rejects(restarted.controller.discard('a'),/ambiguous/i);
  await restarted.controller.discard(records[0].recoveryId);
  assert.equal((await restarted.controller.list()).length,1);
});

test('saving one window removes only its own recovery and leaves another window intact', async () => {
  const storage=memoryStore(), first=harness({storage}), second=harness({storage});
  first.edit('saved here');second.edit('unsaved elsewhere');
  await first.controller.flush();await second.controller.flush();
  assert.equal(await first.controller.clearSaved(first.current()),true);
  assert.deepEqual((await second.controller.list()).map(record=>record.content),['unsaved elsewhere']);
  assert.equal((await second.controller.read('a')).content,'unsaved elsewhere');
});

test('atomic acknowledgement cannot delete a replacement written after lookup', async () => {
  const storage=memoryStore(), h=harness({storage});h.edit('saved');await h.controller.flush();
  const original=storage.deleteIfUnchanged.bind(storage);
  storage.deleteIfUnchanged=async expected=>{
    await storage.put({...expected,content:'replacement from another writer',revision:'new-base',updatedAt:expected.updatedAt+1});
    return original(expected);
  };
  assert.equal(await h.controller.clearSaved(h.current()),false);
  assert.equal((await h.controller.read('a')).content,'replacement from another writer');
});

test('legacy v1 recovery survives new window writes and cannot be cleared by a new owner', async () => {
  const storage=memoryStore();await storage.put({id:'a',content:'legacy unsaved',metadata:{title:'A'},revision:'old',updatedAt:1});
  const h=harness({storage});assert.equal((await h.controller.read('a')).content,'legacy unsaved');
  assert.equal(await h.controller.clearSaved({id:'a',content:'legacy unsaved',metadata:{title:'A'}}),false);
  h.edit('new window');await h.controller.flush();
  const records=await h.controller.list();assert.equal(records.length,2);
  const legacy=records.find(record=>record.content==='legacy unsaved');
  assert.equal((await h.controller.read(legacy.recoveryId)).revision,'old');
  await h.controller.discard(legacy.recoveryId);
  assert.equal((await h.controller.read('a')).content,'new window');
});

test('a store without atomic conditional deletion retains recovery rather than risking loss', async () => {
  const storage=memoryStore();delete storage.deleteIfUnchanged;
  const h=harness({storage});h.edit('saved');await h.controller.flush();
  assert.equal(await h.controller.clearSaved(h.current()),false);
  assert.equal((await h.controller.read('a')).content,'saved');
});

test('record limit includes distinct same-draft windows and never replaces another window', async () => {
  const storage=memoryStore(), first=harness({storage,maxRecords:1}), second=harness({storage,maxRecords:1});
  first.edit('first window');await first.controller.flush();second.edit('second window');
  await assert.rejects(second.controller.flush(),/limit/i);
  assert.deepEqual((await first.controller.list()).map(record=>record.content),['first window']);
});
