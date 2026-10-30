import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalAssetPath, imageUploadTarget, missingImagePaths } from '../frontend/asset-paths.mjs';

test('imported local image directories map into the draft image directory', () => {
  assert.equal(canonicalAssetPath('pub/event.jpg'), 'images/pub/event.jpg');
  assert.equal(canonicalAssetPath('imported-assets/节点.png'), 'images/imported-assets/节点.png');
  assert.equal(canonicalAssetPath('./pub/a%20b.jpg'), 'images/pub/a b.jpg');
});

test('existing draft image paths, covers and remote URLs remain usable', () => {
  for (const path of ['images/a.png', 'cover.jpg', 'https://example.com/a.png']) {
    assert.equal(canonicalAssetPath(path), path);
  }
});

test('folder assets preserve their directory, nested paths and decoded Unicode names', () => {
  assert.equal(canonicalAssetPath('./assets/图%20一.png'), 'assets/图 一.png');
  assert.equal(canonicalAssetPath('assets/nested/a.png'), 'assets/nested/a.png');
  assert.equal(canonicalAssetPath('./assets/片段%20一.mp4'), 'assets/片段 一.mp4');
  assert.equal(canonicalAssetPath('assets/图片来源说明.md'), 'assets/图片来源说明.md');
});

test('known assets resolve old images/assets storage without overriding a real folder asset', () => {
  const legacy = [{path:'images/assets/旧 图.png'}];
  assert.equal(canonicalAssetPath('assets/旧%20图.png', '', legacy), 'images/assets/旧 图.png');
  assert.equal(canonicalAssetPath('assets/旧 图.png', '', [...legacy,{path:'assets/旧 图.png'}]), 'assets/旧 图.png');
  assert.equal(canonicalAssetPath('assets/旧 图.png', '', new Set(['images/assets/旧 图.png'])), 'images/assets/旧 图.png');
  assert.deepEqual(missingImagePaths(['assets/旧 图.png'], legacy), []);
});

test('uploads repair folder images and legacy backing paths but reject non-image filenames', () => {
  assert.deepEqual(imageUploadTarget('图.png', ['assets/图.png']), {path:'assets/图.png',insert:false});
  assert.deepEqual(imageUploadTarget('图.png', ['assets/图.png'], '', [{path:'images/assets/图.png'}]), {path:'images/assets/图.png',insert:false});
  assert.throws(() => imageUploadTarget('clip.mp4', ['assets/clip.mp4']), /图片|image/i);
});

test('unsafe sources never map to an accessible draft path', () => {
  for (const path of ['../private/a.png', '%2e%2e/private/a.png', '/outside/a.png', 'C:\\outside\\a.png', 'images/a.png:secret']) {
    assert.equal(canonicalAssetPath(path), path);
  }
});

test('upload repairs an existing imported image reference without inserting another image', () => {
  assert.deepEqual(imageUploadTarget('event.jpg', ['pub/event.jpg', 'images/other.png']), {
    path: 'images/pub/event.jpg', insert: false,
  });
});

test('a new image is stored normally and inserted into the article', () => {
  assert.deepEqual(imageUploadTarget('new.png', ['images/old.png']), { path: 'images/new.png', insert: true });
});

test('ambiguous same-name references require explicit resolution before upload', () => {
  assert.throws(() => imageUploadTarget('event.jpg', ['pub/event.jpg', 'assets/event.jpg']), /同名/);
});

test('preflight recognizes legacy references backed by canonical draft assets', () => {
  assert.deepEqual(missingImagePaths(['pub/event.jpg', 'imported-assets/节点.png'], [{ path: 'images/pub/event.jpg' }]), ['images/imported-assets/节点.png']);
});

test('same-draft API image aliases pass preflight while other drafts remain inaccessible', () => {
  const draftId = 'draft-20000101-12345678';
  const local = `/api/editor/drafts/${draftId}/assets/images/a.png`;
  const foreign = '/api/editor/drafts/draft-20000101-87654321/assets/images/a.png';
  assert.equal(canonicalAssetPath(local, draftId), 'images/a.png');
  assert.equal(canonicalAssetPath(foreign, draftId), foreign);
  assert.deepEqual(missingImagePaths([local], [{ path: 'images/a.png' }], draftId), []);
  assert.deepEqual(missingImagePaths([foreign], [{ path: 'images/a.png' }], draftId), [foreign]);
});
