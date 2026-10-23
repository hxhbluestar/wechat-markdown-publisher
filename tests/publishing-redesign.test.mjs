import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {preparePublishingPresentation} from '../frontend/publishing-presentation.mjs';
import {prepareTypography,normalizeTypography} from '../frontend/typography.mjs';
import {publishedCodeText} from './published-code-text.mjs';
const {document}=parseHTML('<html><body></body></html>');
const render=(html,options={})=>{
  const root=document.createElement('div');
  root.innerHTML=preparePublishingPresentation(html,{document,linkColor:'#0051c6',...options});
  return root;
};
test('publishing code font honors 12 and 14, rejects other sizes and defaults to 12',()=>{
  for(const [input,expected] of [[undefined,12],[12,12],['14',14],[14,14],[18,12],[true,12],['12px',12]]) {
    const root=render('<pre><code><span style="font-size:28px!important">print(1)</span></code></pre>',{codeFontSize:input});
    for(const element of root.querySelectorAll('pre,pre *')) assert.equal(element.style.getPropertyValue('font-size'),(element.hasAttribute('data-wx-code-line-number')?10:expected)+'px');
  }
  assert.equal(normalizeTypography({}).code_font_size,12);
  assert.equal(normalizeTypography({code_font_size:'14'}).code_font_size,14);
  assert.equal(normalizeTypography({}).code_wrap,'wrap');
  assert.equal(normalizeTypography({code_wrap:'scroll'}).code_wrap,'scroll');
});
test('named external links keep concise inline labels and deduplicated full URLs at the end',()=>{
  const url='https://github.com/ROCm/aiter/blob/main/.github/scripts/op_tune.sh';
  const root=render(`<section class="wx-typography"><p>参考 <a href="${url}"><strong>官方调优脚本</strong></a>，另见 <a href="${url}">脚本源码</a>。</p></section>`);
  const paragraph=root.querySelector('p');
  assert.equal(paragraph.textContent,'参考 官方调优脚本[1]，另见 脚本源码[1]。');
  assert.equal(paragraph.querySelector('.wx-external-link').style.getPropertyValue('text-decoration'),'underline');
  const references=root.querySelector('[data-wx-link-references]');
  assert.equal(references.querySelectorAll('[data-wx-reference-url]').length,1);
  assert.equal(references.querySelector('[data-wx-reference-url]').textContent,url);
  assert.equal(root.querySelectorAll('a[href]').length,0);
  assert.equal(render(root.innerHTML).innerHTML,root.innerHTML);
});
test('bare URL and imported label-URL shorthand stay compact; image and code content survive',()=>{
  const root=render('<p>[项目说明]<a href="https://github.com/ROCm/aiter/blob/main/README.md">https://github.com/ROCm/aiter/blob/main/README.md</a>，<a href="https://example.com/very/long?q=1">https://example.com/very/long?q=1</a></p><p><a href="https://example.com/image"><img src="local.png" alt="架构图"></a></p><a href="#note">注释</a><pre><code>https://example.com/a</code></pre>');
  assert.equal(root.querySelector('p').textContent,'项目说明[1]，example.com[2]');
  assert.equal(root.querySelector('img').getAttribute('src'),'local.png');
  assert.equal(publishedCodeText(root.querySelector('pre code')),'https://example.com/a');
  assert.equal(root.querySelector('a').getAttribute('href'),'#note');
});
test('compacting a linked bare URL never removes linked media',()=>{
  const root=render('<p><a href="https://example.com"><img src="diagram.png" alt="Architecture">https://example.com</a></p>');
  assert.equal(root.querySelector('img')?.getAttribute('src'),'diagram.png');
  assert.equal(root.querySelector('p').textContent,'example.com[1]');
});
test('repairing imported link shorthand preserves linked media too',()=>{
  const root=render('<p>[项目说明]<a href="https://example.com"><img src="diagram.png">https://example.com</a></p>');
  assert.equal(root.querySelector('img')?.getAttribute('src'),'diagram.png');
  assert.equal(root.querySelector('p').textContent,'项目说明[1]');
});
test('plain imported name-URL text and bare URLs become compact references outside code',()=>{
  const root=render('<section class="wx-typography"><p>参考[项目说明]https://github.com/ROCm/aiter/blob/main/README.md、[调优脚本]https://github.com/ROCm/aiter/blob/main/.github/scripts/op_tune.sh。裸网址 https://example.com/docs.</p><pre><code>curl https://example.com/code</code></pre><p><code>https://example.com/inline</code></p></section>');
  assert.equal(root.querySelector('p').textContent,'参考项目说明[1]、调优脚本[2]。裸网址 example.com[3].');
  assert.equal(root.querySelectorAll('[data-wx-reference-url]').length,3);
  assert.equal(publishedCodeText(root.querySelector('pre code')),'curl https://example.com/code');
  assert.equal(root.querySelector('p code').textContent,'https://example.com/inline');
  assert.equal(render(root.innerHTML).innerHTML,root.innerHTML);
});
test('diagram and math URL labels are preserved without injecting HTML references',()=>{
  const root=render('<svg><text>https://example.com/api</text></svg><math><mtext>https://example.com/formula</mtext></math>');
  assert.equal(root.querySelector('svg text').textContent,'https://example.com/api');
  assert.equal(root.querySelector('math mtext').textContent,'https://example.com/formula');
  assert.equal(root.querySelectorAll('sup,[data-wx-link-references]').length,0);
});
test('plain URL recognition preserves enclosing punctuation and valid URL brackets',()=>{
  const root=render('<p>[https://example.com/docs] (https://example.com/wiki/Func_(x)) https://[::1]/guide</p>');
  assert.equal(root.querySelector('p').textContent,'[example.com[1]] (example.com[2]) [::1][3]');
  assert.deepEqual([...root.querySelectorAll('[data-wx-reference-url]')].map(e=>e.textContent),['https://example.com/docs','https://example.com/wiki/Func_(x)','https://[::1]/guide']);
});
test('language header is a section and code body independently carries its separator in all themes',()=>{
  for(const theme of ['technical','journal','minimal','obsidian','deepsea','teal','grace','default','simple']) {
    const result=prepareTypography('<pre><code class="language-bash">echo x\n  echo y</code></pre>',{theme,code_font_size:12},document,null);
    const root=document.createElement('div');root.innerHTML=result.html;
    assert.equal(root.querySelector('.wx-code-caption')?.tagName,'SECTION',theme);
    assert.equal(root.querySelector('.wx-code-caption').textContent,'Bash',theme);
    assert.match(result.css,/\.wx-code-pre[^{}]*\{[^{}]*border-top:\s*1px solid/,theme);
    assert.equal(root.querySelector('code').textContent,'echo x\n  echo y');
  }
});
