import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { assetToolsMarkup, connectAssetTools, rewriteImageSources, listImageCaptions, applyCaptionEdits } from '../frontend/asset-tools.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const event = (doc, node, type = 'click') => node.dispatchEvent(new doc.defaultView.Event(type, { bubbles: true }));

test('image rewrites protect ordinary links, fenced/inline code and HTML comments', () => {
  const source = '![图](images/a.png "保留标题")\n[普通链接](images/a.png)\n`![示例](images/a.png)`\n```md\n![代码](images/a.png)\n```\n<!-- ![注释](images/a.png) -->\n<img src="images/a.png" alt="图">';
  const result = rewriteImageSources(source, 'images/a.png', 'images/derived.png');
  assert.ok(result.startsWith('![图](images/derived.png "保留标题")'));
  assert.ok(result.includes('[普通链接](images/a.png)'));
  assert.ok(result.includes('`![示例](images/a.png)`'));
  assert.ok(result.includes('```md\n![代码](images/a.png)\n```'));
  assert.ok(result.includes('<!-- ![注释](images/a.png) -->'));
  assert.ok(result.includes('<img src="images/derived.png" alt="图">'));
});

test('reference-image rewrites leave shared hyperlink definitions intact', () => {
  const source = '![图][shared]\n[普通链接][shared]\n[shared]: <images/a.png> "引用标题"\n![图2][]\n[图2]: images/a.png';
  const result = rewriteImageSources(source, 'images/a.png', 'images/new file.png');
  assert.ok(result.includes('![图](images/new%20file.png "引用标题")'));
  assert.ok(result.includes('[普通链接][shared]\n[shared]: <images/a.png> "引用标题"'));
  assert.ok(result.includes('![图2](images/new%20file.png)'));
});

test('same-draft local aliases normalize but remote replacements match the exact image URL', () => {
  const source = '![a](./images/a.png)\n![b](/api/editor/drafts/draft-one/assets/images/a.png)\n![r](https://example.org/a.png?x=1)\n![r2](https://example.org/a.png?x=2)';
  const local = rewriteImageSources(source, 'images/a.png', 'images/local.png', { draftId: 'draft-one' });
  assert.equal(local.match(/images\/local\.png/g).length, 2);
  const remote = rewriteImageSources(source, 'https://example.org/a.png?x=1', 'images/download.png');
  assert.ok(remote.includes('![r](images/download.png)'));
  assert.ok(remote.includes('![r2](https://example.org/a.png?x=2)'));
  assert.throws(() => rewriteImageSources(source, 'images/a.png', 'javascript:alert(1)'), /asset|path/i);
});

test('caption batch edit handles Markdown and HTML/reference images without inventing markup', () => {
  const source = '![旧图](images/a.png)\n![引用][ref]\n[ref]: images/b.png\n<img alt="旧 &amp; 图" src="images/c.png">\n<img src="images/d.png">\n```md\n![代码](images/keep.png)\n```';
  const listed = listImageCaptions(source);
  assert.deepEqual(listed.map(item => item.caption), ['旧图', '引用', '旧 & 图', '']);
  const edited = applyCaptionEdits(source, ['新 [图] <b>', '引用新标题', 'HTML "quote" & <text>', '补充图注']);
  assert.ok(edited.includes('![新 \\[图\\] \\<b\\>](images/a.png)'));
  assert.ok(edited.includes('![引用新标题][ref]\n[ref]: images/b.png'));
  assert.ok(edited.includes('alt="HTML &quot;quote&quot; &amp; &lt;text&gt;"'));
  assert.ok(edited.includes('<img src="images/d.png" alt="补充图注">'));
  assert.ok(edited.includes('```md\n![代码](images/keep.png)\n```'));
  assert.throws(() => applyCaptionEdits(source, ['too few']), /caption|count/i);
});

