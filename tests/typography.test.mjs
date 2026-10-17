import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { normalizeTypography, prepareTypography } from '../frontend/typography.mjs';

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
  assert.deepEqual(normalizeTypography({}), { font_family: 'theme', font_size: 17, code_wrap: 'scroll', table_mode: 'auto', caption_font_size: 12, table_font_size: 13 });
  for (const theme of ['technical', 'journal', 'minimal', 'obsidian', 'deepsea', 'teal']) assert.equal(normalizeTypography(null, theme).font_size, 17);
  for (const theme of ['default', 'grace', 'simple', 'classic']) assert.equal(normalizeTypography({}, theme).font_size, 16);
  assert.deepEqual(normalizeTypography({ font_family: 'serif', font_size: '18', code_wrap: 'wrap', table_mode: 'cards', extra: 'ignored' }), { font_family: 'serif', font_size: 18, code_wrap: 'wrap', table_mode: 'cards', caption_font_size: 12, table_font_size: 13 });
  assert.deepEqual(normalizeTypography({ font_family: 'evil;url()', font_size: '17px;color:red', code_wrap: '__proto__', table_mode: [] }), { font_family: 'theme', font_size: 17, code_wrap: 'scroll', table_mode: 'auto', caption_font_size: 12, table_font_size: 13 });
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
    assert.deepEqual(prepareTypography(html, { theme }, document, highlighter), { html, css: '' });
    assert.deepEqual(prepareTypography(html, { theme, caption_font_size: 13, table_font_size: 16 }, document, highlighter), { html, css: '' });
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
    { theme: 'obsidian', paper: '#111b22', ink: '#e6edf3', code: '#0b141c' },
    { theme: 'deepsea', paper: '#f1f8f8', ink: '#15383d', code: '#102e35' },
    { theme: 'teal', paper: '#ffffff', ink: '#183b36', code: '#e9f5ef' },
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
    assert.equal(result.holder.querySelectorAll('figure + p').length, 1);
    assert.equal(result.holder.querySelector('figure + p').textContent, '这里是普通正文，必须保留。');
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
  assert.equal(holder.querySelector('figure:last-of-type + p').textContent, '图1展示了另一项实验结果，作为普通正文保留。');
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
  assert.equal(holder.querySelectorAll('figure + p').length, 3);
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

test('legacy default HTML and stylesheet remain byte for byte untouched', () => {
  const html = '<section class="container"><p style="font-size:16px">旧文</p><pre class="hljs code__pre"><code>x<br/>y</code></pre></section>';
  assert.deepEqual(prepareTypography(html, { theme: 'grace' }, document, highlighter), { html, css: '' });
});

test('changing only legacy font size keeps the legacy theme font and code representation', () => {
  const { holder, css } = render('<p>旧文章字体</p><pre class="hljs code__pre"><code>x<br>y</code></pre>', { theme: 'grace', font_size: 18 });
  assert.equal(computedRule(css, '#output .wx-typography', 'font-family'), undefined);
  assert.equal(computedRule(css, '#output .wx-typography p', 'font-size'), '18px');
  assert.equal(holder.querySelector('pre code').innerHTML, 'x<br>y');
  assert.equal(holder.querySelectorAll('.wx-code-caption').length, 0);
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

test('new theme palettes color article accents while preserving paper and code contrast', () => {
  const palettes = [
    { name: 'blue', text: '#2563eb', border: '#2563eb', tint: '#eff6ff' },
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

test('palette handling leaves legacy theme CSS and default raw HTML unchanged', () => {
  const html = '<h2>旧主题</h2><p>旧正文</p>';
  for (const palette of ['warm', 'blue', 'wechat', 'red', 'violet', 'ink']) {
    assert.deepEqual(prepareTypography(html, { theme: 'grace', palette }, document, highlighter), { html, css: '' });
    assert.equal(render(html, { theme: 'grace', palette, font_size: 18 }).css, render(html, { theme: 'grace', palette: 'warm', font_size: 18 }).css);
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
  assert.equal(computedRule(css, '#output .wx-typography .wx-code-text', 'white-space'), 'pre');
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
  assert.deepEqual(prepareTypography(html, { theme: 'grace' }, document, highlighter), { html, css: '' });
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

test('small tables fit naturally while wide tables get one contained scroll area and visible hint', () => {
  const small = '<table><thead><tr><th>项目</th><th>值</th></tr></thead><tbody><tr><td>批量</td><td>4</td></tr></tbody></table>';
  const compact = render(small);
  assert.equal(compact.holder.querySelectorAll('.wx-table-scroll,.wx-table-hint').length, 0);
  assert.equal(compact.holder.querySelectorAll('table tr').length, 2);
  const wide = '<section style="max-width:100%;overflow:auto"><table><thead><th>模型完整名称</th><th>启动路径</th><th>执行环境</th><th>详细说明</th></thead><tbody><tr><td><a href="https://example.com">模型</a></td><td><code>/a/long/path/to/model</code></td><td>Linux</td><td><em>保留说明</em></td></tr></tbody></table></section>';
  const wideResult = render(wide);
  assert.equal(wideResult.holder.querySelectorAll('.wx-table-scroll').length, 1);
  assert.equal(wideResult.holder.querySelectorAll('.wx-table-hint').length, 1);
  assert.match(wideResult.holder.querySelector('.wx-table-hint').textContent, /左右滑动/);
  assert.equal(wideResult.holder.querySelector('table a').getAttribute('href'), 'https://example.com');
  assert.equal(wideResult.holder.querySelector('table em').textContent, '保留说明');
  assert.equal(computedRule(wideResult.css, '#output .wx-typography .wx-table-scroll', 'overflow-x'), 'auto');
});

test('auto fit tables break wide Latin runs inside fixed columns while explicit scroll preserves natural width', () => {
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

test('table code blocks and language captions obey the table minimum after CSS specificity', () => {
  const html = '<table><tr><th>代码</th><th>结束</th></tr><tr><td><pre><code class="language-python">return 42</code></pre></td><td>LAST</td></tr></table>';
  for (const table_mode of ['auto', 'scroll', 'cards']) {
    for (const size of [12, 16]) {
      const result = render(html, { table_mode, table_font_size: size });
      for (const element of result.holder.querySelectorAll('th,td,th *,td *,.wx-table-key,.wx-table-value,.wx-table-value *')) {
        assert.ok(Number.parseFloat(resolvedRule(result.css, element, 'font-size')) >= size, `${table_mode}/${size}: ${element.tagName}.${element.className} uses ${resolvedRule(result.css, element, 'font-size')}`);
      }
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
