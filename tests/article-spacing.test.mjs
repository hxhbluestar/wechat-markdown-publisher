import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {prepareTypography} from '../frontend/typography.mjs';
const {document}=parseHTML('<html><body></body></html>');
function render(html,theme='technical') {
  const result=prepareTypography(html,{theme},document);
  const root=document.createElement('div');root.innerHTML=result.html;return {...result,root};
}
test('paragraph, heading, image and caption gaps have one owner without margin collapse',()=>{
  const {root,css}=render('<section class="container"><p>第一段</p><h2>两行标题</h2><p>标题后</p><figure><img src="a.png" alt="架构示意"><figcaption><p>图注</p></figcaption></figure><p>图片后</p></section>');
  const blocks=[...root.querySelector('.container').children];
  assert.ok(blocks.every(n=>n.classList.contains('wx-flow-block')));
  assert.deepEqual(blocks.map(n=>/wx-flow-gap-(\d+)/.exec(n.className)[1]),['0','28','12','20','20']);
  assert.match(css,/padding-top: 28px/);
  assert.match(css,/line-height: 1\.8/);
  assert.equal(root.querySelector('figcaption').textContent,'图注');
});
test('imported spacer paragraphs and inline vertical styles do not accumulate around a figure',()=>{
  const {root}=render('<p>前文</p><p><br></p><figure style="margin:80px 0"><p style="margin-bottom:40px"><img src="a.png"></p><figcaption style="margin:50px"><p style="padding:24px">说明</p></figcaption></figure><p>后文</p>');
  assert.equal(root.querySelectorAll('.wx-flow-block').length,3);
  assert.ok(!root.querySelector('figure').style.getPropertyValue('margin'));
  assert.ok(!root.querySelector('figcaption').style.getPropertyValue('margin'));
  assert.ok(!root.querySelector('figcaption p').style.getPropertyValue('padding'));
});
test('spacing normalization preserves code, nested content and is idempotent',()=>{
  const html='<p>说明<br>手动换行</p><blockquote><p>引用</p></blockquote><pre><code>\t&lt;tag&gt; &amp; value\n\n</code></pre><table><tr><td>单元格</td></tr></table>';
  const first=render(html),second=render(first.html);
  assert.equal(first.root.querySelector('pre code').textContent,'\t<tag> & value\n\n');
  assert.equal(second.root.querySelectorAll('.wx-flow-block').length,first.root.querySelectorAll('.wx-flow-block').length);
  assert.equal(first.root.querySelectorAll('blockquote .wx-flow-block,td .wx-flow-block').length,0);
  assert.ok(first.root.querySelector('p br'));
});
test('legacy default rendering stays unchanged by the new flow system',()=>{
  const html='<p style="margin:30px">原稿</p><figure><img src="a.png"></figure>';
  for(const theme of ['grace','default','simple'])assert.equal(render(html,theme).html,html);
});
