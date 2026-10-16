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

test('only safe typography options survive normalization and legacy gets its original size', () => {
  assert.deepEqual(normalizeTypography({}), { font_family: 'theme', font_size: 17, code_wrap: 'scroll', table_mode: 'auto' });
  for (const theme of ['technical', 'journal', 'minimal']) assert.equal(normalizeTypography(null, theme).font_size, 17);
  for (const theme of ['default', 'grace', 'simple', 'classic']) assert.equal(normalizeTypography({}, theme).font_size, 16);
  assert.deepEqual(normalizeTypography({ font_family: 'serif', font_size: '18', code_wrap: 'wrap', table_mode: 'cards', extra: 'ignored' }), { font_family: 'serif', font_size: 18, code_wrap: 'wrap', table_mode: 'cards' });
  assert.deepEqual(normalizeTypography({ font_family: 'evil;url()', font_size: '17px;color:red', code_wrap: '__proto__', table_mode: [] }), { font_family: 'theme', font_size: 17, code_wrap: 'scroll', table_mode: 'auto' });
  assert.equal(normalizeTypography({ font_size: true }).font_size, 17);
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
