import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {publishedCodeText} from './published-code-text.mjs';
let preparePublishingPresentation;
try { ({preparePublishingPresentation}=await import('../frontend/publishing-presentation.mjs')); }
catch(error) { if(error.code!=='ERR_MODULE_NOT_FOUND') throw error; }
const {document}=parseHTML('<html><body></body></html>');
function render(html,options={}) {
  assert.equal(typeof preparePublishingPresentation,'function','publishing presentation is available');
  const root=document.createElement('div');
  root.innerHTML=preparePublishingPresentation(html,{document,linkColor:'#0051c6',...options});
  return root;
}
test('code sizes stay 14px in blocks and 12px inline even with authored or table styles',()=>{
  const root=render('<p style="font-size:18px">参数 <code style="font-size:24px!important"><b style="font-size:28px">batch_size</b></code></p><table><tr><td style="font-size:16px"><pre style="font-size:30px!important"><code><span style="font-size:22px">if True:\n\tprint("x")</span></code></pre></td></tr></table><div class="wx-code-caption" style="font-size:16px">Python</div>',{codeFontSize:14});
  for(const node of root.querySelectorAll('pre,pre *')) assert.equal(node.style.getPropertyValue('font-size'),node.hasAttribute('data-wx-code-line-number')?'10px':'14px');
  for(const node of root.querySelectorAll('p code,p code *,.wx-code-caption')) assert.equal(node.style.getPropertyValue('font-size'),'12px');
  assert.equal(publishedCodeText(root.querySelector('pre code')),'if True:\n\tprint("x")');
  assert.equal(root.querySelector('p').style.getPropertyValue('font-size'),'18px');
});
test('external links become colored underlined copyable text without losing formatted labels',()=>{
  const root=render('<p><a href="https://example.com/docs?q=a&amp;b=2"><strong>官方</strong> <code>API</code></a> <a href="https://example.com/">https://example.com/</a></p>');
  assert.equal(root.querySelectorAll('a[href]').length,0);
  const links=root.querySelectorAll('.wx-external-link');
  assert.equal(links[0].textContent,'官方 API[1]');
  assert.equal(links[0].style.getPropertyValue('color'),'#0051c6');
  assert.equal(links[0].style.getPropertyValue('text-decoration'),'underline');
  assert.ok(links[0].querySelector('strong'));
  assert.equal(links[0].querySelector('code').style.getPropertyValue('font-size'),'12px');
  assert.equal(links[1].textContent,'example.com[2]');
  assert.equal(root.querySelector('[data-wx-reference-url]').textContent,'https://example.com/docs?q=a&b=2');
});
test('internal references, images and literal link examples inside code are preserved',()=>{
  const root=render('<a href="#note-1">注1</a><a href="//example.com/image"><img src="image.png" alt="示意图"></a><pre><code>&lt;a href="https://example.com"&gt;demo&lt;/a&gt;</code></pre>');
  assert.equal(root.querySelector('a[href]').getAttribute('href'),'#note-1');
  assert.equal(root.querySelectorAll('a[href]').length,1);
  assert.equal(root.querySelector('img').getAttribute('src'),'image.png');
  assert.equal(publishedCodeText(root.querySelector('pre code')),'<a href="https://example.com">demo</a>');
  assert.equal(root.querySelector('.wx-external-link').textContent,'示意图[1]');
});
test('presentation is idempotent and cannot turn URL text into markup',()=>{
  const input='<a href="https://example.com/?q=&quot;&gt;&lt;img%20src=x&gt;">来源</a>';
  const root=render(input), html=root.innerHTML;
  assert.equal(render(html).innerHTML,html);
  assert.equal(root.querySelectorAll('img,script,a[href]').length,0);
  assert.ok(root.textContent.includes('<img%20src=x>'));
});
