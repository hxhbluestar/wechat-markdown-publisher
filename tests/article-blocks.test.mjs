import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
let describeBlocks,normalizeBlockOverrides,applyBlockOverrides;
try {({describeBlocks,normalizeBlockOverrides,applyBlockOverrides}=await import('../frontend/article-blocks.mjs'));}
catch(error) {if(error.code!=='ERR_MODULE_NOT_FOUND'||!error.message.includes('article-blocks.mjs'))throw error;}
const document=parseHTML('<html><body></body></html>').document;
const ready=()=>assert.equal(typeof describeBlocks,'function','article block implementation is missing');
const rootOf=html=>{const root=document.createElement('div');root.innerHTML=html;return root;};

test('block identities survive insertions elsewhere and keep real UTF-16 CRLF offsets',()=>{
  ready();const source='# 标题😀\r\n\r\n第一段 **强调**。\r\n\r\n## 第二节\r\n';
  const before=describeBlocks(source),after=describeBlocks('新段落\r\n\r\n'+source);
  assert.deepEqual(before.map(block=>block.id),after.slice(1).map(block=>block.id));
  assert.deepEqual(before.map(block=>block.kind),['h1','p','h2']);
  assert.equal(source.slice(before[1].from,before[1].to).trim(),'第一段 **强调**。');
  assert.equal(before[0].text,'标题😀');
});

test('fenced code, front matter and inline code cannot become editable headings',()=>{
  ready();const blocks=describeBlocks('---\ntitle: Example\n---\n\n```md\n# Hidden\n```\n\n# Real\n\n`# text` remains code.');
  assert.deepEqual(blocks.filter(block=>/^h/.test(block.kind)).map(block=>block.text),['Real']);
  assert.equal(blocks.find(block=>block.kind==='p').text,'# text remains code.');
});

test('an optional real lexer supplies stable raw spans and nested inline text',()=>{
  ready();const source='\ufeff---\ntitle: ignored\n---\n\n# **A**\n\nText [link](https://example.com).\n';
  const lex=()=>({content:'# **A**\n\nText [link](https://example.com).\n',tokens:[
    {type:'heading',raw:'# **A**\n',depth:1,text:'**A**',tokens:[{type:'strong',tokens:[{type:'text',text:'A'}]}]},
    {type:'space',raw:'\n'}, {type:'paragraph',raw:'Text [link](https://example.com).\n',text:'Text [link](https://example.com).'},
  ]});
  const blocks=describeBlocks(source,lex);assert.equal(blocks[0].from,source.indexOf('# **A**'));
  assert.equal(blocks[0].text,'A');assert.equal(blocks[1].text,'Text link.');
});

test('empty overrides preserve the original HTML byte for byte unless annotation is requested',()=>{
  ready();const html='<h1 style="color:blue">Heading</h1>\n<p data-x="1">Text</p>';
  assert.equal(applyBlockOverrides(html,'# Heading\n\nText',{}, {document}).html,html);
  const annotated=applyBlockOverrides(html,'# Heading\n\nText',{}, {document,annotate:true});
  assert.equal(rootOf(annotated.html).querySelectorAll('[data-article-block]').length,2);
});

test('controlled heading paragraph caption and table styles export without touching image attrs or code text',()=>{
  ready();const source='# Title\n\nBody **bold**.\n\n![Architecture](images/a.png "Diagram")\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n';
  const blocks=describeBlocks(source),overrides=Object.fromEntries(blocks.filter(block=>block.kind!=='code').map(block=>[block.id,{kind:block.kind,font_size:block.kind==='p'?20:block.kind==='h1'?30:14,margin_before:8,margin_after:4,line_height:1.8}]));
  const html='<h1><span>Title</span></h1><p>Body <strong>bold</strong>.</p><figure><img src="images/a.png" alt="Architecture" title="Diagram" width="700" data-original="keep"><figcaption>Diagram</figcaption></figure><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table><pre><code>\tprint(&quot;x&quot;)\n</code></pre>';
  const result=applyBlockOverrides(html,source,overrides,{document,annotate:true}),root=rootOf(result.html);
  assert.deepEqual(result.unmatched,[]);assert.equal(root.querySelector('h1').style.fontSize,'30px');
  assert.equal(root.querySelector('p').style.fontSize,'20px');assert.equal(root.querySelector('figcaption').style.fontSize,'14px');assert.equal(root.querySelector('table').style.fontSize,'14px');
  assert.equal(root.querySelector('img').outerHTML,rootOf(html).querySelector('img').outerHTML);
  assert.equal(root.querySelector('code').textContent,'\tprint("x")\n');assert.equal(root.querySelector('h1 span').style.fontSize,'inherit');
});