function harness({ request } = {}) {
  const { document } = parseHTML('<html><body>' + assetToolsMarkup() + '</body></html>');
  for (const dialog of document.querySelectorAll('dialog')) { dialog.showModal = () => dialog.setAttribute('open', ''); dialog.close = () => dialog.removeAttribute('open'); }
  const draft = { id: 'draft-one', content: '![原图](images/a.png)\n```md\n![例子](images/a.png)\n```', metadata: { cover: 'images/a.png' } };
  const inventory = [{ path: 'images/a.png', size: 2048, sha256: 'a'.repeat(64), width: 640, height: 480, format: 'PNG', frames: 1, reference_count: 1, captions: ['原图'] }];
  const calls = [], changes = [], snapshots = [], messages = [];
  const a = {
    request: async (url, options) => { calls.push({ url, options }); return request ? request(url, options) : options?.method === 'POST' ? { asset: { path: 'images/derived.png', size: 1024, width: 470, height: 200, format: 'PNG', frames: 1 }, derivation: { source_path: 'images/a.png', source_hash: 'a'.repeat(64), crop_box: [10, 20, 630, 280], safe_area: { normalized: [.1, .1, .9, .9] } } } : { items: inventory }; },
    getDraft: () => draft, getContent: () => draft.content, getMetadata: () => draft.metadata,
    beforeChange: async reason => { snapshots.push(reason); },
    replaceContent: async (next, expected, id) => { if (id !== draft.id || expected !== draft.content) return false; changes.push({ next, expected, id }); draft.content = next; return true; },
    applyMetadata: async patch => { draft.metadata = { ...draft.metadata, ...patch }; },
    onChanged: async () => {}, assetUrl: (path, id) => `/api/editor/drafts/${id}/assets/${path}`,
    toast: text => messages.push(text),
  };
  const ui = connectAssetTools(document, a);
  const click = async selector => { event(document, document.querySelector(selector)); await tick(); await tick(); };
  return { document, draft, inventory, calls, changes, snapshots, messages, a, ui, click };
}

test('asset inventory safely shows dimensions, frames, references, duplicates and provenance', async () => {
  const h = harness();
  h.inventory[0].path = 'images/<script>alert(1)</script>.png';
  h.inventory[0].duplicate_of = 'images/original.png';
  h.inventory[0].derivation = { source_path: 'images/source.png', source_hash: 'b'.repeat(64) };
  await h.ui.open();
  const text = h.document.querySelector('#assetToolsList').textContent;
  assert.match(text, /640.*480/);
  assert.match(text, /2048/);
  assert.match(text, /引用.*1/);
  assert.match(text, /重复/);
  assert.match(text, /images\/source.png/);
  assert.equal(h.document.querySelectorAll('#assetToolsList script').length, 0);
  assert.equal(h.document.querySelectorAll('#assetToolsList img').length, 0);
  h.ui.destroy();
});

test('derivation creates an explicit preview and never changes body or cover until author applies', async () => {
  const h = harness();
  await h.ui.open();
  const before = h.draft.content;
  await h.click('[data-asset-select]');
  await h.click('#assetDerive');
  assert.equal(h.draft.content, before);
  assert.equal(h.draft.metadata.cover, 'images/a.png');
  assert.equal(h.snapshots.length, 0);
  assert.equal(h.document.querySelector('#assetApplyReferences').disabled, false);
  assert.ok(h.document.querySelector('#assetToolsPreview img').getAttribute('src').endsWith('images/derived.png'));
  assert.match(h.document.querySelector('#assetToolsPreview').textContent, /470.*200/);
  assert.match(h.document.querySelector('#assetToolsPreview').textContent, /安全区|构图/);
  await h.click('#assetApplyReferences');
  assert.ok(h.draft.content.startsWith('![原图](images/derived.png)'));
  assert.ok(h.draft.content.includes('```md\n![例子](images/a.png)\n```'));
  assert.equal(h.snapshots.length, 1);
  h.ui.destroy();
});

test('failed transformation preserves source and never enables application', async () => {
  const h = harness({ request: async (_, options) => { if (options?.method === 'POST') throw new Error('synthetic failure'); return { items: [{ path: 'images/a.png', size: 50 }] }; } });
  await h.ui.open(); await h.click('[data-asset-select]');
  const before = h.draft.content;
  await h.click('#assetDerive');
  assert.equal(h.draft.content, before);
  assert.equal(h.document.querySelector('#assetApplyReferences').disabled, true);
  assert.equal(h.snapshots.length, 0);
  h.ui.destroy();
});

test('body application checks original source again after asynchronous snapshot completion', async () => {
  const h = harness();
  await h.ui.open(); await h.click('[data-asset-select]'); await h.click('#assetDerive');
  let release;
  h.a.beforeChange = () => new Promise(resolve => { release = resolve; });
  event(h.document, h.document.querySelector('#assetApplyReferences'));
  await tick();
  h.draft.content += '\n作者正在继续编辑';
  release(); await tick(); await tick();
  assert.equal(h.changes.length, 0);
  assert.ok(h.draft.content.endsWith('作者正在继续编辑'));
  h.ui.destroy();
});

