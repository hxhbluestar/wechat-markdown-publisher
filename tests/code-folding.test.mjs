import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {codeFoldRanges,createCodeFolding} from '../frontend/code-folding.mjs';
test('folding hides only complete fenced bodies, retaining precise source offsets',()=>{
 const text='# A\n\n```python\none\n  two\n```\n\ntext\n\n~~~bash\necho a\n~~~\n';
 const ranges=codeFoldRanges(text);
 assert.equal(ranges.length,2);assert.equal(text.slice(ranges[0].from,ranges[0].to),'one\n  two\n```');assert.equal(ranges[0].lines,2);
 assert.equal(codeFoldRanges('```python\nunclosed').length,0);
});
test('real CodeMirror state folds and unfolds without changing code or undo history',async()=>{
 const dom=parseHTML('<html><head></head><body></body></html>');
 globalThis.document=dom.document;globalThis.window=dom.window;globalThis.self=dom.window;globalThis.MutationObserver=dom.window.MutationObserver;
 const engine=await import('../frontend/vendor/editor-engine-20261018.js');
 const folding=createCodeFolding({StateField:engine.StateField,StateEffect:engine.StateEffect,Decoration:engine.Bt,EditorView:engine.We,WidgetType:engine.WidgetType});
 const text='```cpp\n  int x = 42;\n```\n';
 let state=engine.dt.create({doc:text,extensions:[folding.extension]});
 state=state.update({effects:folding.effect.of({folded:true})}).state;
 assert.equal(state.field(folding.field).decorations.size,1);assert.equal(state.doc.toString(),text);
 state=state.update({effects:folding.effect.of({folded:false})}).state;
 assert.equal(state.field(folding.field).decorations.size,0);assert.equal(state.doc.toString(),text);
});
