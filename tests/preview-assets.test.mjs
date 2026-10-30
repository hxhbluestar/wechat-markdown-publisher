import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {resolvePreviewAssets} from '../frontend/preview-assets.mjs';
import {preparePublishingPresentation} from '../frontend/publishing-presentation.mjs';
const {document}=parseHTML('<html><body></body></html>');
const id='draft-20000101-12345678';
const assets=[{path:'assets/中文 图片.png',kind:'image'},{path:'assets/demo.mp4',kind:'video'},{path:'assets/说明.md',kind:'attachment'}];
test('folder assets keep working names, videos get controls and passive links remain downloadable',()=>{
 const html='<img src="assets/%E4%B8%AD%E6%96%87%20%E5%9B%BE%E7%89%87.png"><img src="assets/demo.mp4" alt="演示"><a href="assets/说明.md">来源说明</a><video autoplay src="assets/demo.mp4"></video>';
 const root=document.createElement('div');root.innerHTML=resolvePreviewAssets(html,{document,draftId:id,assets});
 assert.match(root.querySelector('img').getAttribute('src'),/assets\/assets\/%E4%B8%AD%E6%96%87%20%E5%9B%BE%E7%89%87.png$/);
 assert.equal(root.querySelectorAll('video').length,2);
 assert.ok([...root.querySelectorAll('video')].every(e=>e.hasAttribute('controls')&&!e.hasAttribute('autoplay')));
 assert.match(root.querySelector('a').getAttribute('href'),/assets\/assets\/%E8%AF%B4%E6%98%8E.md$/);
 assert.equal(root.querySelector('a').textContent,'来源说明');
});
test('legacy image locations and remote images still resolve without mutating source',()=>{
 const root=document.createElement('div');root.innerHTML=resolvePreviewAssets('<img src="assets/old.png"><img src="https://example.com/a.png">',{document,draftId:id,assets:[{path:'images/assets/old.png'}]});
 assert.match(root.querySelector('img').getAttribute('src'),/assets\/images\/assets\/old.png$/);
 assert.equal(root.querySelectorAll('img')[1].getAttribute('src'),'https://example.com/a.png');
});
test('local attachments do not turn into misleading external references',()=>{
 const root=document.createElement('div');root.innerHTML=preparePublishingPresentation('<p><a href="assets/说明.md">附件</a>，<a href="https://example.com/doc">官方资料</a></p>',{document});
 assert.equal(root.querySelector('a').getAttribute('href'),'assets/说明.md');
 assert.equal(root.querySelectorAll('[data-wx-reference-url]').length,1);
 assert.equal(root.querySelector('[data-wx-reference-url]').textContent,'https://example.com/doc');
});
test('query and fragment suffixes do not become filename characters, while escaped hashes do',()=>{
 const root=document.createElement('div');root.innerHTML=resolvePreviewAssets('<img src="assets/a.png?v=1#figure"><img src="assets/a%23b.png"><a href="assets/report.pdf#page=2">报告</a>',{document,draftId:id,assets:[]});
 assert.match(root.querySelector('img').getAttribute('src'),/\/assets\/assets\/a.png#figure$/);
 assert.match(root.querySelectorAll('img')[1].getAttribute('src'),/\/assets\/assets\/a%23b.png$/);
 assert.match(root.querySelector('a').getAttribute('href'),/\/assets\/assets\/report.pdf#page=2$/);
});
