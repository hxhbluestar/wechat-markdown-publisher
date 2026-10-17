import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {applyBlockOverrides,describeBlocks} from '../frontend/article-blocks.mjs';
let authoringToolsMarkup,connectAuthoringTools;
try {({authoringToolsMarkup,connectAuthoringTools}=await import('../frontend/authoring-tools.mjs'));}
catch(error) {if(error.code!=='ERR_MODULE_NOT_FOUND'||!error.message.includes('authoring-tools.mjs'))throw error;}

function harness(options={}) {
  assert.equal(typeof authoringToolsMarkup,'function','authoring tools implementation is missing');
  const {document}=parseHTML(`<html><body><div class="editor-shell"><aside class="draft-sidebar"></aside><main class="editor-workspace">${authoringToolsMarkup()}<section class="compose-grid"><article id="preview"></article></section></main></div></body></html>`);
  let content=options.content||'# Heading\n\nBody text.',metadata=options.metadata||{};
  const changes=[],selected=[],folds=[],presets=[],saved=new Map();
  const storage=options.storage??{getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value)};
  const preview=document.querySelector('#preview');
  const tools=connectAuthoringTools(document,{
    getContent:()=>content,getMetadata:()=>metadata,getPreview:()=>preview,
    getEditor:()=>null,onChange:value=>changes.push(value),selectRange:(from,to)=>selected.push({from,to}),
    onToggleCodeFold:value=>folds.push(value),onApplyPreset:value=>presets.push(value),storage,
  });
  const render=html=>{preview.innerHTML=applyBlockOverrides(html??'<h1>Heading</h1><p>Body text.</p>',content,tools.read().block_overrides,{document,annotate:true}).html;tools.refresh(content);};
  tools.load(metadata);render(options.html);
  const event=(target,type)=>target.dispatchEvent(new document.defaultView.Event(type,{bubbles:true}));
  return {document,tools,preview,changes,selected,folds,presets,saved,render,
    query:selector=>document.querySelector(selector),event,
    click:selector=>event(document.querySelector(selector),'click'),
    setContent:value=>{content=value;},setMetadata:value=>{metadata=value;},content:()=>content,
  };
}

test('preview heading controls persist bounded overrides and reset returns to the template',()=>{
  const h=harness();h.click('#preview h1');const panel=h.query('[data-authoring-selection]');assert.equal(panel.hidden,false);
  const font=h.query('[data-authoring-field="font_size"]');assert.equal(font.min,'18');assert.equal(font.max,'32');
  font.value='28';h.event(font,'change');const id=describeBlocks(h.content())[0].id;
  assert.deepEqual(h.tools.read(),{block_overrides:{[id]:{kind:'h1',font_size:28}}});assert.equal(h.changes.length,1);
  h.render();assert.equal(h.query('#preview h1').style.fontSize,'28px');
  h.click('[data-authoring-action="reset-block"]');assert.deepEqual(h.tools.read(),{block_overrides:{}});
});

test('caption and table controls preserve image attributes and all code/source characters',()=>{
  const source='![Architecture](images/a.png "Caption")\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```py\nprint("x")\n```';
  const html='<figure><img src="images/a.png" title="Caption" alt="Architecture" width="700"><figcaption>Caption</figcaption></figure><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><pre><code>print("x")\n</code></pre>';
  const h=harness({content:source,html}),image=h.query('img').outerHTML;
  for(const target of ['#preview figcaption','#preview table']) {h.click(target);const font=h.query('[data-authoring-field="font_size"]');font.value='15';h.event(font,'change');}
  assert.equal(Object.keys(h.tools.read().block_overrides).length,2);assert.equal(h.query('img').outerHTML,image);
  assert.equal(h.query('code').textContent,'print("x")\n');assert.equal(h.content(),source);
});

test('outline search navigates real source ranges without changing content',()=>{
  const source='# First😀\r\n\r\nSome searchable body.\r\n\r\n## Second\r\n';
  const h=harness({content:source,html:'<h1>First😀</h1><p>Some searchable body.</p><h2>Second</h2>'});
  assert.equal(h.query('[data-authoring-outline]').children.length,2);
  h.click('[data-authoring-outline] button');assert.equal(h.selected[0].from,0);
  const search=h.query('[data-authoring-search]');search.value='searchable';h.event(search,'input');
  assert.equal(h.query('[data-authoring-outline]').children.length,1);h.click('[data-authoring-outline] button');
  assert.equal(source.slice(h.selected.at(-1).from,h.selected.at(-1).to).trim(),'Some searchable body.');
  assert.equal(h.changes.length,0);assert.equal(h.content(),source);
});

