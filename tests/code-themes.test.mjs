import test from 'node:test';
import assert from 'node:assert/strict';
import {codeTheme, codeThemeCSS, normalizeCodeTheme} from '../frontend/code-themes.mjs';

function contrast(a,b) {
  const light=hex=>hex.slice(1).match(/../g).map(x=>parseInt(x,16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((sum,x,i)=>sum+x*[.2126,.7152,.0722][i],0);
  const [hi,lo]=[light(a),light(b)].sort((x,y)=>y-x);
  return (hi+.05)/(lo+.05);
}
test('code themes are independent of article accents and reject unsafe options',()=>{
  for(const id of ['auto','vscode','github','catppuccin']) assert.equal(normalizeCodeTheme(id),id);
  for(const id of [null,[],true,'__proto__','github; color:red']) assert.equal(normalizeCodeTheme(id),'auto');
  assert.equal(codeTheme('technical','auto').id,'vscode');
  assert.equal(codeTheme('minimal','auto').id,'github');
  for(const article of ['technical','journal','minimal','obsidian','deepsea','teal','grace','default','simple']) {
    assert.equal(codeTheme(article,'catppuccin').id,'catppuccin');
  }
});
test('small code, every syntax role, headers and gutters meet 4.5 contrast',()=>{
  for(const id of ['vscode','github','catppuccin']) {
    const theme=codeTheme('technical',id);
    assert.ok(new Set(Object.values(theme.tokens)).size>=11,id+' has distinct semantic hues');
    for(const [role,color] of Object.entries({...theme.tokens,text:theme.text,gutter:theme.gutter})) {
      assert.ok(contrast(color,theme.background)>=4.5,id+'/'+role+' must remain readable at 12px');
    }
    assert.ok(contrast(theme.label,theme.header)>=4.5,id+' caption');
  }
});
test('code presentation uses exportable CSS with explicit semantic roles',()=>{
  const rule=(selector,properties)=>selector+'{'+Object.entries(properties).map(([k,v])=>k+':'+v).join(';')+'}';
  const css=codeThemeCSS({code_theme:'catppuccin',code_wrap:'wrap',code_font_size:12},'technical',rule);
  assert.match(css,/\.wx-code-pre\{[^}]*font-size:12px/);
  assert.match(css,/\.wx-code-caption\{[^}]*background:#181825/);
  assert.match(css,/\.hljs-title\.class_/);
  assert.match(css,/\.hljs-title\.function_/);
  assert.match(css,/border-top:1px solid/);
  assert.doesNotMatch(css,/var\(|@font-face|@import|counter\(|::before|display:grid|display:flex/);
});
