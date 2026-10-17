import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { prepareRichMarkdown, renderRichContent, rasterizeSvg } from '../frontend/rich-content.mjs';
import { loadRichRuntime } from '../frontend/rich-runtime.mjs';

const makeDocument = () => parseHTML('<html><head></head><body></body></html>').document;
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40" viewBox="0 0 120 40"><text x="5" y="25">合成 SVG</text></svg>';
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOwqdj3HwAE2AJywnY5xAAAAABJRU5ErkJggg==', 'base64'));
const pendingDiagram = '<div class="mermaid-diagram" data-md-diagram-state="loading">图表加载中</div>';
const markdown = '# 合成文章\n\n```mermaid\ngraph TD\n  A[开始] --> B[结束]\n```\n';
const codes = result => result.issues.map(issue => issue.code);
const fakeRasterizer = async () => PNG.slice();

test('render-only Mermaid source survives sanitizer XML attribute checks',async()=>{
  const prepared=prepareRichMarkdown(markdown);
  const doc=makeDocument(),host=doc.createElement('div');host.innerHTML=prepared;
  const marker=host.querySelector('[data-mermaid-source]');
  assert.equal(marker.getAttribute('data-rich-source-encoding'),'uri');
  assert.equal(decodeURIComponent(marker.getAttribute('data-mermaid-source')).trim(),'graph TD\n  A[开始] --> B[结束]');
  let received='';const result=await renderRichContent(prepared,{document:doc,markdown,mermaid:{initialize(){},render:async(_,source)=>{received=source;return{svg:SVG}}},rasterizeSvg:fakeRasterizer});
  assert.equal(result.ready,true);assert.match(received,/A\[开始\] --> B\[结束\]/);
});

test('Mermaid PNG export awaits renderer and preserves adjacent prose and original code text', async () => {
  const document = makeDocument();
  const calls = [];
  const mermaid = {
    initialize(config) { calls.push(config); },
    async render(id, source) { calls.push({ id, source }); return { svg: SVG, bindFunctions() { assert.fail('No click handlers may be bound'); } }; },
  };
  const html = '<p>正文</p>' + pendingDiagram + '<pre><code>print("按装 $x$ &lt;tag&gt;")\n\tend</code></pre>';
  const result = await renderRichContent(html, { document, markdown, mermaid, rasterizeSvg: fakeRasterizer });
  assert.equal(result.ready, true);
  assert.equal(result.assets.length, 1);
  assert.match(result.assets[0].name, /^rich-mermaid-[a-f0-9]{24}\.png$/);
  assert.equal(result.assets[0].mime, 'image/png');
  assert.deepEqual(result.assets[0].bytes, PNG);
  assert.equal(markdown.slice(result.assets[0].source.from, result.assets[0].source.to), result.assets[0].source.text);
  assert.ok(result.assets[0].source.text.includes('graph TD'));
  const output = makeDocument().createElement('div'); output.innerHTML = result.html;
  assert.equal(output.querySelector('pre code').textContent, 'print("按装 $x$ <tag>")\n\tend');
  assert.equal(output.querySelector('p').textContent, '正文');
  assert.equal(output.querySelector('img').getAttribute('src'), result.assets[0].name);
  assert.equal(calls[0].securityLevel, 'strict');
  assert.equal(calls[0].flowchart.htmlLabels, false);
});

test('asset names and source positions remain deterministic across repeated renders', async () => {
  const mermaid = { initialize() {}, async render() { return { svg: SVG }; } };
  const one = await renderRichContent(pendingDiagram, { document: makeDocument(), markdown, mermaid, rasterizeSvg: fakeRasterizer });
  const two = await renderRichContent(pendingDiagram, { document: makeDocument(), markdown, mermaid, rasterizeSvg: fakeRasterizer });
  assert.equal(one.assets[0].name, two.assets[0].name);
  assert.equal(one.assets[0].sha256, two.assets[0].sha256);
  assert.deepEqual(one.assets[0].source, two.assets[0].source);
});

