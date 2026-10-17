import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
test('export removes decorative code/alert SVG without discarding meaningful source graphics',async()=>{
 const {document,window}=parseHTML('<html><head></head><body></body></html>');Object.assign(globalThis,{document,window,self:window,MutationObserver:window.MutationObserver});
 const {stripExportDecorations}=await import('../frontend/renderer-adapter.mjs');
 const html='<pre><span class="mac-sign"><svg><circle/></svg></span><code>int x = 2;\n</code></pre><p class="wx-alert-title"><svg/>Tip</p><figure><svg id="meaningful"><text>Source graph</text></svg></figure>';
 const host=document.createElement('div');host.innerHTML=stripExportDecorations(html,document);
 assert.equal(host.querySelectorAll('svg').length,1);assert.equal(host.querySelector('svg').id,'meaningful');assert.equal(host.querySelector('code').textContent,'int x = 2;\n');assert.equal(host.querySelector('.wx-alert-title').textContent,'Tip');
});
