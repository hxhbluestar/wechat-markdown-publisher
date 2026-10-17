import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
let createPreflightAcknowledgements;
try {({createPreflightAcknowledgements}=await import('../frontend/preflight-ack.mjs'));}
catch(error) {if(error.code!=='ERR_MODULE_NOT_FOUND'||!error.message.includes('preflight-ack.mjs'))throw error;}

function store() {
  const data=new Map();return {data,getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)};
}
function context(overrides={}) {
  const content='Unrelated opening. '+'Left context around '.repeat(3)+'172.25.12.3'+' Right context around'.repeat(3)+' The end.';
  const from=content.indexOf('172.25.12.3');
  return {draftId:'draft-private-local',accountId:'account-private-local',renderVersion:'render-v1',fingerprint:'a'.repeat(64),content,metadata:{article_type:'tutorial'},html:'<p>private HTML</p>',issues:[{id:'address-'+from,code:'privacy-private-ip',field:'content',severity:'confirm',from,to:from+11}],...overrides};
}
function helper(storage=store(),options={}) {
  assert.equal(typeof createPreflightAcknowledgements,'function','preflight acknowledgement helper is missing');
  return {storage,ack:createPreflightAcknowledgements({storage,subtle:webcrypto.subtle,...options})};
}

test('only explicitly checked current confirmations persist as opaque hashes without article or account values',async()=>{
  const {storage,ack}=helper(),input=context();input.issues.push({id:'unchecked',code:'privacy-username',field:'author',severity:'confirm'},{id:'blocked',code:'image-missing',field:'cover',severity:'blocker'});
  input.metadata.author='private-user';input.metadata.cover='images/private-path.png';
  assert.equal(await ack.remember(input,[input.issues[0].id,'blocked','forged']),true);
  assert.deepEqual(await ack.accepted(input),new Set([input.issues[0].id]));
  const persisted=[...storage.data.values()].join('');
  for(const raw of ['172.25.12.3','private-user','private-path','private HTML','draft-private-local','account-private-local','privacy-private-ip'])assert.ok(!persisted.includes(raw));
  const record=JSON.parse([...storage.data.values()][0]);assert.equal(record.entries.length,1);
  assert.ok(Object.values(record.entries[0]).every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)));
});

test('unrelated edits may move an unchanged decision and return only the new current issue id',async()=>{
  const {ack}=helper(),before=context();await ack.remember(before,[before.issues[0].id]);
  const prefix='A wholly different introductory paragraph.\n\n',issue=before.issues[0];
  const after=context({content:prefix+before.content,fingerprint:'b'.repeat(64),issues:[{...issue,id:'new-position-id',from:issue.from+prefix.length,to:issue.to+prefix.length}]});
  assert.deepEqual(await ack.accepted(after),new Set(['new-position-id']));
});

test('changed exact values surrounding context account renderer and article type each require confirmation again',async()=>{
  const {ack}=helper(),before=context();await ack.remember(before,[before.issues[0].id]);
  for(const changes of [
    {content:before.content.replace('172.25.12.3','172.25.12.4')},
    {content:before.content.replace('172.25.12.3 Right','172.25.12.3 Other')},
    {accountId:'other-account'}, {renderVersion:'render-v2'}, {metadata:{article_type:'benchmark'}},
    {draftId:'other-draft'},
  ])assert.deepEqual(await ack.accepted({...before,...changes,fingerprint:'c'.repeat(64)}),new Set());
});

test('an intentional empty source remains preselected even when source_url is absent but article type changes invalidate it',async()=>{
  const {ack}=helper(),input=context({metadata:{article_type:'tutorial'},issues:[{id:'source-empty',code:'source-empty',field:'source_url',severity:'confirm'}]});
  await ack.remember(input,['source-empty']);
  assert.deepEqual(await ack.accepted({...input,content:'Completely revised original article',metadata:{article_type:'tutorial',source_url:''},fingerprint:'d'.repeat(64)}),new Set(['source-empty']));
  assert.deepEqual(await ack.accepted({...input,metadata:{article_type:'rocm-repost'}}),new Set());
  assert.deepEqual(await ack.accepted({...input,metadata:{article_type:'tutorial',source_url:'https://example.invalid/new'}}),new Set());
});