test('missing renderer leaves a blocker and preserves the existing preview', async () => {
  const result = await renderRichContent(pendingDiagram, { document: makeDocument(), markdown, rasterizeSvg: fakeRasterizer });
  assert.equal(result.ready, false);
  assert.ok(codes(result).includes('rich-renderer-missing'));
  assert.ok(result.html.includes('图表加载中'));
  assert.equal(result.assets.length, 0);
});

test('ambiguous loading diagram source mapping never associates a wrong fence', async () => {
  const result = await renderRichContent(pendingDiagram + pendingDiagram, { document: makeDocument(), markdown, mermaid: { render() { assert.fail('Ambiguous source must not render'); } } });
  assert.equal(result.ready, false);
  assert.ok(codes(result).includes('rich-source-missing'));
});

test('MathJax receives decoded math without delimiters and preserves Markdown offsets', async () => {
  const document = makeDocument();
  const source = '😀\r\n公式 $x \\lt y & z$。';
  const calls = [];
  const mathjax = {
    startup: { promise: Promise.resolve() },
    texReset() {},
    tex2svg(tex, options) { calls.push({ tex, options }); const holder = document.createElement('div'); holder.innerHTML = SVG; return holder; },
  };
  const html = '<p>公式 <span class="katex-inline katex-pending" data-math-display="false" data-math-raw="$x \\lt y &amp; z$">…</span>。</p>';
  const result = await renderRichContent(html, { document, markdown: source, mathjax, rasterizeSvg: fakeRasterizer });
  assert.equal(result.ready, true);
  assert.equal(calls[0].tex, 'x \\lt y & z');
  assert.equal(calls[0].options.display, false);
  assert.equal(source.slice(result.assets[0].source.from, result.assets[0].source.to), '$x \\lt y & z$');
  assert.equal(result.assets[0].source.kind, 'math');
});

test('math startup and document fonts are ready before rasterization; failure is explicit', async () => {
  const document = makeDocument();
  let releaseMath, releaseFonts;
  const startup = new Promise(resolve => { releaseMath = resolve; });
  Object.defineProperty(document, 'fonts', { value: { ready: new Promise(resolve => { releaseFonts = resolve; }) } });
  let drawn = false;
  const holder = document.createElement('div'); holder.innerHTML = SVG;
  const mathjax = { startup: { promise: startup }, tex2svg() { return holder; } };
  const resultPromise = renderRichContent('<span class="math">$x$</span>', { document, markdown: '$x$', mathjax, rasterizeSvg: async () => { drawn = true; return PNG; } });
  await Promise.resolve(); assert.equal(drawn, false);
  releaseMath(); await Promise.resolve(); assert.equal(drawn, false);
  releaseFonts();
  assert.equal((await resultPromise).ready, true);
  assert.equal(drawn, true);
  const failed = await renderRichContent('<span class="math">$x$</span>', { document, markdown: '$x$', mathjax: { startup: { promise: Promise.reject(new Error('synthetic-secret')) }, tex2svg() { assert.fail(); } }, rasterizeSvg: fakeRasterizer });
  assert.equal(failed.ready, false);
  assert.equal(JSON.stringify(failed).includes('synthetic-secret'), false);
});

test('explicit SVG preview avoids rasterization while keeping only safe inline SVG', async () => {
  const result = await renderRichContent(pendingDiagram, { document: makeDocument(), markdown, mode: 'svg', mermaid: { initialize() {}, async render() { return { svg: SVG }; } }, rasterizeSvg() { assert.fail('SVG mode must not rasterize'); } });
  assert.equal(result.ready, true);
  assert.equal(result.assets.length, 0);
  assert.equal(result.renderedCount, 1);
  assert.ok(result.html.includes('<svg'));
  assert.equal(result.html.includes('loading'), false);
});

