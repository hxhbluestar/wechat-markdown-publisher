import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { normalizeTypography, prepareTypography } from '../frontend/typography.mjs';
import {codeTheme} from '../frontend/code-themes.mjs';

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../app/web/highlight.min.js', import.meta.url), 'utf8'), context);
const highlighter = context.hljs;
const { document } = parseHTML('<html><body></body></html>');
function render(html, settings = {}, hljs = highlighter) {
  const result = prepareTypography(html, { theme: 'technical', ...settings }, document, hljs);
  const holder = document.createElement('div');
  holder.id = 'output';
  holder.innerHTML = result.html;
  return { ...result, holder };
}
function computedRule(css, selector, property) {
  let value;
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors.split(',').some((item) => item.trim() === selector)) continue;
    for (const declaration of body.split(';')) {
      const colon = declaration.indexOf(':');
      if (declaration.slice(0, colon).trim() === property) value = declaration.slice(colon + 1).replace(/\s*!important\s*$/, '').trim();
    }
  }
  return value;
}

test('saved legacy layouts wrap long headings and use readable opaque table headers', () => {
  const html = '<h2>ROCmGraphCompilerKernelConfigurationCrossPlatform</h2><table><tr><th><strong>参数</strong></th></tr><tr><td>保留值</td></tr></table>';
  for (const theme of ['grace', 'default', 'simple']) {
    for (const palette of ['warm', 'blue', 'wechat', 'red', 'violet', 'ink']) {
      const {css, holder} = render(html, {theme, palette});
      const h2 = holder.querySelector('h2');
      assert.equal(resolvedRule(css, h2, 'display'), 'block');
      assert.equal(resolvedRule(css, h2, 'overflow-wrap'), 'anywhere');
      assert.equal(resolvedRule(css, h2, 'line-height'), '1.6');
      assert.equal(resolvedRule(css, holder.querySelector('th'), 'color'), '#ffffff');
      assert.match(resolvedRule(css, holder.querySelector('th'), 'background'), /^#[\da-f]{6}$/i);
      assert.equal(resolvedRule(css, holder.querySelector('th strong'), 'color'), 'inherit');
      assert.match(holder.textContent, /保留值/);
    }
  }
});

function resolvedRule(css, element, property) {
  let winner;
  let order = 0;
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const selector of selectors.split(',').map((value) => value.trim())) {
      if (!element.matches(selector)) continue;
      const weight = [(selector.match(/#[\w-]+/g) || []).length, (selector.match(/\.[\w-]+/g) || []).length, selector.split(/\s+/).filter((part) => /^[a-z][\w-]*/i.test(part)).length];
      for (const declaration of body.split(';')) {
        const colon = declaration.indexOf(':');
        if (declaration.slice(0, colon).trim() !== property) continue;
        const raw = declaration.slice(colon + 1).trim();
        const candidate = { value: raw.replace(/\s*!important\s*$/, ''), weight: [/!important\s*$/.test(raw) ? 1 : 0, ...weight, order++] };
        if (!winner || candidate.weight.some((value, index) => value !== winner.weight[index] && candidate.weight.slice(0, index).every((prior, priorIndex) => prior === winner.weight[priorIndex]) && value > winner.weight[index])) winner = candidate;
      }
    }
  }
  return winner?.value;
}

test('only safe typography options survive normalization and legacy gets its original size', () => {
  assert.deepEqual(normalizeTypography({}), { font_family: 'theme', font_size: 17, code_font_size:12, code_theme:'auto', code_wrap: 'wrap', table_mode: 'auto', caption_font_size: 12, table_font_size: 13 });
  for (const theme of ['technical', 'journal', 'minimal', 'obsidian', 'deepsea', 'teal']) assert.equal(normalizeTypography(null, theme).font_size, 17);
  for (const theme of ['default', 'grace', 'simple', 'classic']) assert.equal(normalizeTypography({}, theme).font_size, 16);
  assert.deepEqual(normalizeTypography({ font_family: 'serif', font_size: '18', code_wrap: 'wrap', table_mode: 'cards', extra: 'ignored' }), { font_family: 'serif', font_size: 18, code_font_size:12, code_theme:'auto', code_wrap: 'wrap', table_mode: 'cards', caption_font_size: 12, table_font_size: 13 });
  assert.deepEqual(normalizeTypography({ font_family: 'evil;url()', font_size: '17px;color:red', code_wrap: '__proto__', table_mode: [] }), { font_family: 'theme', font_size: 17, code_font_size:12, code_theme:'auto', code_wrap: 'wrap', table_mode: 'auto', caption_font_size: 12, table_font_size: 13 });
  assert.equal(normalizeTypography({ font_size: true }).font_size, 17);
});

test('caption and table sizes accept only integer sizes from 12 through 16', () => {
  for (const size of [12, 13, 14, 15, 16]) {
    const value = normalizeTypography({ caption_font_size: String(size), table_font_size: size });
    assert.equal(value.caption_font_size, size);
    assert.equal(value.table_font_size, size);
  }
  for (const size of [0, 11, 17, 12.5, true, [], '12px', '12; color:red']) {
    const value = normalizeTypography({ caption_font_size: size, table_font_size: size });
    assert.equal(value.caption_font_size, 12);
    assert.equal(value.table_font_size, 13);
  }
});

test('legacy detail defaults match its original appearance while explicit 12px controls take effect', () => {
  const html = '<figure><img src="a.png"><figcaption><p>旧说明</p></figcaption></figure><table><tr><th>项目</th><th>值</th></tr><tr><td>旧表格</td><td>value</td></tr></table>';
  for (const theme of ['default', 'grace', 'simple']) {
    const defaults = normalizeTypography({}, theme);
    assert.equal(defaults.caption_font_size, 13);
    assert.equal(defaults.table_font_size, 16);
    const legacy = render(html, { theme });
    assert.ok(legacy.holder.querySelector('table.wx-table-fit'));
    assert.equal(legacy.holder.querySelector('figcaption').textContent, '旧说明');
    assert.equal(computedRule(legacy.css, '#output .wx-typography td', 'font-size'), undefined);
    assert.equal(prepareTypography(html, { theme, caption_font_size: 13, table_font_size: 16 }, document, highlighter).html, legacy.html);
    const selected = render(html, { theme, caption_font_size: 12, table_font_size: 12 });
    assert.equal(computedRule(selected.css, '#output .wx-typography figcaption', 'font-size'), '12px');
    assert.equal(computedRule(selected.css, '#output .wx-typography td', 'font-size'), '12px');
  }
});

function contrast(first, second) {
  const luminance = (hex) => {
    assert.match(hex || '', /^#[0-9a-f]{6}$/i, 'A readable theme must expose explicit six-digit colors');
    const channels = hex.slice(1).match(/../g).map((part) => parseInt(part, 16) / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('AMD laboratory themes have distinct paper, heading and quote profiles with readable code', () => {
  const html = '<h1>AMD 实验室</h1><h2>实验条件</h2><p>正文 <a href="https://example.com">链接</a></p><blockquote><p>实验口径</p></blockquote><pre><code class="language-python"># 注释\nreturn "ok"</code></pre>';
  const profiles = [
    { theme: 'obsidian', paper: '#111b22', ink: '#e6edf3', code: '#1e1e1e' },
    { theme: 'deepsea', paper: '#f1f8f8', ink: '#15383d', code: '#1e1e1e' },
    { theme: 'teal', paper: '#ffffff', ink: '#183b36', code: '#f6f8fa' },
  ];
  const headings = [];
  for (const profile of profiles) {
    const { holder, css } = render(html, { theme: profile.theme });
    assert.ok(holder.querySelector(`.wx-theme-${profile.theme}`));
    assert.match(computedRule(css, '#output .wx-typography', 'font-family'), /sans-serif/);
    assert.equal(computedRule(css, '#output .wx-typography', 'background'), profile.paper);
    assert.equal(computedRule(css, '#output .wx-typography', 'color'), profile.ink);
    assert.equal(computedRule(css, '#output .wx-typography', 'padding'), profile.theme === 'obsidian' ? '18px 16px' : '8px 0');
    assert.equal(computedRule(css, '#output .wx-typography .wx-code-block', 'background'), profile.code);
    assert.ok(contrast(profile.ink, profile.paper) >= 7);
    assert.ok(contrast(computedRule(css, '#output .wx-typography .hljs-comment', 'color'), profile.code) >= 4.5);
    assert.notEqual(computedRule(css, '#output .wx-typography blockquote', 'background'), 'transparent');
    headings.push(['padding', 'border-left', 'border-bottom', 'background'].map((property) => computedRule(css, '#output .wx-typography h2', property)).join('|'));
    assert.equal(holder.querySelector('code').textContent, '# 注释\nreturn "ok"');
  }
  assert.equal(new Set(headings).size, 3, 'Each laboratory theme needs its own heading treatment');
});

test('all non-default palettes stay readable on obsidian dark paper and alert backgrounds', () => {
  const html = '<p><a href="https://example.com">链接</a><code>参数</code></p><blockquote class="markdown-alert markdown-alert-warning"><p class="markdown-alert-title">警告</p><p>警告正文</p></blockquote>';
  for (const palette of ['warm', 'blue', 'wechat', 'red', 'violet', 'ink']) {
    const { css } = render(html, { theme: 'obsidian', palette });
    const paper = computedRule(css, '#output .wx-typography', 'background');
    const tint = computedRule(css, '#output .wx-typography .wx-alert', 'background');
    assert.ok(contrast(computedRule(css, '#output .wx-typography a', 'color'), paper) >= 4.5, `${palette} links`);
    assert.ok(contrast(computedRule(css, '#output .wx-typography p code', 'color'), computedRule(css, '#output .wx-typography p code', 'background')) >= 4.5, `${palette} inline code`);
    assert.ok(contrast(computedRule(css, '#output .wx-typography .wx-alert-warning .wx-alert-title', 'color'), tint) >= 4.5, `${palette} warning title`);
  }
});

test('Nord, Dracula and Latte article themes have distinct exportable hierarchy and readable semantic colors',()=>{
  const html='<h1>AI 工程手记</h1><h2>实验步骤</h2><h3>推理调优</h3><h4>配置说明</h4><p>正文 <strong>关键结论</strong> <a href="https://example.com">参考资料</a> <code>dtype</code></p><blockquote><p>可复现的实验口径。</p></blockquote><blockquote class="markdown-alert markdown-alert-note"><p class="markdown-alert-title">提示</p><p>提示正文</p></blockquote><blockquote class="markdown-alert markdown-alert-warning"><p class="markdown-alert-title">注意</p><p>警告正文</p></blockquote><blockquote class="markdown-alert markdown-alert-caution"><p class="markdown-alert-title">风险</p><p>风险正文</p></blockquote><table><thead><tr><th>配置</th><th>结果</th></tr></thead><tbody><tr><td>FP16</td><td>128</td></tr></tbody></table><figure><img src="plot.png" title="性能结果"></figure><pre><code class="language-python">def infer(x):\n    return x + 1</code></pre>';
  const expected={nord:{paper:'#eceff4',code:'vscode'},dracula:{paper:'#282a36',code:'catppuccin'},latte:{paper:'#eff1f5',code:'github'}};
  const headings=[];
  for(const [theme,profile] of Object.entries(expected)) for(const palette of ['warm','blue','wechat','red','violet','ink']) {
    const {holder,css}=render(html,{theme,palette});
    const get=(selector,property)=>computedRule(css,'#output .wx-typography'+(selector?' '+selector:''),property);
    assert.ok(holder.querySelector('.wx-theme-'+theme),theme+' uses modern structure');
    assert.equal(normalizeTypography({},theme).font_size,17);
    assert.equal(get('','background'),profile.paper);
    assert.equal(codeTheme(theme).id,profile.code);
    assert.ok(contrast(get('p','color'),profile.paper)>=7,theme+'/'+palette+' calm body');
    for(const heading of ['h1','h2']) {
      assert.match(get(heading,'background'),/^#[0-9a-f]{6}$/i,theme+' '+heading+' real solid panel');
      assert.ok(contrast(get(heading,'color'),get(heading,'background'))>=4.5,theme+'/'+palette+' '+heading);
    }
    assert.ok(contrast(get('h3','color'),profile.paper)>=4.5,theme+'/'+palette+' complementary heading');
    assert.notEqual(get('h2','color'),get('h3','color'),theme+'/'+palette+' heading hierarchy has complementary colors');
    assert.ok(contrast(get('strong','color'),profile.paper)>=4.5,theme+'/'+palette+' emphasis');
    assert.ok(contrast(get('a','color'),profile.paper)>=4.5,theme+'/'+palette+' link');
    assert.ok(contrast(get('p code','color'),get('p code','background'))>=4.5,theme+'/'+palette+' inline code');
    assert.ok(contrast(get('blockquote p','color'),get('blockquote','background'))>=4.5,theme+'/'+palette+' quotation');
    assert.ok(contrast(get('th','color'),get('th','background'))>=4.5,theme+'/'+palette+' table header');
    assert.ok(contrast(get('figcaption','color'),profile.paper)>=4.5,theme+'/'+palette+' caption');
    for(const kind of ['note','warning','caution']) {
      const background=get('.wx-alert-'+kind,'background');
      assert.ok(contrast(get('.wx-alert-'+kind+' .wx-alert-title','color'),background)>=4.5,theme+'/'+palette+' '+kind+' title');
      assert.ok(contrast(get('.wx-alert p','color'),background)>=4.5,theme+'/'+palette+' '+kind+' prose');
    }
    assert.doesNotMatch(css,/linear-gradient|radial-gradient|::before|::after|display:\s*(?:grid|flex)/i);
    assert.equal(holder.querySelector('pre code').textContent,'def infer(x):\n    return x + 1');
    if(palette==='warm')headings.push(['h1','h2','h3'].map(tag=>['background','color','padding','border-left','border-top','border-bottom'].map(key=>get(tag,key)).join('|')).join('/'));
  }
  assert.equal(new Set(headings).size,3,'Each new article theme has its own heading profile');
});

test('figure captions use explicit title or explanatory alt text and never duplicate existing captions', () => {
  const html = '<figure><img src="a.png" alt="图1 实验室拓扑" title="AMD 实验室拓扑"></figure><figure><img src="b.png" alt="图2 显卡连接方式"></figure><figure><img src="c.png" alt="foo.png"></figure><figure><img src="d.png" alt="图片"></figure><figure><img src="e.png" title="新标题"><figcaption>已有说明</figcaption></figure><figure><img src="f.png" title="&lt;script&gt;测试&lt;/script&gt;"></figure>';
  for (const theme of ['technical', 'journal', 'minimal', 'obsidian', 'deepsea', 'teal']) {
    const result = render(html, { theme });
    assert.deepEqual([...result.holder.querySelectorAll('figcaption')].map((caption) => caption.textContent), ['AMD 实验室拓扑', '图2 显卡连接方式', '已有说明', '<script>测试</script>']);
    assert.equal(result.holder.querySelectorAll('script').length, 0);
    assert.equal(render(result.html, { theme }).holder.querySelectorAll('figcaption').length, 4);
  }
  assert.deepEqual(prepareTypography(html, { theme: 'grace' }, document, highlighter), { html, css: '' });
});

test('handwritten figure explanation paragraphs become captions for new themes and explicit legacy detail settings', () => {
  const html = '<figure><img src="a.png" alt="微信图片_20260101010101_001_01"></figure>\n<p><em>图1 实验室架构</em></p><p>这里是普通正文，必须保留。</p>';
  for (const theme of ['technical', 'journal', 'minimal', 'obsidian', 'deepsea', 'teal', 'grace']) {
    const result = render(html, { theme, caption_font_size: 12 });
    const caption = result.holder.querySelector('figure > figcaption');
    assert.equal(caption?.textContent, '图1 实验室架构');
    assert.equal(caption.querySelector('em').textContent, '图1 实验室架构');
    const prose=[...result.holder.querySelectorAll('p')].filter(p=>!p.closest('figure'));
    assert.equal(prose.length, 1);
    assert.equal(prose[0].textContent, '这里是普通正文，必须保留。');
    assert.equal(computedRule(result.css, '#output .wx-typography figcaption', 'font-size'), '12px');
    assert.equal(render(result.html, { theme, caption_font_size: 12 }).holder.querySelectorAll('figcaption').length, 1);
  }
  assert.deepEqual(prepareTypography(html, { theme: 'grace' }, document, highlighter), { html, css: '' });
});

test('caption recognition preserves title priority, safe emphasis and existing caption uniqueness', () => {
  const html = '<figure><img src="a.png" title="实验室架构总览" alt="微信图片_20260101"></figure><p><strong>图1 实验室架构</strong></p><figure><img src="b.png"><figcaption>图2 实验设备</figcaption></figure><p><em>图2 实验设备</em></p><figure><img src="c.png" alt="原始替代说明"></figure><p>Figure 3: Laboratory layout.</p><p>图1展示了另一项实验结果，作为普通正文保留。</p>';
  const { holder } = render(html, { caption_font_size: 12 });
  const captions = [...holder.querySelectorAll('figcaption')];
  assert.equal(captions.length, 3);
  assert.match(captions[0].textContent, /^实验室架构总览/);
  assert.equal(captions[0].querySelector('strong')?.textContent, '图1 实验室架构');
  assert.equal(captions[1].textContent, '图2 实验设备');
  assert.equal(captions[2].textContent, 'Figure 3: Laboratory layout.');
  assert.equal(holder.textContent.match(/图2 实验设备/g).length, 1);
  assert.equal([...holder.querySelectorAll('p')].filter(p=>!p.closest('figure')).at(-1).textContent, '图1展示了另一项实验结果，作为普通正文保留。');
});

test('machine filename stems do not become automatic alt captions', () => {
  const names = ['微信图片_20260101010101_001_01', '截图_20260101_123456', 'Screenshot_2026-01-01_12-30-45', 'Screenshot 2026-01-01 at 12.30.45', 'IMG_1234'];
  const html = names.map((name) => `<figure><img src="a.png" alt="${name}"></figure>`).join('') + '<figure><img src="b.png" alt="图4 实验室网络结构"></figure>';
  const { holder } = render(html);
  assert.deepEqual([...holder.querySelectorAll('figcaption')].map((caption) => caption.textContent), ['图4 实验室网络结构']);
});

test('ordinary paragraphs and mixed markup following figures are not mistaken for caption lines', () => {
  const html = '<figure><img src="a.png" alt="image"></figure><p>图1展示了普通正文。</p><figure><img src="b.png" alt="image"></figure><p>如图2，继续说明。</p><figure><img src="c.png" alt="image"></figure><p><a href="https://example.com">图3 实验室链接</a></p>';
  const { holder } = render(html);
  assert.equal(holder.querySelectorAll('figcaption').length, 0);
  assert.equal([...holder.querySelectorAll('p')].filter(p=>!p.closest('figure')).length, 3);
  assert.equal(holder.querySelector('a').getAttribute('href'), 'https://example.com');
});

test('caption size controls override nested old caption styles without changing body size', () => {
  const html = '<p>正文</p><figure><img src="a.png"><figcaption style="font-size:14px!important"><p style="font-size:14px"><span style="font-size:10px!important">实验条件说明</span></p></figcaption></figure>';
  for (const theme of ['technical', 'obsidian', 'deepsea', 'teal', 'grace']) {
    const { holder, css } = render(html, { theme, caption_font_size: 16 });
    assert.equal(holder.querySelector('figcaption').textContent, '实验条件说明');
    assert.equal(computedRule(css, '#output .wx-typography figcaption', 'font-size'), '16px');
    assert.equal(computedRule(css, '#output .wx-typography figcaption *', 'font-size'), '16px');
    for (const item of holder.querySelectorAll('figcaption,figcaption *')) assert.equal(item.style.getPropertyValue('font-size') || '', '');
    assert.equal(computedRule(css, '#output .wx-typography p', 'font-size'), theme === 'grace' ? undefined : '17px');
  }
});

test('legacy prose without code or tables remains byte for byte untouched', () => {
  const html = '<section class="container"><p style="font-size:16px">旧文</p></section>';
  assert.deepEqual(prepareTypography(html, { theme: 'grace' }, document, highlighter), { html, css: '' });
});

test('changing legacy font size keeps its theme font and normalizes code to original lines', () => {
  const { holder, css } = render('<p>旧文章字体</p><pre class="hljs code__pre"><code>x<br>y</code></pre>', { theme: 'grace', font_size: 18 });
  assert.equal(computedRule(css, '#output .wx-typography', 'font-family'), undefined);
  assert.equal(computedRule(css, '#output .wx-typography p', 'font-size'), '18px');
  assert.equal(holder.querySelector('pre code').textContent, 'x\ny');
  assert.equal(holder.querySelectorAll('.wx-code-caption').length, 1);
});

test('theme and explicit font controls yield system fallback fonts and readable CJK styles', () => {
  for (const theme of ['technical', 'journal', 'minimal']) {
    const { holder, css } = render('<p style="font-size:12px;color:#eee">中文正文</p><blockquote style="font-style:italic"><p>引文</p><blockquote><p>嵌套</p></blockquote></blockquote>', { theme });
    assert.equal(holder.querySelectorAll('.wx-typography').length, 1);
    assert.equal(computedRule(css, '#output .wx-typography', 'font-size'), '17px');
    assert.equal(computedRule(css, '#output .wx-typography blockquote', 'font-style'), 'normal');
    assert.equal(computedRule(css, '#output .wx-typography h1', 'display'), 'block');
    assert.equal(holder.querySelectorAll('blockquote').length, 2);
    assert.equal(holder.textContent, '中文正文引文嵌套');
    const font = computedRule(css, '#output .wx-typography', 'font-family');
    assert.match(font, theme === 'journal' ? /Songti|SimSun/ : /PingFang|Microsoft YaHei/);
    assert.doesNotMatch(css, /https?:|@import|var\(/);
  }
  const overridden = render('<p>旧文设置</p>', { theme: 'grace', font_family: 'serif', font_size: 18 });
  assert.match(computedRule(overridden.css, '#output .wx-typography', 'font-family'), /SimSun/);
  assert.equal(computedRule(overridden.css, '#output .wx-typography p', 'font-size'), '18px');
});

test('technical links and blue palette follow the official ROCm light and dark accent colors', () => {
  const html = '<h2><strong>实验条件</strong></h2><h3>验证方法</h3><p><a href="https://example.com">文档</a> <code>参数</code></p>';
  const technical = render(html);
  assert.equal(resolvedRule(technical.css, technical.holder.querySelector('a'), 'color'), '#0051c6');
  for (const theme of ['technical', 'journal', 'minimal']) {
    const light = render(html, { theme, palette: 'blue' });
    assert.equal(resolvedRule(light.css, light.holder.querySelector('a'), 'color'), '#0051c6');
  }
  const dark = render(html, { theme: 'obsidian', palette: 'blue' });
  assert.equal(resolvedRule(dark.css, dark.holder.querySelector('a'), 'color'), '#2899ff');
  assert.ok(contrast('#2899ff', computedRule(dark.css, '#output .wx-typography', 'background')) >= 4.5);
  assert.ok(contrast('#2899ff', computedRule(dark.css, '#output .wx-typography p code', 'background')) >= 4.5);
});

test('technical heading hierarchy and nested quotes provide blue emphasis and readable space', () => {
  const html = '<h2><strong>实验条件</strong></h2><h3>验证方法</h3><p>正文内容</p><blockquote><p>外层引用</p><blockquote><p>内层引用</p></blockquote></blockquote>';
  const { holder, css } = render(html);
  assert.equal(resolvedRule(css, holder.querySelector('h2 strong'), 'color'), '#0051c6');
  assert.equal(resolvedRule(css, holder.querySelector('h3'), 'color'), '#0051c6');
  assert.ok(Number.parseFloat(resolvedRule(css, holder.querySelector('h2'), 'font-size')) > Number.parseFloat(resolvedRule(css, holder.querySelector('h3'), 'font-size')));
  const quote = holder.querySelector('blockquote');
  const nested = quote.querySelector('blockquote');
  assert.equal(resolvedRule(css, quote, 'background'), '#eff6ff');
  assert.equal(resolvedRule(css, quote, 'border-left'), '2px solid #0051c6');
  assert.equal(resolvedRule(css, quote, 'padding'), '13px 16px');
  assert.equal(resolvedRule(css, nested, 'padding'), '0 0 0 12px');
  assert.equal(resolvedRule(css, nested, 'margin'), '14px 0 0');
  assert.equal(resolvedRule(css, nested, 'background'), 'transparent');
  assert.ok(contrast(resolvedRule(css, quote.querySelector('p'), 'color'), resolvedRule(css, quote, 'background')) >= 4.5);
  assert.equal(holder.textContent, '实验条件验证方法正文内容外层引用内层引用');
});

test('new theme palettes color article accents while preserving paper and code contrast', () => {
  const palettes = [
    { name: 'blue', text: '#0051c6', border: '#0051c6', tint: '#eff6ff' },
    { name: 'wechat', text: '#078340', border: '#07c160', tint: '#effaf4' },
    { name: 'red', text: '#b33a3a', border: '#b33a3a', tint: '#fff1f1' },
    { name: 'violet', text: '#7c3aed', border: '#7c3aed', tint: '#f5f1ff' },
    { name: 'ink', text: '#806027', border: '#9a7430', tint: '#f8f3e8' },
  ];
  const html = '<h2>标题</h2><p><a href="https://example.com">链接</a> <code>参数</code></p><blockquote><p>引用</p></blockquote><blockquote class="markdown-alert markdown-alert-note"><p class="markdown-alert-title">提示</p><p>正文</p></blockquote><pre><code class="language-python">return 1</code></pre>';
  for (const theme of ['technical', 'journal', 'minimal']) {
    const base = render(html, { theme, palette: 'warm' });
    for (const palette of palettes) {
      const result = render(html, { theme, palette: palette.name });
      assert.equal(result.holder.querySelector('a').getAttribute('href'), 'https://example.com');
      assert.equal(result.holder.querySelector('code').textContent, '参数');
      assert.equal(computedRule(result.css, '#output .wx-typography a', 'color'), palette.text, `${theme}/${palette.name} link`);
      assert.equal(computedRule(result.css, '#output .wx-typography p code', 'color'), palette.text);
      assert.equal(computedRule(result.css, '#output .wx-typography p code', 'background'), palette.tint);
      const edge = theme === 'journal' ? 'border-top' : theme === 'minimal' ? 'border-bottom' : 'border-left';
      assert.match(computedRule(result.css, '#output .wx-typography h2', edge), new RegExp(`${palette.border}$`));
      if (theme === 'journal') assert.equal(computedRule(result.css, '#output .wx-typography blockquote', 'background'), palette.tint);
      else assert.match(computedRule(result.css, '#output .wx-typography blockquote', 'border-left'), new RegExp(`${palette.border}$`));
      assert.equal(computedRule(result.css, '#output .wx-typography .wx-alert', 'background'), palette.tint);
      for (const [selector, property] of [['#output .wx-typography', 'background'], ['#output .wx-typography .wx-code-block', 'background'], ['#output .wx-typography .wx-code-text', 'color'], ['#output .wx-typography .hljs-keyword', 'color'], ['#output .wx-typography .hljs-comment', 'color']]) {
        assert.equal(computedRule(result.css, selector, property), computedRule(base.css, selector, property), `${theme}/${palette.name} preserves ${selector}`);
      }
    }
    assert.equal(render(html, { theme, palette: 'not-a-palette' }).css, base.css);
  }
});

test('legacy default prose remains exact while palette changes only repaired table headers', () => {
  const html = '<h2>旧主题</h2><p>旧正文</p>';
  for (const palette of ['warm', 'blue', 'wechat', 'red', 'violet', 'ink']) {
    assert.deepEqual(prepareTypography(html, { theme: 'grace', palette }, document, highlighter), { html, css: '' });
    const withoutHeaderColor = css => css.replace(/(th \{ color: #ffffff !important; background: )#[\da-f]{6}/i, '$1HEADER');
    assert.equal(withoutHeaderColor(render(html, { theme: 'grace', palette, font_size: 18 }).css), withoutHeaderColor(render(html, { theme: 'grace', palette: 'warm', font_size: 18 }).css));
  }
});

test('legacy transformed code regains newlines, indentation and escaped text with a real caption', () => {
  const source = 'def run():\n    print("<ok> & done")\n\n    return 2\n';
  const html = '<pre class="hljs code__pre"><span class="mac-sign"><svg></svg></span><code class="language-python"><span class="code-block__inner" style="display:block"><span class="hljs-keyword">def</span>&nbsp;run():<br/>&nbsp;&nbsp;&nbsp;&nbsp;print(&quot;&lt;ok&gt; &amp; done&quot;)<br/><br/>&nbsp;&nbsp;&nbsp;&nbsp;return&nbsp;2<br/></span></code></pre>';
  const { holder, css } = render(html);
  const code = holder.querySelector('pre code');
  assert.equal(code.textContent, source);
  assert.equal(holder.querySelector('.wx-code-caption').textContent, 'Python');
  assert.equal(holder.querySelectorAll('.mac-sign,script,button,code ok').length, 0);
  assert.ok(code.querySelector('.hljs-keyword'));
  assert.match(computedRule(css, '#output .wx-typography .hljs-keyword', 'color'), /^#[0-9a-f]{6}$/i);
  assert.equal(computedRule(css, '#output .wx-typography .wx-code-text', 'white-space'), 'pre-wrap');
});

test('pending unknown code preserves available raw tabs and cannot turn HTML into elements', () => {
  const code = document.createElement('code');
  code.className = 'language-not-a-language';
  const source = '\t<widget>&literal;\n\t  next()\n';
  code.setAttribute('data-raw-code', source);
  code.setAttribute('data-language-pending', 'not-a-language');
  code.innerHTML = '<span class="code-block__inner">&nbsp;&nbsp;&nbsp;&nbsp;&lt;widget&gt;&amp;literal;<br/>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;next()<br/></span>';
  const { holder } = render(`<pre>${code.outerHTML}</pre>`);
  assert.equal(holder.querySelector('code').textContent, source);
  assert.equal(holder.querySelectorAll('widget').length, 0);
  assert.match(holder.querySelector('.wx-code-caption').textContent, /not-a-language/);
});

test('URI encoded original code wins over expanded renderer text and is removed from output', () => {
  const source = '\tprint("<tag> &lt; & quotes: \\\" ")\n\tpass\n';
  const code = document.createElement('code');
  code.className = 'language-python';
  code.setAttribute('data-source-code', encodeURIComponent(source));
  code.innerHTML = '<span class="code-block__inner">&nbsp;&nbsp;&nbsp;&nbsp;print("&lt;tag&gt; &amp;lt; &amp; quotes: \\\" ")<br/>&nbsp;&nbsp;&nbsp;&nbsp;pass<br/></span>';
  const { holder } = render(`<pre>${code.outerHTML}</pre>`);
  assert.equal(holder.querySelector('code').textContent, source);
  assert.equal(holder.querySelectorAll('[data-source-code],[data-raw-code]').length, 0);
});

test('unescaped legacy raw attribute entities and malformed URI metadata cannot change code meaning', () => {
  const old = '<pre><code class="language-missing" data-raw-code="print(&quot;&lt;tag&gt;&quot;)" data-source-code="%E0%A4%A"><span class="code-block__inner">print(&quot;&amp;lt;tag&amp;gt;&quot;)</span></code></pre>';
  const { holder } = render(old);
  assert.equal(holder.querySelector('code').textContent, 'print("&lt;tag&gt;")');
  assert.equal(holder.querySelectorAll('tag').length, 0);
});

test('original CRLF and tabs remain available as text even when HTML parsing normalizes highlighted output', () => {
  const source = 'function run() {\r\n\treturn "ok";\r\n}\r\n';
  const code = document.createElement('code');
  code.className = 'language-javascript';
  code.setAttribute('data-source-code', encodeURIComponent(source));
  code.textContent = 'function run() {\n    return "ok";\n}\n';
  const { holder } = render(`<pre>${code.outerHTML}</pre>`);
  assert.equal(holder.querySelector('code').textContent, source);
});

test('code wrap changes presentation without changing long code or adding duplicate captions', () => {
  const source = 'const url = "https://example.com/' + 'segment/'.repeat(30) + '";\n\tconsole.log(url);';
  const code = document.createElement('code');
  code.className = 'language-javascript';
  code.textContent = source;
  const initial = render(`<pre>${code.outerHTML}</pre>`, { code_wrap: 'wrap' });
  assert.equal(initial.holder.querySelector('code').textContent, source);
  assert.equal(computedRule(initial.css, '#output .wx-typography .wx-code-text', 'white-space'), 'pre-wrap');
  assert.equal(computedRule(initial.css, '#output .wx-typography .wx-code-text', 'overflow-wrap'), 'anywhere');
  const repeated = render(initial.html, { code_wrap: 'scroll' });
  assert.equal(repeated.holder.querySelector('code').textContent, source);
  assert.equal(repeated.holder.querySelectorAll('.wx-code-caption').length, 1);
  assert.equal(repeated.holder.querySelectorAll('.wx-typography').length, 1);
});

test('legacy explicit wrap overrides old horizontal box layout while preserving long code text', () => {
  const source = 'const id = "' + 'WWWWWWWWWW'.repeat(16) + '";\n\treturn id;';
  const original = document.createElement('code');
  original.className = 'language-javascript';
  original.setAttribute('data-source-code', encodeURIComponent(source));
  original.innerHTML = '<span class="code-block__inner">const&nbsp;id&nbsp;=&nbsp;&quot;' + 'WWWWWWWWWW'.repeat(16) + '&quot;;<br/>&nbsp;&nbsp;&nbsp;&nbsp;return&nbsp;id;</span>';
  const html = `<pre class="hljs code__pre">${original.outerHTML}</pre>`;
  const result = render(html, { theme: 'grace', code_wrap: 'wrap' });
  assert.equal(result.holder.querySelector('code').textContent, source);
  assert.ok(result.holder.querySelector('pre.wx-code-pre > code.wx-code-text'));
  for (const selector of ['#output .wx-typography .wx-code-pre', '#output .wx-typography .wx-code-text']) {
    assert.equal(computedRule(result.css, selector, 'display'), 'block');
    assert.equal(computedRule(result.css, selector, 'box-sizing'), 'border-box');
    assert.equal(computedRule(result.css, selector, 'width'), 'auto');
    assert.equal(computedRule(result.css, selector, 'min-width'), '0');
    assert.equal(computedRule(result.css, selector, 'max-width'), '100%');
    assert.equal(computedRule(result.css, selector, 'overflow-x'), 'hidden');
    assert.equal(computedRule(result.css, selector, 'white-space'), 'pre-wrap');
    assert.equal(computedRule(result.css, selector, 'overflow-wrap'), 'anywhere');
  }
  assert.equal(render(html, {theme:'grace'}).holder.querySelector('pre code').textContent, source);
});

test('existing diff line wrappers retain every plus/minus marker and line boundary', () => {
  const html = '<pre class="hljs code__pre"><code class="language-diff-python"><span class="code-block__inner" style="display:block"><span style="display:block;background:rgba(255,80,80,.18)"><span style="user-select:none">-</span>old = 1</span><span style="display:block;background:rgba(80,200,80,.18)"><span style="user-select:none">+</span>new = 2</span><span style="display:block"><span style="user-select:none"> </span>same()</span></span></code></pre>';
  const { holder } = render(html);
  assert.equal(holder.querySelector('code').textContent, '-old = 1\n+new = 2\n same()');
  assert.ok(holder.querySelector('.hljs-addition'));
  assert.ok(holder.querySelector('.hljs-deletion'));
  assert.match(holder.querySelector('.wx-code-caption').textContent, /Diff.*Python/i);
});

test('line number decoration is excluded from code text', () => {
  const html = '<pre><code class="language-bash"><section style="display:flex"><section class="line-numbers"><section>1</section><section>2</section></section><section class="code-scroll"><div style="white-space:pre">echo&nbsp;ok<br/>exit&nbsp;0</div></section></section></code></pre>';
  assert.equal(render(html).holder.querySelector('code').textContent, 'echo ok\nexit 0');
});

test('highlighter absence or thrown errors falls back to escaped plain code', () => {
  for (const hljs of [null, { getLanguage() { return true; }, highlight() { throw new Error('bad grammar'); } }]) {
    const { holder } = render('<pre><code class="language-python">x = &quot;&lt;script&gt;alert(1)&lt;/script&gt;&quot;\n</code></pre>', {}, hljs);
    assert.equal(holder.querySelector('code').textContent, 'x = "<script>alert(1)</script>"\n');
    assert.equal(holder.querySelectorAll('script,button').length, 0);
  }
});

test('auto turns multi-column prose into readable records without changing any cell contents', () => {
  const html = '<table><thead><tr><th>入口</th><th>适合什么情况</th><th>怎么用</th></tr></thead><tbody><tr><td>官方汇总脚本 <code>op_tune.sh</code></td><td>使用 AITER 源码仓库自带的输入 CSV，快速运行某类算子的测试或调优</td><td>选 <code>test</code> 或 <code>tune</code>，可指定算子类别</td></tr><tr><td>按算子的 tuner</td><td>要调自己模型的一批输入，或希望控制输出 CSV、比较方式和阈值</td><td>用 <code>-i</code> 给输入 CSV，用 <code>-o</code> 保存配置；Fused MoE 使用 <code>gemm_moe_tune.py</code></td></tr></tbody></table>';
  const result = render(html, { table_mode:'auto', table_font_size:12 });
  assert.equal(result.holder.querySelectorAll('table,.wx-table-scroll').length,0);
  const cards=[...result.holder.querySelectorAll('.wx-table-card')];
  assert.equal(cards.length,2);
  assert.deepEqual([...cards[0].querySelectorAll('.wx-table-key')].map(x=>x.textContent),['入口','适合什么情况','怎么用']);
  const original=document.createElement('div');original.innerHTML=html;
  assert.deepEqual([...result.holder.querySelectorAll('.wx-table-value')].map(x=>x.innerHTML),[...original.querySelectorAll('tbody td')].map(x=>x.innerHTML));
  assert.equal(result.holder.querySelector('code').textContent,'op_tune.sh');
  assert.equal(computedRule(result.css, '#output .wx-typography .wx-table-value', 'font-size'), '12px');
  const explicit=render(html,{table_mode:'scroll'});
  assert.equal(explicit.holder.querySelectorAll('table').length,1);
  assert.equal(explicit.holder.querySelectorAll('.wx-table-card').length,0);
});

test('auto keeps comparison data and two-column specs as balanced tables', () => {
  for (const html of [
    '<table><tr><th>型号</th><th>精度</th><th>吞吐</th></tr><tr><td>AMD Instinct</td><td>BF16</td><td>256</td></tr></table>',
    '<table><tr><th>项目</th><th>说明</th></tr><tr><td>处理器</td><td>AMD 锐龙 AI Max+ PRO 495，16 核 32 线程，最高加速频率 5.2GHz</td></tr></table>',
  ]) {
    const result=render(html);
    assert.equal(result.holder.querySelectorAll('table').length,1);
    assert.equal(result.holder.querySelectorAll('.wx-table-card').length,0);
    const cells=[...result.holder.querySelectorAll('tr:first-child th')];
    for(const cell of cells) assert.ok(parseFloat(cell.style.width)>=20,'No column can be squeezed into a strip');
  }
});

test('preparing automatic column widths twice cannot turn them into authored scroll geometry', () => {
  const html='<table><tr><th>项目</th><th>配置</th></tr><tr><td>内存</td><td>192GB</td></tr></table>';
  const first=render(html),second=render(first.html);
  assert.equal(second.holder.querySelectorAll('.wx-table-scroll').length,0);
  assert.ok(second.holder.querySelector('table.wx-table-fit'));
  assert.equal(first.holder.textContent,second.holder.textContent);
  assert.deepEqual([...first.holder.querySelectorAll('th,td')].map(x=>x.style.width),[...second.holder.querySelectorAll('th,td')].map(x=>x.style.width));
});

test('automatic legacy record cards retain their styles through the editor fallback pass', () => {
  const html='<table><tr><th>入口</th><th>说明</th><th>操作</th></tr><tr><td>脚本</td><td>使用源码仓库自带的输入数据，快速运行某类算子的测试或调优</td><td>运行命令</td></tr></table>';
  for(const theme of ['grace','default','simple']) {
    const first=render(html,{theme}),second=render(first.html,{theme});
    assert.ok(second.holder.querySelector('.wx-table-card'));
    assert.equal(second.holder.textContent,first.holder.textContent);
    assert.equal(computedRule(second.css,'#output .wx-typography .wx-table-key','display'),'block');
    assert.equal(computedRule(second.css,'#output .wx-typography .wx-table-value','font-size'),'16px');
  }
});

test('small tables fit naturally while wide auto tables get one responsive scroll area', () => {
  const small = '<table><thead><tr><th>项目</th><th>值</th></tr></thead><tbody><tr><td>批量</td><td>4</td></tr></tbody></table>';
  const compact = render(small);
  assert.equal(compact.holder.querySelectorAll('.wx-table-scroll,.wx-table-hint').length, 0);
  assert.equal(compact.holder.querySelectorAll('table tr').length, 2);
  const wide = '<section style="max-width:100%;overflow:auto"><table><thead><th>模型完整名称</th><th>启动路径</th><th>执行环境</th><th>详细说明</th></thead><tbody><tr><td><a href="https://example.com">模型</a></td><td><code>/a/long/path/to/model</code></td><td>Linux</td><td><em>保留说明</em></td></tr></tbody></table></section>';
  const wideResult = render(wide);
  assert.equal(wideResult.holder.querySelectorAll('.wx-table-scroll').length, 1);
  assert.equal(wideResult.holder.querySelectorAll('.wx-table-hint').length, 0);
  assert.ok(wideResult.holder.querySelector('.wx-table-auto'));
  assert.equal(wideResult.holder.querySelector('table a').getAttribute('href'), 'https://example.com');
  assert.equal(wideResult.holder.querySelector('table em').textContent, '保留说明');
  assert.equal(computedRule(wideResult.css, '#output .wx-typography .wx-table-scroll', 'overflow-x'), 'auto');
});

test('auto fit tables wrap wide Latin runs while explicit scroll preserves natural width', () => {
  const word = 'WWWWWWWWWWWWWWW';
  const html = `<table><thead><tr><th>${word}</th><th>${word}</th></tr></thead><tbody><tr><td>${word}</td><td><a href="https://example.com">${word}</a></td></tr></tbody></table>`;
  const compact = render(html);
  const table = compact.holder.querySelector('table');
  assert.ok(table.matches('.wx-table-fit'));
  assert.equal(compact.holder.querySelectorAll('.wx-table-scroll').length, 0);
  assert.equal(computedRule(compact.css, '#output .wx-typography .wx-table-fit', 'table-layout'), 'fixed');
  assert.equal(computedRule(compact.css, '#output .wx-typography .wx-table-fit', 'width'), '100%');
  assert.equal(computedRule(compact.css, '#output .wx-typography .wx-table-fit th', 'overflow-wrap'), 'anywhere');
  assert.equal(computedRule(compact.css, '#output .wx-typography .wx-table-fit td', 'overflow-wrap'), 'anywhere');
  assert.deepEqual([...table.querySelectorAll('th,td')].map((cell) => cell.textContent), [word, word, word, word]);
  assert.equal(table.querySelector('a').getAttribute('href'), 'https://example.com');
  const wide = render(html, { table_mode: 'scroll' });
  assert.ok(wide.holder.querySelector('.wx-table-scroll table'));
  assert.equal(wide.holder.querySelectorAll('.wx-table-fit').length, 0);
  assert.equal(computedRule(wide.css, '#output .wx-typography table', 'table-layout'), 'auto');
  assert.equal(computedRule(wide.css, '#output .wx-typography .wx-table-scroll td', 'white-space'), 'nowrap');
  assert.deepEqual([...wide.holder.querySelectorAll('th,td')].map((cell) => cell.textContent), [word, word, word, word]);
});

test('table size controls cover cells, cards and nested text at the chosen minimum', () => {
  const html = '<table><thead><tr><th>项目</th><th>内容</th></tr></thead><tbody><tr><td style="font-size:10px!important">模型</td><td><p style="font-size:14px"><span style="font-size:8px!important">详细说明</span> <code style="font-size:9px">batch_size=4</code></p></td></tr></tbody></table>';
  for (const theme of ['technical', 'obsidian', 'deepsea', 'teal', 'grace']) {
    for (const table_mode of ['auto', 'scroll', 'cards']) {
      const size = theme === 'grace' ? 12 : 16;
      const result = render(html, { theme, table_mode, table_font_size: size });
      assert.match(result.holder.textContent, /详细说明/);
      assert.match(result.holder.textContent, /batch_size=4/);
      for (const selector of ['#output .wx-typography th', '#output .wx-typography td', '#output .wx-typography th *', '#output .wx-typography td *', '#output .wx-typography .wx-table-key', '#output .wx-typography .wx-table-value', '#output .wx-typography .wx-table-value *']) {
        assert.equal(computedRule(result.css, selector, 'font-size'), `${size}px`, `${theme}/${table_mode}: ${selector}`);
      }
      for (const cell of result.holder.querySelectorAll('th,td,th *,td *,.wx-table-key,.wx-table-key *,.wx-table-value,.wx-table-value *')) assert.equal(cell.style.getPropertyValue('font-size') || '', '');
    }
  }
  const minimum = render(html, { table_font_size: 12 });
  assert.equal(computedRule(minimum.css, '#output .wx-typography td code', 'font-size'), '12px');
});

test('table text keeps its minimum while code blocks have independent publishing sizes', () => {
  const html = '<table><tr><th>代码</th><th>结束</th></tr><tr><td><pre><code class="language-python">return 42</code></pre></td><td>LAST</td></tr></table>';
  for (const table_mode of ['auto', 'scroll', 'cards']) {
    for (const size of [12, 16]) {
      const result = render(html, { table_mode, table_font_size: size });
      for (const element of result.holder.querySelectorAll('th,td,th *,td *,.wx-table-key,.wx-table-value,.wx-table-value *')) {
        if(element.closest('.wx-code-block')) continue;
        assert.ok(Number.parseFloat(resolvedRule(result.css, element, 'font-size')) >= size, `${table_mode}/${size}: ${element.tagName}.${element.className} uses ${resolvedRule(result.css, element, 'font-size')}`);
      }
      assert.equal(computedRule(result.css,'#output .wx-typography .wx-code-pre','font-size'),'12px');
    }
  }
});

test('wide scroll tables keep every column and bottom row reachable without hidden clipping', () => {
  const url = 'https://example.com/' + 'very-long-path-'.repeat(50) + 'last-path';
  const html = `<section style="overflow:hidden;max-height:120px"><table style="overflow:hidden;max-height:100px"><thead><tr><th>首列</th><th>链接</th><th>代码</th><th>最后一列</th></tr></thead><tbody><tr><td>第一行</td><td><a href="${url}">${url}</a></td><td><code>${'long_token'.repeat(25)}</code></td><td>RIGHT_EDGE</td></tr><tr><td>最后一行</td><td>END_LINK</td><td>END_CODE</td><td>BOTTOM_RIGHT</td></tr></tbody></table></section>`;
  const { holder, css } = render(html, { table_mode: 'scroll' });
  assert.equal(holder.querySelectorAll('table tr').length, 3);
  assert.equal(holder.querySelector('table a').getAttribute('href'), url);
  assert.equal(holder.querySelector('tbody tr:last-child td:last-child').textContent, 'BOTTOM_RIGHT');
  assert.equal(computedRule(css, '#output .wx-typography .wx-table-scroll', 'overflow-x'), 'auto');
  assert.equal(computedRule(css, '#output .wx-typography .wx-table-scroll', 'overflow-y'), 'auto');
  assert.equal(computedRule(css, '#output .wx-typography .wx-table-scroll table', 'width'), 'max-content');
  assert.equal(computedRule(css, '#output .wx-typography .wx-table-scroll table', 'overflow'), 'visible');
  assert.equal(computedRule(css, '#output .wx-typography .wx-table-scroll table', 'max-height'), 'none');
  assert.equal(computedRule(css, '#output .wx-typography .wx-table-scroll td', 'overflow'), 'visible');
  assert.equal(holder.querySelectorAll('section[style*="overflow:hidden"]').length, 0);
});

test('table transforms preserve nonempty text nodes before and after an article table', () => {
  const html = '<section>表前必须保留<table><thead><tr><th>Key</th></tr></thead><tbody><tr><td>value</td></tr></tbody></table>表后必须保留</section>';
  for (const table_mode of ['auto', 'scroll', 'cards']) {
    const result = render(html, { table_mode });
    assert.match(result.holder.textContent, /^表前必须保留/);
    assert.match(result.holder.textContent, /表后必须保留$/);
    assert.match(result.holder.textContent, /value/);
  }
});

test('sole table wrapper chains cannot clip rows and cleanup stops before article text', () => {
  const html = '<div style="height:32px;overflow:hidden"><section style="max-height:20px;overflow-y:hidden"><div style="height:16px;white-space:nowrap"><table><tr><th>Key</th></tr><tr><td>ROW_ONE</td></tr><tr><td>ROW_TWO</td></tr><tr><td>LAST_ROW</td></tr></table></div></section></div>';
  for (const table_mode of ['auto', 'scroll', 'cards']) {
    const result = render(html, { table_mode });
    assert.match(result.holder.textContent, /ROW_ONE/);
    assert.match(result.holder.textContent, /ROW_TWO/);
    assert.match(result.holder.textContent, /LAST_ROW/);
    for (const wrapper of result.holder.querySelectorAll('div[style],section[style]')) {
      for (const property of ['height', 'max-height', 'overflow', 'overflow-y', 'white-space']) assert.equal(wrapper.style.getPropertyValue(property) || '', '', `${table_mode} wrapper ${property}`);
    }
  }
  const mixed = render('<section style="height:80px;overflow:hidden">表前正文<div style="height:20px;overflow:hidden"><table><tr><th>Key</th></tr><tr><td>LAST_ROW</td></tr></table></div>表后正文</section>');
  const article = mixed.holder.querySelector('.wx-typography > section');
  assert.equal(article.style.getPropertyValue('height'), '80px', 'Do not alter an article section with meaningful neighboring content');
  assert.match(article.textContent, /^表前正文/);
  assert.match(article.textContent, /表后正文$/);
  assert.equal(article.querySelector('div').style.getPropertyValue('height') || '', '');
});

test('authored grid widths and column groups use scrolling instead of forcing a narrow fit', () => {
  const tables = [
    '<table><colgroup><col width="800"><col width="800"></colgroup><tr><th>A</th><th>B</th></tr><tr><td>one</td><td>LAST</td></tr></table>',
    '<table style="width:1600px"><tr><th>A</th><th>B</th></tr><tr><td>one</td><td>LAST</td></tr></table>',
    '<table><tr><th style="width:800px">A</th><th style="min-width:800px">B</th></tr><tr><td>one</td><td>LAST</td></tr></table>',
  ];
  for (const html of tables) {
    for (const table_mode of ['auto', 'cards']) {
      const result = render(html, { table_mode });
      assert.ok(result.holder.querySelector('.wx-table-scroll table'));
      assert.equal(result.holder.querySelectorAll('.wx-table-fit,.wx-table-card').length, 0);
      assert.equal(result.holder.querySelector('tr:last-child td:last-child').textContent, 'LAST');
      if (html.includes('<colgroup>')) assert.deepEqual([...result.holder.querySelectorAll('col')].map((col) => col.getAttribute('width')), ['800', '800']);
      if (html.includes('width:1600px')) assert.match(result.holder.querySelector('table').getAttribute('style'), /width:\s*1600px/);
      if (html.includes('width:800px')) assert.match(result.holder.querySelector('th').getAttribute('style'), /width:\s*800px/);
    }
  }
});

test('auto tables scroll intrinsically wide code or images while manual cards keep contained code', () => {
  for (const content of ['<pre><code>WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW</code></pre>', '<img src="wide.png" width="1600" height="800" alt="完整宽图">']) {
    const html = `<table><tr><th>A</th><th>B</th></tr><tr><td>${content}</td><td>LAST</td></tr></table>`;
    const automatic = render(html);
    assert.ok(automatic.holder.querySelector('.wx-table-scroll table'));
    assert.equal(automatic.holder.querySelectorAll('.wx-table-fit').length, 0);
    assert.match(automatic.holder.textContent, /LAST/);
    const cards = render(html, { table_mode: 'cards' });
    assert.equal(cards.holder.querySelectorAll('.wx-table-card').length, 1);
    assert.match(cards.holder.textContent, /LAST/);
  }
});

test('cards contain long links, code, images and nested blocks while preserving all content', () => {
  const token = 'UNBROKEN'.repeat(40);
  const html = `<table><thead><tr><th>项目</th><th>详细内容</th></tr></thead><tbody><tr><td>配置</td><td><div style="width:1000px"><p><a href="https://example.com/${token}">${token}</a></p><pre><code>${token}\nsecond line</code></pre><figure style="width:900px"><img src="image.png" width="800" height="400" alt="图1 完整图片"><figcaption>完整图片</figcaption></figure></div></td></tr><tr><td>末行</td><td>ALL_ROWS_END</td></tr></tbody></table>`;
  const { holder, css } = render(html, { table_mode: 'cards', table_font_size: 12 });
  assert.equal(holder.querySelectorAll('.wx-table-card').length, 2);
  assert.equal(holder.querySelector('.wx-table-value pre code').textContent, `${token}\nsecond line`);
  assert.equal(holder.querySelector('.wx-table-value img').getAttribute('src'), 'image.png');
  assert.match(holder.textContent, /ALL_ROWS_END/);
  assert.equal(computedRule(css, '#output .wx-typography .wx-table-value *', 'max-width'), '100%');
  assert.equal(computedRule(css, '#output .wx-typography .wx-table-value *', 'overflow-wrap'), 'anywhere');
  assert.equal(computedRule(css, '#output .wx-typography .wx-table-value pre code', 'white-space'), 'pre-wrap');
  assert.equal(computedRule(css, '#output .wx-typography .wx-table-value img', 'height'), 'auto');
  assert.equal(computedRule(css, '#output .wx-typography .wx-table-value figure', 'margin'), '8px 0');
});

test('cards repeat column headings and preserve links, emphasis, empty cells and all data rows', () => {
  const html = '<table><caption>配置清单</caption><thead><tr><th>项目</th><th>值</th><th>说明</th></tr></thead><tbody><tr><td><strong>模型 A</strong></td><td><a href="https://example.com/a">下载</a></td><td><em>第一项</em></td></tr><tr><td>模型 B</td><td></td><td>第二项</td></tr></tbody></table>';
  const { holder } = render(html, { table_mode: 'cards', theme: 'journal' });
  const cards = [...holder.querySelectorAll('.wx-table-card')];
  assert.equal(cards.length, 2);
  assert.deepEqual([...cards[0].querySelectorAll('.wx-table-key')].map((el) => el.textContent), ['项目', '值', '说明']);
  assert.deepEqual([...cards[1].querySelectorAll('.wx-table-value')].map((el) => el.textContent), ['模型 B', '', '第二项']);
  assert.equal(cards[0].querySelector('a').getAttribute('href'), 'https://example.com/a');
  assert.equal(cards[0].querySelector('strong').textContent, '模型 A');
  assert.equal(cards[0].querySelector('em').textContent, '第一项');
  assert.equal(holder.querySelector('.wx-table-caption').textContent, '配置清单');
  assert.equal(holder.querySelectorAll('table').length, 0);
});

test('complex merged or nested table cells fall back to scrolling without losing table structure', () => {
  for (const html of ['<table><tr><th>分组</th><th>值</th></tr><tr><td rowspan="2">A</td><td>1</td></tr><tr><td>2</td></tr></table>', '<table><tr><th>A</th></tr><tr><td><table><tr><td>nested</td></tr></table></td></tr></table>']) {
    const { holder } = render(html, { table_mode: 'cards' });
    assert.ok(holder.querySelector('.wx-table-scroll table'));
    assert.equal(holder.querySelectorAll('.wx-table-card').length, 0);
    assert.match(holder.textContent, /A/);
  }
});

test('escaped table markup inside code is never transformed into article tables', () => {
  const { holder } = render('<pre><code class="language-html">&lt;table&gt;\n&lt;tr&gt;&lt;td&gt;content&lt;/td&gt;&lt;/tr&gt;\n&lt;/table&gt;</code></pre>', { table_mode: 'cards' });
  assert.equal(holder.querySelectorAll('table,.wx-table-cards,.wx-table-hint').length, 0);
  assert.equal(holder.querySelector('code').textContent, '<table>\n<tr><td>content</td></tr>\n</table>');
});

test('alerts have readable headings without duplicating existing markdown alert titles', () => {
  const { holder, css } = render('<blockquote><p>[!NOTE]<br>中文提示 <strong>保留重点</strong></p></blockquote><blockquote class="markdown-alert markdown-alert-warning"><p class="markdown-alert-title">Warning</p><p>风险说明</p></blockquote>');
  assert.equal(holder.querySelectorAll('.wx-alert').length, 2);
  assert.equal(holder.querySelectorAll('.wx-alert-title').length, 2);
  assert.equal(holder.querySelector('.wx-alert strong').textContent, '保留重点');
  assert.doesNotMatch(holder.textContent, /\[!NOTE\]/);
  assert.equal(computedRule(css, '#output .wx-typography .wx-alert', 'font-style'), 'normal');
  assert.equal(holder.querySelectorAll('script,button').length, 0);
});

test('raw Sphinx note warning and tip blocks become alerts without losing their existing titles or content', () => {
  const html = '<div class="admonition note"><p class="admonition-title">Note</p><p>保留 <strong>重点</strong> 和 <a href="https://example.com/docs">来源</a>。</p></div><div class="admonition warning"><p class="admonition-title">Warning</p><p>检查实验条件。</p><div class="admonition tip"><p class="admonition-title">Tip</p><p>记录完整环境。</p></div></div>';
  for (const theme of ['technical', 'minimal', 'journal', 'obsidian', 'deepsea', 'teal']) {
    const result = render(html, { theme });
    assert.equal(result.holder.querySelectorAll('.wx-alert').length, 3);
    for (const [kind, title] of [['note', 'Note'], ['warning', 'Warning'], ['tip', 'Tip']]) {
      const alert = result.holder.querySelector(`.admonition.${kind}`);
      assert.ok(alert.classList.contains(`wx-alert-${kind}`));
      assert.equal([...alert.children].filter((element) => element.classList.contains('wx-alert-title')).length, 1);
      assert.equal([...alert.children].find((element) => element.classList.contains('wx-alert-title')).textContent, title);
    }
    assert.equal(result.holder.querySelector('.wx-alert-note strong').textContent, '重点');
    assert.equal(result.holder.querySelector('.wx-alert-note a').getAttribute('href'), 'https://example.com/docs');
    const repeated = render(result.html, { theme });
    assert.equal(repeated.holder.querySelectorAll('.wx-alert-title').length, 3);
    assert.equal(repeated.holder.textContent, result.holder.textContent);
  }
  assert.deepEqual(prepareTypography(html, { theme: 'grace' }, document, highlighter), { html, css: '' });
});

test('Sphinx title deduplication removes duplicate heading elements while retaining body words and code examples', () => {
  const html = '<div class="admonition note"><p class="admonition-title">Note</p><p class="admonition-title">Note</p><p>Note 是说明正文中的单词。</p></div><pre><code class="language-html">&lt;div class="admonition warning"&gt;example&lt;/div&gt;</code></pre>';
  const { holder } = render(html);
  assert.equal(holder.querySelector('.admonition').querySelectorAll('.admonition-title').length, 1);
  assert.match(holder.querySelector('.admonition').textContent, /Note 是说明正文中的单词/);
  assert.equal(holder.querySelector('pre code').textContent, '<div class="admonition warning">example</div>');
  assert.equal(holder.querySelectorAll('.wx-alert').length, 1);
  assert.equal(holder.querySelectorAll('script,button').length, 0);
});
