import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {typographyControlsMarkup,connectTypographyControls} from '../frontend/typography-controls.mjs';

test('typography controls offer fonts, size, code wrapping, tables and phone widths', () => {
  const {document} = parseHTML(`<main>${typographyControlsMarkup()}</main>`);
  for (const id of ['fontFamilySelect','fontSizeSelect','codeWrapSelect','tableModeSelect','previewWidthSelect']) {
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

test('loading a saved style and changing its controls preserves all four publish settings', () => {
  const {document} = parseHTML(`<main>${typographyControlsMarkup()}</main>`);
  const changes=[];
  const controls=connectTypographyControls(document,values=>changes.push(values));
  controls.load({theme:'journal',font_family:'serif',font_size:18,code_wrap:'wrap',table_mode:'cards'});
  assert.deepEqual(controls.read('journal'),{font_family:'serif',font_size:18,code_wrap:'wrap',table_mode:'cards'});
  assert.equal(changes.length,0,'Loading must not mark the article dirty');
});

test('selecting a technical style applies its profile without retaining the old font', () => {
  const {document} = parseHTML(`<main>${typographyControlsMarkup()}</main>`);
  const controls=connectTypographyControls(document,()=>{});
  controls.load({theme:'grace',font_size:16,font_family:'sans'});
  controls.themeChanged('journal');
  assert.deepEqual(controls.read('journal'),{font_family:'theme',font_size:17,code_wrap:'wrap',table_mode:'cards'});
  controls.themeChanged('minimal');
  assert.deepEqual(controls.read('minimal'),{font_family:'theme',font_size:16,code_wrap:'wrap',table_mode:'auto'});
});
