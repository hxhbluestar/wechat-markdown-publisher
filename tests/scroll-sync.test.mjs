import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {sourceBlocks,matchPreviewBlocks,mapScrollPosition,connectScrollSync,scrollSyncMarkup} from '../frontend/scroll-sync.mjs';

test('source blocks keep real offsets through CRLF, front matter, blank lines and emoji',()=>{
  const source='---\r\ntitle: demo\r\n---\r\n# GPU 😀\r\n\r\n正文\r\n\r\n```py\r\nx = 1\r\n```\r\n';
  const content='# GPU 😀\n\n正文\n\n```py\nx = 1\n```\n';
  const tokens=[{type:'heading',raw:'# GPU 😀\n\n',text:'GPU 😀',depth:1},{type:'paragraph',raw:'正文',text:'正文'},{type:'space',raw:'\n\n'},{type:'code',raw:'```py\nx = 1\n```\n',text:'x = 1'}];
  const blocks=sourceBlocks(source,{content,tokens});
  assert.deepEqual(blocks.map(b=>b.from),[source.indexOf('# GPU'),source.indexOf('正文'),source.indexOf('```py')]);
  assert.equal(source.slice(blocks[2].from,blocks[2].to),'```py\r\nx = 1\r\n```\r\n');
});
test('matching skips generated footnotes and caption paragraphs already merged into figures',()=>{
  const {document}=parseHTML('<article><section class="container"><section class="wx-flow-block"><h2>GPU 实验</h2></section><section class="wx-flow-block"><figure><img alt="拓扑"><figcaption>图1：拓扑</figcaption></figure></section><section class="wx-flow-block"><p>实验结果</p></section><section class="wx-code-block"><pre><code>x = 1</code></pre></section><h4>参考资料</h4><p>脚注</p></section></article>');
  const blocks=[{type:'heading',depth:2,text:'GPU 实验',from:0,to:10},{type:'paragraph',text:'拓扑',from:11,to:25},{type:'paragraph',text:'图1：拓扑',from:26,to:35},{type:'paragraph',text:'实验结果',from:36,to:45},{type:'code',text:'x = 1',from:46,to:70}];
  const matches=matchPreviewBlocks(document.querySelector('article'),blocks);
  assert.deepEqual(matches.map(m=>m.from),[0,11,36,46]);
  assert.deepEqual(matches.map(m=>m.element.tagName),['H2','FIGURE','P','SECTION']);
});
test('interpolation follows corresponding content rather than only document percentages',()=>{
  const pairs=[{source:0,preview:0},{source:200,preview:1000},{source:1000,preview:2000}];
  assert.equal(mapScrollPosition(100,pairs,'source'),500);
  assert.equal(mapScrollPosition(1500,pairs,'preview'),600);
  assert.equal(mapScrollPosition(-1,pairs,'source'),0);
  assert.equal(mapScrollPosition(5000,pairs,'preview'),1000);
  assert.equal(mapScrollPosition(0,[{source:0,preview:0}],'source'),0);
});

function harness(){
  const {document,window}=parseHTML('<body>'+scrollSyncMarkup()+'<div class="phone-stage"><article id="previewArticle"><h1>A</h1><p>B</p></article></div></body>');
  const stage=document.querySelector('.phone-stage'),preview=document.querySelector('article'),toggle=document.querySelector('#syncScrollToggle');
  const source=document.createElement('div');let frameId=0,frames=new Map(),editorWrites=0;
  window.requestAnimationFrame=callback=>{frames.set(++frameId,callback);return frameId;};window.cancelAnimationFrame=id=>frames.delete(id);
  const geometry=(el,top,height,max)=>{Object.defineProperties(el,{clientHeight:{get:()=>height},scrollHeight:{get:()=>max+height},clientTop:{get:()=>0}});el.scrollTop=0;el.getBoundingClientRect=()=>({top,height});};
  geometry(source,0,200,1000);geometry(stage,0,300,2000);
  for(const [el,top] of [[preview,0],[preview.children[0],0],[preview.children[1],1000]])el.getBoundingClientRect=()=>({top:top-stage.scrollTop,height:40});
  const view={scrollDOM:source,state:{doc:{length:5,toString:()=>'# A\nB'}},get documentTop(){return -source.scrollTop;},lineBlockAt(pos){return {top:pos<4?0:200};},dispatch(){editorWrites++;}};
  const lexMarkdown=()=>({tokens:[{type:'heading',depth:1,raw:'# A\n',text:'A'},{type:'paragraph',raw:'B',text:'B'}]});
  const storage=new Map();const controller=connectScrollSync(document,{lexMarkdown,storage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)}});
  controller.attachEditor(view);controller.refresh('a','# A\nB');
  const flush=()=>{for(let n=0;frames.size&&n<10;n++){const callbacks=[...frames.values()];frames.clear();callbacks.forEach(cb=>cb());}assert.equal(frames.size,0,'scroll events must settle');};
  const scroll=(element,top)=>{element.scrollTop=top;element.dispatchEvent(new window.Event('scroll'));flush();};
  flush();return {document,window,stage,source,toggle,view,controller,flush,scroll,get editorWrites(){return editorWrites;}};
}
test('both scroll directions follow block anchors without moving the cursor or creating edits',()=>{
  const h=harness();h.scroll(h.source,200);assert.equal(h.stage.scrollTop,1000);h.scroll(h.stage,1500);assert.equal(h.source.scrollTop,600);assert.equal(h.editorWrites,0);
  // The event caused by the mirrored write must not bounce back.
  h.source.dispatchEvent(new h.window.Event('scroll'));h.flush();assert.equal(h.stage.scrollTop,1500);
});
test('toggle disables sync, horizontal child scrolls are ignored, and draft changes reset positions',()=>{
  const h=harness();h.toggle.click();h.scroll(h.source,200);assert.equal(h.stage.scrollTop,0);assert.equal(h.toggle.getAttribute('aria-pressed'),'false');
  h.toggle.click();h.flush();assert.equal(h.stage.scrollTop,1000);
  const nested=h.document.createElement('pre');h.stage.append(nested);h.source.scrollTop=10;nested.dispatchEvent(new h.window.Event('scroll',{bubbles:true}));h.flush();assert.equal(h.source.scrollTop,10);
  h.controller.refresh('b','# A\nB');h.flush();assert.equal(h.stage.scrollTop,0);
  h.controller.detachEditor();h.scroll(h.stage,800);assert.equal(h.source.scrollTop,0);
});
test('invalidated preview does not synchronize stale positions while new text is rendering',()=>{
  const h=harness();h.controller.invalidate();h.scroll(h.source,700);assert.equal(h.stage.scrollTop,0);h.controller.refresh('a','# A\nB');h.flush();assert.ok(h.stage.scrollTop>1000);
});
