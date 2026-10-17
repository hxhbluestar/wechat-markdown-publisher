import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {typographyControlsMarkup,connectTypographyControls} from '../frontend/typography-controls.mjs';

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