test('ambiguous identical repeated contexts never spread one confirmation to another occurrence',async()=>{
  const {ack}=helper(),part='1234567890abcdefghijklmnop 10.0.0.1 qrstuvwxyz1234567890abcdefgh';
  const content=part+'\n\n'+part,first=content.indexOf('10.0.0.1'),second=content.lastIndexOf('10.0.0.1');
  const input=context({content,issues:[{id:'first',code:'privacy-private-ip',field:'content',severity:'confirm',from:first,to:first+8},{id:'second',code:'privacy-private-ip',field:'content',severity:'confirm',from:second,to:second+8}]});
  await ack.remember(input,['first']);assert.deepEqual(await ack.accepted(input),new Set());
});

test('no-offset field decisions are exact and a changed term never inherits the old author choice',async()=>{
  const {ack}=helper(),input=context({metadata:{article_type:'tutorial',author:'PyTorch'},issues:[{id:'term',code:'term-review',field:'author',severity:'confirm'}]});
  await ack.remember(input,['term']);assert.deepEqual(await ack.accepted(input),new Set(['term']));
  assert.deepEqual(await ack.accepted({...input,metadata:{article_type:'tutorial',author:'pytorch'}}),new Set());
  assert.deepEqual(await ack.accepted({...input,metadata:{article_type:'tutorial'}}),new Set());
});

test('corrupt records and unavailable quota never preapprove a confirmation that failed to persist',async()=>{
  const storage=store(),{ack}=helper(storage),input=context();await ack.remember(input,[input.issues[0].id]);
  const key=[...storage.data.keys()][0];storage.data.set(key,'{"entries":[{"approved":true}]}');
  assert.deepEqual(await ack.accepted(input),new Set());assert.equal(await ack.remember(input,[input.issues[0].id]),false);
  const failing={getItem:()=>null,setItem(){throw Error('quota includes access_token=private-secret');}};
  const blocked=helper(failing).ack;assert.equal(await blocked.remember(input,[input.issues[0].id]),false);assert.deepEqual(await blocked.accepted(input),new Set());
});

test('invalid fingerprints malformed offsets duplicate issue ids and forged blocker claims fail closed',async()=>{
  const {ack}=helper(),input=context();
  assert.equal(await ack.remember({...input,fingerprint:'old-invalid'},[input.issues[0].id]),false);
  assert.deepEqual(await ack.accepted({...input,fingerprint:''}),new Set());
  for(const issues of [
    [{...input.issues[0],from:-1}], [{...input.issues[0],to:99999}], [{...input.issues[0],from:'10'}],
    [{...input.issues[0],severity:'blocker'}], [{...input.issues[0]},{...input.issues[0],severity:'blocker'}],
  ]) {const changed={...input,issues};await ack.remember(changed,[input.issues[0].id]);assert.deepEqual(await ack.accepted(changed),new Set());}
});

test('512 decisions are bounded without retaining raw content and clearing a draft preserves others',async()=>{
  const {ack,storage}=helper(),issues=Array.from({length:512},(_,i)=>({id:'decision-'+i,code:'review-'+i,field:'source_url',severity:'confirm'}));
  const first=context({issues,metadata:{article_type:'tutorial',source_url:''}});assert.equal(await ack.remember(first,issues.map(issue=>issue.id)),true);
  const other=context({draftId:'another-draft'});assert.equal(await ack.remember(other,[other.issues[0].id]),false);assert.deepEqual(await ack.accepted(other),new Set());
  assert.equal(JSON.parse([...storage.data.values()][0]).entries.length,512);
  await ack.clear(first.draftId);assert.deepEqual(await ack.accepted(first),new Set());assert.equal(await ack.remember(other,[other.issues[0].id]),true);
  await ack.clear(first.draftId);assert.deepEqual(await ack.accepted(other),new Set([other.issues[0].id]));
});

test('missing cryptography or storage fails closed without throwing transport or article details',async()=>{
  const input=context(),missing=helper(null,{subtle:null}).ack;assert.equal(await missing.remember(input,[input.issues[0].id]),false);assert.deepEqual(await missing.accepted(input),new Set());
  const inaccessible=helper({getItem(){throw Error('private user path');},setItem(){throw Error('secret');}}).ack;
  assert.deepEqual(await inaccessible.accepted(input),new Set());assert.equal(await inaccessible.remember(input,[input.issues[0].id]),false);
});