test('cover application patches only cover after preview and respects draft switching', async () => {
  const h = harness();
  await h.ui.open(); await h.click('[data-asset-select]'); await h.click('#assetDerive');
  h.draft.metadata.author = '合成作者';
  await h.click('#assetUseCover');
  assert.equal(h.draft.metadata.cover, 'images/derived.png');
  assert.equal(h.draft.metadata.author, '合成作者');
  h.draft.id = 'draft-two';
  await h.click('#assetApplyReferences');
  assert.equal(h.changes.length, 0);
  h.ui.destroy();
});

test('one reviewed derivative may be applied to the body and then selected as cover', async () => {
  const h = harness(); await h.ui.open(); await h.click('[data-asset-select]'); await h.click('#assetDerive');
  await h.click('#assetApplyReferences'); await h.click('#assetUseCover');
  assert.equal(h.draft.metadata.cover, 'images/derived.png');
  assert.equal(h.snapshots.length, 2);
  h.ui.destroy();
});

test('switching drafts invalidates the old asset inventory before any transformation request', async () => {
  const h = harness(); await h.ui.open(); await h.click('[data-asset-select]');
  h.draft.id = 'draft-two';
  await h.click('#assetDerive');
  assert.equal(h.calls.filter(call => call.options?.method === 'POST').length, 0);
  assert.equal(h.document.querySelector('#assetApplyReferences').disabled, true);
  h.ui.destroy();
});

test('an explicitly rejected snapshot boundary never applies a staged change', async () => {
  const h = harness(); await h.ui.open(); await h.click('[data-asset-select]'); await h.click('#assetDerive');
  h.a.beforeChange = async () => false;
  await h.click('#assetApplyReferences');
  assert.equal(h.changes.length, 0);
  assert.equal(h.draft.metadata.cover, 'images/a.png');
  await h.click('#assetUseCover');
  assert.equal(h.draft.metadata.cover, 'images/a.png');
  h.ui.destroy();
});

test('remote images are downloaded only through the guarded API and require explicit replacement', async () => {
  const h = harness();
  h.draft.content = '![网络](https://example.org/synthetic.png)';
  await h.ui.open();
  h.document.querySelector('#assetRemoteUrl').value = 'https://example.org/synthetic.png';
  await h.click('#assetDownloadRemote');
  const call = h.calls.find(item => item.url.endsWith('/assets/download-remote'));
  assert.deepEqual(JSON.parse(call.options.body), { url: 'https://example.org/synthetic.png' });
  assert.equal(h.draft.content, '![网络](https://example.org/synthetic.png)');
  await h.click('#assetApplyReferences');
  assert.equal(h.draft.content, '![网络](images/derived.png)');
  assert.ok(h.calls.every(call => call.url.startsWith('/api/editor/')));
  h.ui.destroy();
});

test('caption batch edits require a preview and reject stale article input', async () => {
  const h = harness();
  await h.ui.open();
  const field = h.document.querySelector('#assetCaptionList');
  field.value = '新的 [图注]'; event(h.document, field, 'input');
  assert.equal(h.document.querySelector('#assetApplyCaptions').disabled, true);
  await h.click('#assetPreviewCaptions');
  assert.equal(h.document.querySelector('#assetApplyCaptions').disabled, false);
  assert.equal(h.changes.length, 0);
  h.draft.content += '\n新增正文';
  await h.click('#assetApplyCaptions');
  assert.equal(h.changes.length, 0);
  assert.ok(h.draft.content.includes('![原图](images/a.png)'));
  h.ui.destroy();
});

test('successful caption batch edits snapshot once and treat entered captions as text', async () => {
  const h = harness(); await h.ui.open();
  const field = h.document.querySelector('#assetCaptionList');
  field.value = '<img src=x onerror=bad()> [正文]'; event(h.document, field, 'input');
  await h.click('#assetPreviewCaptions');
  assert.equal(h.document.querySelectorAll('#assetCaptionPreview img').length, 0);
  await h.click('#assetApplyCaptions');
  assert.equal(h.snapshots.length, 1);
  assert.equal(h.changes.length, 1);
  assert.ok(h.draft.content.includes('\\<img src=x onerror=bad()\\> \\[正文\\]'));
  h.ui.destroy();
});

test('destroy removes controls and late inventory responses cannot replace a different draft', async () => {
  let resolve;
  const h = harness({ request: () => new Promise(done => { resolve = done; }) });
  const opening = h.ui.open(); await tick();
  h.draft.id = 'draft-two'; resolve({ items: [{ path: 'images/stale.png' }] });
  await opening;
  assert.equal(h.document.querySelector('#assetToolsList').textContent.includes('stale.png'), false);
  h.ui.destroy();
  h.document.querySelector('#assetToolsDialog').close();
  await h.click('#openAssetTools');
  assert.equal(h.document.querySelector('#assetToolsDialog').hasAttribute('open'), false);
});