test('already rendered safe math SVG converts without starting a second renderer', async () => {
  const html = `<span class="katex-inline" data-math-raw="$x$" data-math-display="false">${SVG}</span>`;
  const result = await renderRichContent(html, { document: makeDocument(), markdown: '$x$', rasterizeSvg: fakeRasterizer });
  assert.equal(result.ready, true);
  assert.equal(result.assets.length, 1);
});

test('MathJax ex dimensions use readable CSS pixels rather than font-unit viewBox pixels', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="6ex" height="2ex" viewBox="0 -750 3000 1000"><path d="M0 0L500 500"/></svg>';
  const seen = [];
  const result = await renderRichContent(`<span class="katex-inline" data-math-raw="$x$">${svg}</span>`, { document: makeDocument(), markdown: '$x$', rasterizeSvg: async (_, options) => { seen.push(options); return PNG; } });
  assert.equal(result.ready, true);
  assert.deepEqual([seen[0].width, seen[0].height], [48, 16]);
});

test('render-only Markdown preparation prevents native Mermaid side effects and preserves source', async () => {
  const original = '😀\n```bash\necho "mermaid"\n```\n\n> ```mermaid\n> graph TD\n> A-->B\n> ```\n\n最后一段';
  const prepared = prepareRichMarkdown(original);
  assert.ok(prepared.includes('```bash\necho "mermaid"\n```'));
  assert.equal(prepared.includes('```mermaid'), false);
  assert.ok(prepared.includes('data-mermaid-source='));
  assert.ok(prepared.endsWith('最后一段'));
  const document = makeDocument();
  const marker = /<div[^>]+><\/div>/.exec(prepared)[0];
  let renderedSource;
  const result = await renderRichContent(marker, { document, markdown: original, mermaid: { async render(_, source) { renderedSource = source; return { svg: SVG }; } }, rasterizeSvg: fakeRasterizer });
  assert.equal(result.ready, true);
  assert.equal(renderedSource, 'graph TD\nA-->B');
  assert.equal(original.slice(result.assets[0].source.from, result.assets[0].source.to), '> graph TD\n> A-->B\n');
});

test('unsafe SVG scripts, foreignObject, images, event handlers and external refs never reach rasterization', async () => {
  for (const unsafe of [
    '<svg viewBox="0 0 10 10"><script>bad()</script></svg>',
    '<svg viewBox="0 0 10 10"><foreignObject><p>HTML</p></foreignObject></svg>',
    '<svg viewBox="0 0 10 10"><image href="https://example.org/private.png"/></svg>',
    '<svg viewBox="0 0 10 10" onload="bad()"><path d="M0 0"/></svg>',
    '<svg viewBox="0 0 10 10"><use href="https://example.org/path.svg#shape"/></svg>',
    '<svg viewBox="0 0 10 10"><style>@import "https://example.org/font.css";</style></svg>',
    '<svg viewBox="0 0 10 10"><rect style="fill:url(https://example.org/paint.svg)"/></svg>',
  ]) {
    const result = await renderRichContent(pendingDiagram, { document: makeDocument(), markdown, mermaid: { async render() { return { svg: unsafe }; } }, rasterizeSvg() { assert.fail('Unsafe SVG must not be drawn'); } });
    assert.equal(result.ready, false, unsafe);
    assert.ok(codes(result).includes('rich-svg-unsafe'), unsafe);
  }
});

test('source URLs, initialization directives and click callbacks are blocked before Mermaid runs', async () => {
  for (const source of ['graph TD\nA@{ img: "https://example.org/a.png" }', '%%{init: {securityLevel: "loose"}}%%\ngraph TD\nA-->B', 'graph TD\nA-->B\nclick A callback']) {
    const result = await renderRichContent(`<pre class="mermaid">${source.replaceAll('>', '&gt;')}</pre>`, { document: makeDocument(), mermaid: { render() { assert.fail('Unsafe source must not reach Mermaid'); } } });
    assert.equal(result.ready, false);
    assert.ok(codes(result).includes('rich-source-unsafe'));
  }
});

