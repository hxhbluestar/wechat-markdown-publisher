import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {parseHTML} from 'linkedom';

const root = new URL('../', import.meta.url);

test('built page versions every executable and stylesheet by its file contents and keeps import map identity', () => {
  const result=spawnSync(process.execPath,['tools/build-frontend.mjs'],{cwd:root,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const {document}=parseHTML(readFileSync(new URL('app/web/editor/index.html',root),'utf8'));
  const nodes=[...document.querySelectorAll('script[src],link[rel="stylesheet"]')];
  for(const node of nodes){
    const url=new URL(node.getAttribute('src')||node.getAttribute('href'),'http://publisher.test');
    const bytes=readFileSync(new URL('app/web'+url.pathname,root));
    const digest=createHash('sha256').update(bytes).digest('hex').slice(0,16);
    assert.equal(url.searchParams.get('v'),digest,'Cache identity follows actual bytes: '+url.pathname);
  }
  const entry=document.querySelector('script[type="module"][crossorigin]').getAttribute('src');
  const mapping=JSON.parse(document.querySelector('script[type="importmap"]').textContent);
  assert.equal(mapping.imports['/editor/assets/index-CIPbZpsp.js'],entry,'Legacy imports share the exact versioned app instance');
});
test('application builds from readable sources without patching the legacy bundle', () => {
  assert.ok(existsSync(new URL('frontend/editor-app.mjs', root)), 'readable application entry');
  const builder = readFileSync(new URL('tools/build_frontend.py', root), 'utf8');
  assert.doesNotMatch(builder, /source\.replace\(before|Expected exactly one frontend match/);
  assert.match(builder, /build-frontend\.mjs/);
});

test('repeated frontend builds produce identical executable assets', () => {
  const build = () => {
    const result = spawnSync(process.execPath, ['tools/build-frontend.mjs'], {cwd: root, encoding:'utf8'});
    assert.equal(result.status, 0, result.stderr);
    const source = readFileSync(new URL('app/web/editor/assets/index-20261017-scroll.js',root));
    assert.ok(source.length > 20000, 'application and pinned engine are present');
    return createHash('sha256').update(source).digest('hex');
  };
  assert.equal(build(), build());
});

test('built text resources use canonical LF bytes before their cache identities are generated', () => {
  for (const filename of ['workflow-ui-20261018.css','proofreading-20261017-scroll.mjs','typography-20261017-scroll.mjs']) {
    const content = readFileSync(new URL('app/web/editor/assets/'+filename,root),'utf8');
    assert.equal(content.includes('\r\n'),false,'Git and local build must hash the same text bytes: '+filename);
  }
});
