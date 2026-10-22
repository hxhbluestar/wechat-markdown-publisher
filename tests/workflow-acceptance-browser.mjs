import { CODE_SAMPLES, DEVICE_CASES, IMAGE_TITLES, WIDE_TABLE_LAST_CELL, buildWorkflowMarkdown, createWorkflowAssets } from '/tests/fixtures/workflow-corpus.mjs';
import { loadRichRuntime } from '/frontend/rich-runtime.mjs?release=20261018-workflow1';
import { prepareRichMarkdown, renderRichContent } from '/frontend/rich-content.mjs';

const report = document.getElementById('workflow-report');
const article = document.getElementById('acceptance-article');
const stage = document.getElementById('acceptance-stage');
const themeSelect = document.getElementById('acceptance-theme');
const deviceSelect = document.getElementById('acceptance-device');
const dark = document.getElementById('acceptance-dark');
const checks = [], matrix = [], preparedCases = new Map(), objectURLs = [];
const css = document.createElement('style'); document.head.appendChild(css);
const check = (condition, label) => { if (!condition) throw new Error(label); checks.push(label); };
const tick = async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); };
const themeNames = ['technical', 'journal', 'minimal', 'obsidian', 'default', 'grace', 'simple'];
for (const theme of themeNames) { const option = document.createElement('option'); option.value = option.textContent = theme; themeSelect.appendChild(option); }
for (const device of DEVICE_CASES) { const option = document.createElement('option'); option.value = device.id; option.textContent = `${device.label} ${device.width}px`; deviceSelect.appendChild(option); }

async function display(theme, device) {
  const current = preparedCases.get(theme);
  css.textContent = current.css;
  article.style.width = device.width + 'px';
  article.innerHTML = `<section id="output">${current.html}</section>`;
  stage.classList.toggle('dark', dark.checked || theme === 'obsidian');
  stage.dataset.theme = stage.classList.contains('dark') ? 'dark' : 'light';
  await Promise.all([...article.querySelectorAll('img')].map(image => image.decode()));
  await document.fonts.ready;
  await tick();
}