test('local SVG fragments and reusable MathJax glyph paths remain valid', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><defs><path id="glyph" d="M0 0L4 5"/><linearGradient id="paint"><stop offset="0" stop-color="red"/></linearGradient></defs><use href="#glyph"/><rect width="10" height="10" fill="url(#paint)"/></svg>';
  const result = await renderRichContent(`<div class="mermaid" data-mermaid-source="graph TD; A--&gt;B">${svg}</div>`, { document: makeDocument(), mode: 'svg' });
  assert.equal(result.ready, true);
  assert.ok(result.html.includes('url(#paint)'));
});

test('pixel, source, count, asset byte limits and timeout prevent incomplete exports', async () => {
  const document = makeDocument();
  const huge = await renderRichContent(pendingDiagram, { document, markdown, mermaid: { async render() { return { svg: '<svg viewBox="0 0 100000 100000"></svg>' }; } }, rasterizeSvg() { assert.fail('Pixel limit must precede drawing'); } });
  assert.ok(codes(huge).includes('rich-limit'));
  const sourceLimited = await renderRichContent('<pre class="mermaid">' + 'x'.repeat(30) + '</pre>', { document, maxSourceLength: 10, mermaid: { render() { assert.fail(); } } });
  assert.ok(codes(sourceLimited).includes('rich-limit'));
  const countLimited = await renderRichContent(pendingDiagram + pendingDiagram, { document, markdown, maxCount: 1 });
  assert.ok(codes(countLimited).includes('rich-limit'));
  const bytesLimited = await renderRichContent(pendingDiagram, { document, markdown, mermaid: { async render() { return { svg: SVG }; } }, rasterizeSvg: fakeRasterizer, maxAssetBytes: 10 });
  assert.ok(codes(bytesLimited).includes('rich-limit'));
  const timedOut = await renderRichContent(pendingDiagram, { document, markdown, timeoutMs: 15, mermaid: { async render() { return new Promise(() => {}); } } });
  assert.ok(codes(timedOut).includes('rich-timeout'));
  assert.equal(timedOut.ready, false);
});

test('invalid rasterizer output is blocked and error details never include renderer source', async () => {
  const result = await renderRichContent(pendingDiagram, { document: makeDocument(), markdown, mermaid: { async render() { return { svg: SVG }; } }, rasterizeSvg: async () => new Uint8Array([1, 2, 3]) });
  assert.equal(result.ready, false);
  assert.ok(codes(result).includes('rich-png-invalid'));
  const failed = await renderRichContent(pendingDiagram, { document: makeDocument(), markdown, mermaid: { render() { throw new Error('API_TOKEN=synthetic-secret; graph TD...'); } } });
  assert.equal(JSON.stringify(failed.issues).includes('synthetic-secret'), false);
});

test('no-rich-content pass through preserves exact HTML and does not touch code or commands', async () => {
  const html = '<pre><code class="language-bash">echo "$x"\nrm -rf example-only</code></pre><p>按装</p>';
  const result = await renderRichContent(html, { document: makeDocument(), mermaid: { render() { assert.fail(); } } });
  assert.equal(result.html, html);
  assert.equal(result.ready, true);
  assert.equal(result.assets.length, 0);
});

test('default rasterizer fails explicitly when canvas/image APIs are unavailable', async () => {
  await assert.rejects(() => rasterizeSvg(SVG, { document: makeDocument(), width: 120, height: 40, scale: 2 }), /raster|canvas|image/i);
});

test('browser rasterizer waits for image decode and revokes blob URLs on decode failure', async () => {
  const base = makeDocument();
  const revoked = [];
  let drawn = false;
  const context = { fillRect() {}, drawImage() { drawn = true; } };
  const canvas = { getContext() { return context; }, toBlob(callback) { callback(new Blob([PNG], { type: 'image/png' })); } };
  const fakeDocument = {
    createElement(name) { return name === 'canvas' ? canvas : base.createElement(name); },
    defaultView: {
      Blob,
      URL: { createObjectURL() { return 'blob:synthetic-test'; }, revokeObjectURL(url) { revoked.push(url); } },
      Image: class {
        decode() { this.onerror?.(new Error('image event failure')); return Promise.reject(new Error('image decode failure')); }
      },
    },
  };
  await assert.rejects(() => rasterizeSvg(SVG, { document: fakeDocument, width: 120, height: 40, scale: 2 }), /decode/);
  await new Promise(setImmediate);
  assert.equal(drawn, false);
  assert.deepEqual(revoked, ['blob:synthetic-test']);
});

