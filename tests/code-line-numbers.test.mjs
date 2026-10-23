import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {preparePublishingPresentation,preserveWechatCodeLayout} from '../frontend/publishing-presentation.mjs';
const {document}=parseHTML('<html><body></body></html>');
const read=node=>node.nodeType===3?node.nodeValue:node.hasAttribute?.('data-wx-code-line-number')?'':node.tagName==='BR'?'\n':[...node.childNodes].map(read).join('');
function render(html,options={}) {
  const root=document.createElement('div');root.innerHTML=preparePublishingPresentation(html,{document,...options});return root;
}

test('multi-digit gutters use a smaller font and cannot inherit code wrapping',()=>{
  for(const count of [10,100,1000]) for(const size of [12,14]) {
    const source=Array.from({length:count},(_,i)=>`echo ${i+1}`).join('\n');
    const root=render(`<pre><code class="language-bash">${source}</code></pre>`,{codeFontSize:size});
    const numbers=[...root.querySelectorAll('[data-wx-code-line-number]')];
    assert.equal(numbers.at(-1).textContent,String(count));
    assert.equal(read(root.querySelector('code')),source);
    for(const number of numbers) {
      assert.equal(number.style.getPropertyValue('font-size'),'10px');
      assert.equal(number.style.getPropertyValue('white-space'),'nowrap');
      assert.equal(number.style.getPropertyValue('overflow-wrap'),'normal');
      assert.equal(number.style.getPropertyValue('word-break'),'keep-all');
      assert.match(number.style.width,/^\d+px$/);
    }
    assert.equal(render(root.innerHTML,{codeFontSize:size}).innerHTML,root.innerHTML);
    root.innerHTML=preserveWechatCodeLayout(root.innerHTML,document);
    assert.equal(read(root.querySelector('code')),source);
    assert.equal(preserveWechatCodeLayout(root.innerHTML,document),root.innerHTML);
  }
});
test('every logical code line gets one number including empty lines, preserving source and highlighting',()=>{
  const source='def run():\n\tprint("x")\n\n    return 2\n';
  const root=render('<pre><code><span class="hljs-keyword" style="color:#7441a8">def</span> run():\n\tprint("x")\n\n    return 2\n</code></pre>');
  assert.deepEqual([...root.querySelectorAll('[data-wx-code-line-number]')].map(e=>e.textContent),['1','2','3','4','5']);
  assert.equal(read(root.querySelector('code')),source);
  assert.equal(root.querySelector('.hljs-keyword').style.color,'#7441a8');
  assert.ok([...root.querySelectorAll('[data-wx-code-line-number]')].every(e=>e.getAttribute('aria-hidden')==='true'&&e.style.getPropertyValue('user-select')==='none'));
  assert.equal(render(root.innerHTML).innerHTML,root.innerHTML);
  root.innerHTML=preserveWechatCodeLayout(root.innerHTML,document);
  assert.equal(read(root.querySelector('code')),source);
  assert.equal(root.querySelector('[data-wx-code-indent]').style.width,'4ch');
});
test('multiline syntax tokens split by source lines without losing token style or numeric code literals',()=>{
  const root=render('<p>参数 <code>42</code></p><pre><code><span style="color:#28613b">"""a\n\nb"""</span>\nx = 123</code></pre>');
  assert.equal(root.querySelectorAll('[data-wx-code-line-number]').length,4);
  assert.equal(read(root.querySelector('pre code')),'"""a\n\nb"""\nx = 123');
  assert.equal(root.querySelector('p code').textContent,'42');
  assert.equal(root.querySelector('p [data-wx-code-line-number]'),null);
  assert.equal(root.querySelectorAll('[data-wx-code-line-text] [style*="color"]').length,2);
});

test('CSV and text blocks display their exact data without line numbers or a gutter',()=>{
  const source='name,value\n"GPU, model",12\n\n  leading,14\n';
  for(const language of ['csv','CSV','tsv','text','txt','plaintext','plain']) {
    const root=render(`<pre><code class="language-${language}">${source}</code></pre>`);
    assert.equal(root.querySelectorAll('[data-wx-code-line-number]').length,0,language);
    assert.equal(root.querySelectorAll('[data-wx-code-line]').length,0,language);
    assert.equal(read(root.querySelector('code')),source,language);
    root.innerHTML=preserveWechatCodeLayout(root.innerHTML,document);
    assert.equal(read(root.querySelector('code')),source,language+' publishing');
    assert.equal(root.querySelector('code').querySelectorAll('br').length,4,language);
  }
});

test('only data block languages skip numbers; code referring to CSV files remains numbered',()=>{
  const root=render('<pre><code class="language-bash">cat data.csv\npython run.py</code></pre><pre><code class="language-plaintext" data-language-pending="python">import csv\nprint(12)</code></pre>');
  assert.deepEqual([...root.querySelectorAll('pre')].map(pre=>pre.querySelectorAll('[data-wx-code-line-number]').length),[2,2]);
});

test('original language metadata and language aliases identify plain data blocks',()=>{
  for(const attributes of ['class="language-plaintext" data-language-pending=" CSV "','data-language="tsv"','class="hljs lang-TXT"']) {
    const root=render(`<pre><code ${attributes}>name,value\n  GPU,12\n</code></pre>`);
    assert.equal(root.querySelectorAll('[data-wx-code-line-number]').length,0,attributes);
    assert.equal(read(root.querySelector('code')),'name,value\n  GPU,12\n',attributes);
  }
});
