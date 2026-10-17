// Serve the repository root, mapping /editor/assets and /vendor to app/web.
// Example test server guidance is in the parent task handoff; never production.
import { prepareRichMarkdown, renderRichContent } from '/frontend/rich-content.mjs?qa=20261018-marker1';
import { loadRichRuntime } from '/frontend/rich-runtime.mjs?release=20261018-workflow1';
import {prepareTypography} from '/frontend/typography.mjs';
import {stripExportDecorations} from '/frontend/renderer-adapter.mjs';

const report = document.getElementById('rich-report');
const checks = [];
const objectURLs = [];
function check(value, label) {
  if (!value) throw new Error(label);
  checks.push(`PASS ${label}`);
}

try {
  const runtime = await loadRichRuntime({ document, window, timeoutMs: 20000 });
  check(runtime.mathjax.version === '3.2.2', 'pinned local MathJax 3.2.2 is ready');
  check(typeof runtime.mermaid.render === 'function', 'pinned local Mermaid is ready');
  // Import after local MathJax is ready, so the native parser cannot start CDN loading.
  const { BS: nativeMarkdown } = await import('/frontend/vendor/editor-engine-20261018.js');
  const code = 'value = "$x$ <tag> 按装"\nprint(value)';
  const markdown = ['# 合成图表验证', '', '保留普通段落、可复制代码与原始 Markdown。', '', '```mermaid', 'graph TD', '  A[环境准备] --> B[结果验证]', '```', '', '行内公式：$x^2 + y^2 = z^2$。', '', '$$', '\\frac{1}{n}\\sum_{i=1}^{n}x_i', '$$', '', '```python', code, '```'].join('\n');
  const prepared = prepareRichMarkdown(markdown);
  check(!prepared.includes('```mermaid') && prepared.includes('```python'), 'render copy protects Mermaid native side effects while preserving ordinary code');
  const html = nativeMarkdown(prepared);
  check(!document.getElementById('MathJax-script'), 'native Markdown did not inject the CDN MathJax loader');
  const png = await renderRichContent(html, { document, markdown, ...runtime, mode: 'png', scale: 2, timeoutMs: 20000 });
  check(png.ready, `PNG conversion completed: ${png.issues.map(issue => issue.code).join(', ')}`);
  check(png.assets.length === 3 && png.renderedCount === 3, `one Mermaid diagram and two formulas became three local PNG assets (actual ${png.assets.length}/${png.renderedCount}; )`);
  for (const asset of png.assets) {
    check(asset.bytes[0] === 137 && asset.bytes[1] === 80 && asset.width > 1 && asset.height > 1, `${asset.source.kind} has real PNG bytes and dimensions`);
    if (asset.source.from !== undefined) check(markdown.slice(asset.source.from, asset.source.to) === asset.source.text, `${asset.source.kind} provenance retains original UTF-16 positions`);
  }
  const parsed = new DOMParser().parseFromString(png.html, 'text/html');
  const beforeCode=new DOMParser().parseFromString(html,'text/html').querySelector('code');
  check(parsed.querySelector('code').innerHTML===beforeCode.innerHTML,'rich conversion does not modify native code markup');
  // The native renderer uses NBSP + <br>; the existing typography adapter
  // restores data-source-code to copyable text in the actual application.
  const finished=prepareTypography(png.html,{theme:'technical'});
  const finalCode=new DOMParser().parseFromString(finished.html,'text/html').querySelector('code');
  check(finalCode.textContent === code, 'final application typography keeps exact copyable code');
  check(!parsed.querySelector('.katex-pending,.mermaid-diagram[data-md-diagram-state="loading"]'), 'PNG output has no pending math or Mermaid placeholders');
  const exportDocument=new DOMParser().parseFromString(stripExportDecorations(finished.html,document),'text/html');
  check(!exportDocument.querySelector('svg,foreignObject'), 'PNG export contains no SVG or foreignObject');
  const pngHost = document.getElementById('rich-png');
  const assets = new Map(png.assets.map(asset => [asset.name, asset]));
  // Give only generated images object URLs; do not save files or call any API.
  for (const image of parsed.querySelectorAll('img')) {
    const asset = assets.get(image.getAttribute('src'));
    if (asset) {
      const url = URL.createObjectURL(new Blob([asset.bytes], { type: 'image/png' }));
      objectURLs.push(url);
      image.setAttribute('src', url);
    }
  }
  pngHost.innerHTML = parsed.body.innerHTML;
  await Promise.all([...pngHost.querySelectorAll('img')].map(image => image.decode()));
  check([...pngHost.querySelectorAll('img')].every(image => image.naturalWidth > 1 && image.naturalHeight > 1), 'generated PNG previews finish image decoding');
  const svg = await renderRichContent(html, { document, markdown, ...runtime, mode: 'svg', timeoutMs: 20000 });
  check(svg.ready && svg.assets.length === 0 && svg.renderedCount === 3, 'explicit SVG preview resolves all three source nodes without raster assets');
  document.getElementById('rich-svg').innerHTML = svg.html;
  check(!document.getElementById('rich-svg').querySelector('foreignObject,script,image'), 'SVG preview contains no foreignObject, script or external image');
  const unsafe = prepareRichMarkdown('```mermaid\ngraph TD\nA@{ img: "https://example.org/no-request.png" }\n```');
  const refused = await renderRichContent(nativeMarkdown(unsafe), { document, markdown: '```mermaid\ngraph TD\nA@{ img: "https://example.org/no-request.png" }\n```', ...runtime });
  check(!refused.ready && refused.issues.some(issue => issue.code === 'rich-source-unsafe'), 'external image source is refused before Mermaid rendering');
  check(performance.getEntriesByType('resource').every(entry => entry.name.startsWith(location.origin) || entry.name.startsWith('blob:')), 'runtime and article processing requested no external resources');
  document.body.dataset.testStatus = 'passed';
  report.textContent = checks.join('\n') + `\n\n${checks.length} checks passed.`;
} catch (error) {
  document.body.dataset.testStatus = 'failed';
  report.textContent = checks.join('\n') + '\nFAIL ' + error.message;
  console.error('Rich-content browser fixture failed', error);
}

window.addEventListener('pagehide', () => objectURLs.forEach(url => URL.revokeObjectURL(url)), { once: true });