test('local runtime loader pins Mermaid and configures MathJax before loading local script', async () => {
  const document = makeDocument();
  const window = {};
  const append = document.head.appendChild.bind(document.head);
  let scriptSource;
  document.head.appendChild = node => {
    scriptSource = node.getAttribute('src');
    assert.deepEqual(window.MathJax.tex.packages, { '[-]': ['autoload', 'require', 'html', 'configmacros', 'noundefined'] });
    assert.equal(window.MathJax.svg.fontCache, 'none');
    assert.equal(window.MathJax.startup.typeset, false);
    const result = append(node);
    queueMicrotask(() => { window.MathJax = { version: '3.2.2', tex2svg() {}, startup: { promise: Promise.resolve() } }; node.onload(); });
    return result;
  };
  const mermaid = { initialize() {}, render() {} };
  const runtime = await loadRichRuntime({ document, window, importMermaid: async () => ({ aX: { default: mermaid } }) });
  assert.equal(scriptSource, '/vendor/mathjax-3.2.2/tex-svg.js');
  assert.equal(runtime.mermaid, mermaid);
  assert.equal(typeof runtime.mathjax.tex2svg, 'function');
  assert.equal(await loadRichRuntime({ document, window, importMermaid() { assert.fail('Runtime should be cached'); } }), runtime);
});

test('runtime script failure and timeout are bounded, sanitized and retryable', async () => {
  const document = makeDocument();
  const window = {};
  document.head.appendChild = node => { queueMicrotask(() => node.onerror(new Error('synthetic-private-url'))); return node; };
  await assert.rejects(() => loadRichRuntime({ document, window, importMermaid: async () => ({ aX: { default: {} } }), timeoutMs: 20 }), /local|runtime|load/i);
  const slowDocument = makeDocument();
  await assert.rejects(() => loadRichRuntime({ document: slowDocument, window: {}, importMermaid: async () => new Promise(() => {}), timeoutMs: 15 }), /timeout|time/i);
});

test('actual pinned MathJax component retains only base, ams, newcommand and no dynamic extension handlers', async () => {
  const document = makeDocument();
  const window = {};
  let configured;
  document.head.appendChild = node => {
    configured = JSON.parse(JSON.stringify(window.MathJax));
    queueMicrotask(() => { window.MathJax = { tex2svg() {}, startup: { promise: Promise.resolve() } }; node.onload(); });
    return node;
  };
  await loadRichRuntime({ document, window, importMermaid: async () => ({ default: {} }) });
  let componentReady;
  const ready = new Promise(resolve => { componentReady = resolve; });
  const context = vm.createContext({ document, window: { document, navigator: { platform: 'Win32' } }, setTimeout, clearTimeout, console, componentReady });
  // Create configuration in the VM realm: MathJax's object checks use constructors.
  vm.runInContext(`MathJax = ${JSON.stringify(configured)}; MathJax.startup.ready = componentReady;`, context);
  vm.runInContext(readFileSync(new URL('../node_modules/mathjax/es5/tex-svg.js', import.meta.url), 'utf8'), context, { timeout: 5000 });
  await ready;
  assert.deepEqual(Array.from(context.MathJax.config.tex.packages), ['base', 'ams', 'newcommand']);
  const tex = new context.MathJax._.input.tex_ts.TeX({ packages: context.MathJax.config.tex.packages });
  const macros = tex.parseOptions.handlers.get('macro');
  for (const name of ['require', 'href', 'class', 'style', 'cssId']) assert.equal(macros.lookup(name), null, name);
  for (const name of ['frac', 'newcommand']) assert.ok(macros.lookup(name), name);
  assert.ok(tex.parseOptions.handlers.get('environment').lookup('align'));
});

