import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

const root = new URL('../', import.meta.url);
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
