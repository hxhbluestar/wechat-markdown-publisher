import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {typographyControlsMarkup,connectTypographyControls,themeOptionsMarkup} from '../frontend/typography-controls.mjs';
import {typographyAccent} from '../frontend/typography.mjs';

test('the editor color indicator follows the actual layout accent while legacy palettes retain their source',()=>{
  assert.equal(typographyAccent('technical','warm'),'#0051c6');
  assert.equal(typographyAccent('journal','warm'),'#8b563b');
  assert.equal(typographyAccent('obsidian','blue'),'#2899ff');
  assert.equal(typographyAccent('grace','blue'),null);
});

test('four distinct templates are offered and a saved older template remains loadable without migration', () => {
  const {document}=parseHTML(`<main><select id="themeSelect">${themeOptionsMarkup()}</select>${typographyControlsMarkup()}</main>`);
  const select=document.querySelector('#themeSelect');
  assert.deepEqual([...select.options].map(o=>o.value),['technical','minimal','journal','obsidian']);
  const controls=connectTypographyControls(document);
  controls.load({theme:'deepsea'});
  assert.equal(select.options.length,5);
  assert.match([...select.options].find(o=>o.value==='deepsea').textContent,/已保存/);
  controls.load({theme:'grace'});
  assert.equal(select.options.length,5);
  assert.ok([...select.options].some(o=>o.value==='grace'));
  assert.ok(![...select.options].some(o=>o.value==='deepsea'));
  controls.themeChanged('technical');
  assert.equal(select.options.length,4);
});

test('typography controls offer fonts, size, code wrapping, tables and phone widths', () => {
  const {document} = parseHTML(`<main>${typographyControlsMarkup()}</main>`);
  for (const id of ['fontFamilySelect','fontSizeSelect','captionFontSizeSelect','tableFontSizeSelect','codeWrapSelect','tableModeSelect','previewWidthSelect']) {
    assert.ok(document.getElementById(id), `Missing usable control: ${id}`);
  }
});

test('local code highlighter recognizes PowerShell in addition to technical languages', () => {
  const context = {module:{exports:{}},exports:{}};
  vm.runInNewContext(fs.readFileSync(new URL('../app/web/highlight.min.js',import.meta.url),'utf8'),context);
  const plugin = new URL('../app/web/vendor/highlight-powershell-11.11.1.min.js',import.meta.url);
  if (fs.existsSync(plugin)) vm.runInNewContext(fs.readFileSync(plugin,'utf8'),context);
  const highlighter = context.module.exports;
  for (const name of ['python','bash','powershell','cpp','yaml','sql','diff']) assert.ok(highlighter.getLanguage(name),name);
});

test('loading a saved style preserves six independent publishing settings including 12px details', () => {
  const {document} = parseHTML(`<main>${typographyControlsMarkup()}</main>`);
  const changes=[];
  const controls=connectTypographyControls(document,values=>changes.push(values));
  controls.load({theme:'journal',font_family:'serif',font_size:18,code_wrap:'wrap',table_mode:'cards',caption_font_size:12,table_font_size:12});
  assert.deepEqual(controls.read('journal'),{font_family:'serif',font_size:18,code_wrap:'wrap',table_mode:'cards',caption_font_size:12,table_font_size:12});
  assert.equal(changes.length,0,'Loading must not mark the article dirty');
});

test('selecting a technical style applies its profile without retaining the old font', () => {
  const {document} = parseHTML(`<main>${typographyControlsMarkup()}</main>`);
  const controls=connectTypographyControls(document,()=>{});
  controls.load({theme:'grace',font_size:16,font_family:'sans'});
  controls.themeChanged('journal');
  assert.deepEqual(controls.read('journal'),{font_family:'theme',font_size:17,code_wrap:'wrap',table_mode:'cards',caption_font_size:12,table_font_size:13});
  controls.themeChanged('minimal');
  assert.deepEqual(controls.read('minimal'),{font_family:'theme',font_size:16,code_wrap:'wrap',table_mode:'auto',caption_font_size:12,table_font_size:13});
});

test('laboratory themes use readable defaults and changing a detail size marks the draft dirty', () => {
  const {document,Event}=parseHTML(`<main>${typographyControlsMarkup()}</main>`);
  const changes=[];
  const controls=connectTypographyControls(document,values=>changes.push(values));
  for (const theme of ['obsidian','deepsea','teal']) {
    controls.themeChanged(theme);
    assert.equal(controls.read(theme).font_size,17);
    assert.equal(controls.read(theme).caption_font_size,12);
    assert.equal(controls.read(theme).table_font_size,13);
    assert.equal(controls.read(theme).code_wrap,'wrap');
  }
  const size=document.querySelector('#tableFontSizeSelect');
  for (const option of size.options) option.selected=false;
  [...size.options].find(option=>option.value==='12').selected=true;
  size.dispatchEvent(new Event('change'));
  assert.equal(changes.length,1);
  assert.equal(changes[0].table_font_size,12);
  assert.equal(changes[0].font_size,17);
});