test('Mermaid retry reuses only our completed local MathJax without adding another script', async () => {
  const document = makeDocument();
  const window = {};
  const append = document.head.appendChild.bind(document.head);
  let scriptCount = 0;
  let completed;
  const mathReady = new Promise(resolve => { completed = resolve; });
  document.head.appendChild = node => {
    scriptCount++;
    append(node);
    queueMicrotask(() => { window.MathJax = { tex2svg() {}, startup: { promise: Promise.resolve() } }; node.onload(); completed(); });
    return node;
  };
  await assert.rejects(loadRichRuntime({ document, window, importMermaid: async () => { await mathReady; await new Promise(setImmediate); throw new Error('synthetic-private-token'); } }), /local|runtime|load/i);
  const ownMathJax = window.MathJax;
  const mermaid = {};
  const runtime = await loadRichRuntime({ document, window, importMermaid: async () => ({ default: mermaid }) });
  assert.equal(runtime.mathjax, ownMathJax);
  assert.equal(runtime.mermaid, mermaid);
  assert.equal(scriptCount, 1);
});

test('runtime refuses foreign globals and scripts, and does not adopt an unfinished own MathJax after Mermaid fails', async () => {
  for (const foreign of [{ startup: { promise: Promise.resolve() } }, { tex2svg() {} }, {}]) {
    const document = makeDocument();
    const window = { MathJax: foreign };
    document.head.appendChild = () => { assert.fail('Foreign globals must not be overwritten'); };
    await assert.rejects(loadRichRuntime({ document, window, importMermaid: async () => ({ default: {} }) }), /local|runtime|load/i);
    assert.equal(window.MathJax, foreign);
  }
  for (const id of ['MathJax-script', 'local-rich-mathjax-3-2-2']) {
    const document = makeDocument();
    const foreignScript = document.createElement('script');
    foreignScript.id = id;
    foreignScript.src = 'https://invalid.example/foreign-mathjax.js';
    document.head.appendChild(foreignScript);
    await assert.rejects(loadRichRuntime({ document, window: {}, importMermaid: async () => ({ default: {} }) }), /local|runtime|load/i);
  }
  const document = makeDocument();
  const window = {};
  let script;
  document.head.appendChild = node => { script = node; return node; };
  await assert.rejects(loadRichRuntime({ document, window, timeoutMs: 30, importMermaid: async () => { throw new Error('Mermaid failed'); } }), /local|runtime|load/i);
  const inFlight = window.MathJax;
  await assert.rejects(loadRichRuntime({ document, window, timeoutMs: 30, importMermaid: async () => ({ default: {} }) }), /local|runtime|load/i);
  assert.equal(window.MathJax, inFlight);
  script.onerror();
});

test('completed runtime ownership cannot survive global, script URL, element or document replacement', async () => {
  for (const change of ['global', 'url', 'element', 'document']) {
    const document = makeDocument();
    const window = {};
    const append = document.head.appendChild.bind(document.head);
    let ownScript;
    document.head.appendChild = node => {
      ownScript = node;
      append(node);
      queueMicrotask(() => { window.MathJax = { tex2svg() {}, startup: { promise: Promise.resolve() } }; node.onload(); });
      return node;
    };
    await loadRichRuntime({ document, window, importMermaid: async () => ({ default: {} }) });
    if (change === 'global') window.MathJax = { tex2svg() {} };
    if (change === 'url') ownScript.src = 'https://invalid.example/foreign.js';
    if (change === 'element') {
      ownScript.remove();
      const replacement = document.createElement('script');
      replacement.id = ownScript.id;
      replacement.src = ownScript.src;
      append(replacement);
    }
    await assert.rejects(loadRichRuntime({ document: change === 'document' ? makeDocument() : document, window, importMermaid() { assert.fail('Foreign runtime must not be imported'); } }), /ownership|local|runtime/i);
  }
});