test('code fold callback focus mode and accessible column range do not change article metadata',()=>{
  const h=harness();h.click('[data-authoring-action="fold"]');h.click('[data-authoring-action="fold"]');assert.deepEqual(h.folds,[true,false]);
  h.click('[data-authoring-action="focus"]');assert.equal(h.document.body.classList.contains('authoring-focus-mode'),true);
  const range=h.query('[data-authoring-columns]');assert.equal(range.getAttribute('type'),'range');assert.ok(range.getAttribute('aria-label'));
  range.value='65';h.event(range,'input');assert.equal(h.query('.compose-grid').style.getPropertyValue('--authoring-source-column'),'65fr');
  assert.equal(h.query('.compose-grid').style.getPropertyValue('--authoring-preview-column'),'35fr');
  assert.equal(h.changes.length,0);assert.deepEqual(h.tools.read(),{block_overrides:{}});
});

test('three personal presets store only allowed typography fields and apply through callback',()=>{
  const h=harness({metadata:{theme:'technical',palette:'blue',font_size:18,font_family:'serif',code_wrap:'wrap',table_mode:'cards',caption_font_size:14,table_font_size:15,title:'private title',wechat_account_id:'secret-account'}});
  const select=h.query('[data-authoring-preset]');assert.equal(select.querySelectorAll('option').length,3);
  h.click('[data-authoring-action="save-preset"]');h.setMetadata({font_size:15});h.click('[data-authoring-action="apply-preset"]');
  assert.equal(h.presets[0].font_size,18);assert.equal(h.presets[0].code_wrap,'wrap');assert.equal(h.presets[0].table_font_size,15);
  assert.equal(h.presets[0].title,undefined);assert.equal(h.presets[0].wechat_account_id,undefined);
  const persisted=[...h.saved.values()].join('');assert.ok(!persisted.includes('private title'));assert.ok(!persisted.includes('secret-account'));
});

test('unmatched edits remain visible and can be explicitly reset without rebinding',()=>{
  const old=describeBlocks('# Old')[0],h=harness({content:'# New',html:'<h1>New</h1>',metadata:{block_overrides:{[old.id]:{kind:'h1',font_size:30}}}});
  assert.match(h.query('[data-authoring-unmatched]').textContent,/1/);assert.equal(h.query('[data-authoring-unmatched]').hidden,false);
  assert.equal(Object.keys(h.tools.read().block_overrides).length,1);h.click('[data-authoring-action="reset-unmatched"]');
  assert.deepEqual(h.tools.read(),{block_overrides:{}});assert.equal(h.changes.length,1);
});

test('instances isolate settings and destroy removes handlers without losing stored preferences',()=>{
  const a=harness(),b=harness();a.click('#preview h1');const font=a.query('[data-authoring-field="font_size"]');font.value='30';a.event(font,'change');
  assert.equal(Object.keys(a.tools.read().block_overrides).length,1);assert.deepEqual(b.tools.read(),{block_overrides:{}});
  a.click('[data-authoring-action="focus"]');a.tools.destroy();assert.equal(a.document.body.classList.contains('authoring-focus-mode'),false);
  const count=a.changes.length;font.value='28';a.event(font,'change');assert.equal(a.changes.length,count);assert.ok(a.saved.size>0);
});

test('invalid CSS values and unavailable preference storage surface errors without corrupting content',()=>{
  const h=harness({storage:{getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}}});h.click('#preview h1');
  const font=h.query('[data-authoring-field="font_size"]');font.value='999';h.event(font,'change');assert.deepEqual(h.tools.read(),{block_overrides:{}});
  assert.ok(h.query('[data-authoring-status]').textContent);h.click('[data-authoring-action="save-preset"]');
  assert.match(h.query('[data-authoring-status]').textContent,/保存|存储/);assert.equal(h.content(),'# Heading\n\nBody text.');
});