try {
  const runtime = await loadRichRuntime({ document, window, timeoutMs: 20000 });
  const renderer = await import('/frontend/renderer-adapter.mjs');
  const { prepareTypography } = await import('/frontend/typography.mjs');
  check(typeof renderer.previewWechatArticle === 'function' && typeof prepareTypography === 'function', 'actual renderer adapter and typography modules are loaded');
  const markdown = buildWorkflowMarkdown();
  const storedFixture = await fetch('/tests/fixtures/workflow-corpus.md').then(response => response.text());
  check(markdown === storedFixture, 'standalone Markdown corpus equals the generated synthetic source');
  const assets = createWorkflowAssets({ document });
  check(assets.length === 15 && new Set(assets.map(asset => asset.path)).size === 15, '15 distinct local synthetic image assets');
  const imageURLs = new Map();
  for (const asset of assets) { const url = URL.createObjectURL(new Blob([asset.bytes], { type: 'image/png' })); objectURLs.push(url); imageURLs.set(asset.path, url); }
  const options = { font_family: 'theme', font_size: 17, code_wrap: 'wrap', table_mode: 'scroll', caption_font_size: 12, table_font_size: 12 };
  for (const theme of themeNames) {
    const preview = renderer.previewWechatArticle(prepareRichMarkdown(markdown), theme, 'blue', options);
    const rich = await renderRichContent(preview.html, { document, markdown, ...runtime, mode: 'png', scale: 2, timeoutMs: 20000 });
    check(rich.ready, `${theme}: local rich rendering completed (${rich.issues.map(issue => issue.code).join(',')})`);
    const urls = new Map(imageURLs);
    for (const asset of rich.assets) { const url = URL.createObjectURL(new Blob([asset.bytes], { type: 'image/png' })); objectURLs.push(url); urls.set(asset.name, url); }
    const parsed = new DOMParser().parseFromString(rich.html, 'text/html');
    for (const image of parsed.querySelectorAll('img')) { const url = urls.get(image.getAttribute('src')); if (url) image.setAttribute('src', url); }
    preparedCases.set(theme, { html: parsed.body.innerHTML, css: preview.css });
    const devices = ['default', 'grace', 'simple'].includes(theme) ? [DEVICE_CASES[0]] : DEVICE_CASES;
    for (const device of devices) {
      await display(theme, device);
      const label = `${theme} ${device.id} ${device.width}px`;
      check(article.querySelectorAll('img').length === 18, `${label}: all 15 pictures plus 3 diagram/formula PNGs are present`);
      const readCode = node => node.nodeType===3 ? node.nodeValue : node.tagName==='BR' ? '\n' : [...node.childNodes].map(readCode).join('');
      const snippets = [...article.querySelectorAll('pre code')].map(readCode);
      check(Object.values(CODE_SAMPLES).every(sample => snippets.includes(sample)), `${label}: every original code/log character remains copyable`);
      check(article.textContent.includes('ARTICLE-END-KEEP-Ω') && article.textContent.includes(WIDE_TABLE_LAST_CELL), `${label}: article end and final table column remain present`);
      check([...article.querySelectorAll('figcaption')].filter(node => IMAGE_TITLES.includes(node.textContent.trim())).length === 15, `${label}: all Chinese figure captions are preserved`);
      check([...article.querySelectorAll('figcaption')].every(node => getComputedStyle(node).fontSize === '12px'), `${label}: caption font computes to authored 12px`);
      check([...article.querySelectorAll('h1,h2,h3,h4,h5')].length >= 7, `${label}: heading hierarchy remains visible`);
      check(article.scrollWidth <= article.clientWidth + 2, `${label}: article has no unintended horizontal clipping`);
      const table = article.querySelector('table');
      check(table?.rows[0].cells.length === 5 && table.rows[table.rows.length - 1].cells[4].textContent === WIDE_TABLE_LAST_CELL, `${label}: all five table columns and last row survive`);
      const area = article.querySelector('.wx-table-scroll');
      if (area) {
        area.scrollLeft = area.scrollWidth; await tick();
        check(table.rows[table.rows.length - 1].cells[4].getBoundingClientRect().right <= area.getBoundingClientRect().right + 2, `${label}: final wide-table column can be reached by scrolling`);
      }
      if (!['default', 'grace', 'simple'].includes(theme)) {
        const blocks = [...article.querySelectorAll('.wx-flow-block')];
        check(blocks.length > 15 && blocks.every(node => [0, 12, 16, 20, 24, 28].includes(parseFloat(getComputedStyle(node).paddingTop))), `${label}: local flow blocks retain the tested bounded spacing profile`);
      }
      matrix.push({ theme, device: device.id, width: device.width, passed: true });
      report.textContent = `${matrix.length} layout cases passed; ${checks.length} checks.\n` + matrix.map(item => `PASS ${item.theme} ${item.device} ${item.width}px`).join('\n');
    }
  }
  check(!document.getElementById('MathJax-script'), 'no legacy CDN MathJax loader was injected');
  check(performance.getEntriesByType('resource').every(entry => entry.name.startsWith(location.origin) || entry.name.startsWith('blob:')), 'no runtime, font, image or article request used an external origin');
  window.workflowAcceptance = { passed: true, checks, matrix, browserEmulationOnly: true };
  document.body.dataset.testStatus = 'passed';
  report.textContent = `${matrix.length} layout cases / ${checks.length} checks passed. Browser emulation only.\n` + matrix.map(item => `PASS ${item.theme} ${item.device} ${item.width}px`).join('\n');
  themeSelect.value = 'technical'; deviceSelect.value = DEVICE_CASES[0].id;
  const refresh = () => display(themeSelect.value, DEVICE_CASES.find(device => device.id === deviceSelect.value));
  themeSelect.addEventListener('change', refresh); deviceSelect.addEventListener('change', refresh); dark.addEventListener('change', refresh);
  await refresh();
} catch (error) {
  document.body.dataset.testStatus = 'failed';
  window.workflowAcceptance = { passed: false, checks, matrix, error: error.message, browserEmulationOnly: true };
  report.textContent = `${matrix.length} layout cases / ${checks.length} checks passed before failure.\nFAIL ${error.message}`;
  console.error('Synthetic workflow acceptance failed', error);
}
window.addEventListener('pagehide', () => objectURLs.forEach(url => URL.revokeObjectURL(url)), { once: true });