test('identical source blocks are ambiguous and never silently inherit another occurrence override',()=>{
  ready();const source='# Same\n\n# Same',blocks=describeBlocks(source);
  assert.equal(blocks[0].id,blocks[1].id);assert.ok(blocks.every(block=>block.ambiguous));
  const result=applyBlockOverrides('<h1>Same</h1><h1>Same</h1>',source,{[blocks[0].id]:{kind:'h1',font_size:30}},{document,annotate:true});
  assert.deepEqual(result.unmatched,[{id:blocks[0].id,reason:'ambiguous'}]);
  assert.equal(rootOf(result.html).querySelectorAll('[style]').length,0);
});

test('ambiguous rendered text and forged preview IDs cannot bind distinct source blocks',()=>{
  ready();const source='# A\n\n# **A**',blocks=describeBlocks(source),override={[blocks[0].id]:{kind:'h1',font_size:30}};
  const result=applyBlockOverrides(`<h1 data-article-block="${blocks[0].id}">A</h1><h1>A</h1>`,source,override,{document,annotate:true});
  assert.deepEqual(result.unmatched,[{id:blocks[0].id,reason:'render-ambiguous'}]);
  const changed=applyBlockOverrides(`<h1 data-article-block="${blocks[0].id}">Other text</h1>`,source,override,{document,annotate:true});
  assert.equal(changed.unmatched[0].reason,'render-unmatched');assert.equal(rootOf(changed.html).querySelector('h1').hasAttribute('data-article-block'),false);
});

test('deleted or edited source blocks report unmatched overrides instead of rebinding by position',()=>{
  ready();const old=describeBlocks('# Old')[0],override={[old.id]:{kind:'h1',font_size:30}};
  const result=applyBlockOverrides('<h1>New</h1>','# New',override,{document});
  assert.deepEqual(result.unmatched,[{id:old.id,reason:'missing'}]);assert.equal(rootOf(result.html).querySelector('h1').hasAttribute('style'),false);
});

test('normalization accepts only bounded numeric styles and never evaluates accessors or raw CSS',()=>{
  ready();const id=describeBlocks('Paragraph')[0].id;
  const input={[id]:{kind:'p',font_size:20,margin_before:0,margin_after:48,line_height:2.4,color:'red',css:'url(https://bad)'}};
  assert.deepEqual(normalizeBlockOverrides(input),{[id]:{kind:'p',font_size:20,margin_before:0,margin_after:48,line_height:2.4}});
  for(const value of [{kind:'p',font_size:'20px'}, {kind:'p',font_size:33}, {kind:'script',font_size:20}, {kind:'figcaption',font_size:20}])assert.deepEqual(normalizeBlockOverrides({[id]:value}),{});
  let accessed=false;const malicious={};Object.defineProperty(malicious,id,{enumerable:true,get(){accessed=true;throw Error('getter');}});
  assert.deepEqual(normalizeBlockOverrides(malicious),{});assert.equal(accessed,false);
  const many=Object.fromEntries(Array.from({length:250},(_,i)=>['block-'+i.toString(16).padStart(64,'0'),{kind:'p',font_size:20}]));
  assert.equal(Object.keys(normalizeBlockOverrides(many)).length,200);
});

test('inline syntax entities and written figure explanations map through rendered semantic text',()=>{
  ready();const source='Text &amp; **bold** [link](https://example.com).\n\n![alt](images/a.png)\n\n图 1：架构说明';
  const blocks=describeBlocks(source),caption=blocks.find(block=>block.kind==='figcaption');
  assert.equal(caption.text,'图 1：架构说明');
  const result=applyBlockOverrides('<p>Text &amp; <strong>bold</strong> <a href="https://example.com">link</a>.</p><figure><img src="images/a.png"><figcaption><p>图 1：架构说明</p></figcaption></figure>',source,{[caption.id]:{kind:'figcaption',font_size:15}},{document,annotate:true});
  assert.deepEqual(result.unmatched,[]);assert.equal(rootOf(result.html).querySelector('figcaption').style.fontSize,'15px');
});

test('literal entity text cannot be mistaken for a different rendered character',()=>{
  ready();const source='&amp;amp;',block=describeBlocks(source)[0];
  const result=applyBlockOverrides('<p>&amp;</p>',source,{[block.id]:{kind:'p',font_size:20}},{document});
  assert.deepEqual(result.unmatched,[{id:block.id,reason:'render-unmatched'}]);
});
