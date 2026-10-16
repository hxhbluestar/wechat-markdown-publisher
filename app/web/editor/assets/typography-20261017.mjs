const NEW_THEMES = new Set(['technical', 'journal', 'minimal']);
const SANS = '-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif';
const SERIF = '"Songti SC","STSong","Noto Serif CJK SC","SimSun",serif';
const MONO = '"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace';

/** Persist a small, validated set of controls; never accept raw CSS from settings. */
export function normalizeTypography(settings, theme = 'technical') {
  const input = settings && typeof settings === 'object' ? settings : {};
  const size = typeof input.font_size === 'number' || typeof input.font_size === 'string' ? Number(input.font_size) : NaN;
  return {
    font_family: ['theme', 'sans', 'serif'].includes(input.font_family) ? input.font_family : 'theme',
    font_size: [15, 16, 17, 18].includes(size) ? size : NEW_THEMES.has(theme) ? 17 : 16,
    code_wrap: ['scroll', 'wrap'].includes(input.code_wrap) ? input.code_wrap : 'scroll',
    table_mode: ['auto', 'scroll', 'cards'].includes(input.table_mode) ? input.table_mode : 'auto',
  };
}

const THEMES = {
  technical: { paper: '#ffffff', ink: '#263342', secondary: '#657284', accent: '#28639e', rule: '#e1e7ec', tint: '#f0f5fa', code: '#142236', codeInk: '#e2eaf5', codeRule: '#2c3d55', label: '#a9c0dc', keyword: '#c2b4ff', string: '#a9dcc3', comment: '#9aacc4', number: '#f0c899', fn: '#95c8ff', addition: '#b4e5c5', deletion: '#ffb3b8' },
  journal: { paper: '#fffdf8', ink: '#3e382e', secondary: '#7c7061', accent: '#8b563b', rule: '#e4ddd0', tint: '#f5f0e6', code: '#f5f0e6', codeInk: '#443b31', codeRule: '#e0d7c8', label: '#706451', keyword: '#744196', string: '#376d50', comment: '#6d665b', number: '#985934', fn: '#236e85', addition: '#27633f', deletion: '#a33e3e' },
  minimal: { paper: '#ffffff', ink: '#25272b', secondary: '#666b73', accent: '#3c4653', rule: '#dfe2e7', tint: '#f2f4f6', code: '#f2f4f6', codeInk: '#313b48', codeRule: '#dce1e8', label: '#657082', keyword: '#805292', string: '#3f7358', comment: '#656d77', number: '#946233', fn: '#356181', addition: '#27633f', deletion: '#a33e3e' },
};

// Paper and syntax palettes belong to the layout; the user's color selection
// changes article accents only. Green/gold text is darker than their borders
// so links and small inline parameters remain readable on the light papers.
const PALETTES = {
  blue: { accent: '#2563eb', accentLine: '#2563eb', tint: '#eff6ff' },
  wechat: { accent: '#078340', accentLine: '#07c160', tint: '#effaf4' },
  red: { accent: '#b33a3a', accentLine: '#b33a3a', tint: '#fff1f1' },
  violet: { accent: '#7c3aed', accentLine: '#7c3aed', tint: '#f5f1ff' },
  ink: { accent: '#806027', accentLine: '#9a7430', tint: '#f8f3e8' },
};

function rule(selectors, declarations) {
  const scoped = selectors.split(',').map((selector) => `#output .wx-typography${selector.trim() ? ` ${selector.trim()}` : ''}`).join(',\n');
  return `${scoped} { ${Object.entries(declarations).map(([key, value]) => `${key}: ${value} !important;`).join(' ')} }`;
}

function typographyCSS(settings, theme, fresh, palette) {
  const font = settings.font_family === 'serif' || (settings.font_family === 'theme' && theme === 'journal') ? SERIF : SANS;
  const size = `${settings.font_size}px`;
  const wrap = settings.code_wrap === 'wrap';
  let css = '';
  if (fresh || settings.font_family !== 'theme' || settings.font_size !== 16) {
    // Explicit declarations on text nodes also override the legacy base theme's sizes.
    const fontRule = fresh || settings.font_family !== 'theme' ? { 'font-family': font } : {};
    const spacingRule = fresh ? { 'line-height': theme === 'journal' ? '1.95' : '1.85', 'overflow-wrap': 'break-word', 'text-align': 'left' } : {};
    css += rule('', { ...fontRule, 'font-size': size, ...spacingRule });
    css += rule('p,li', { ...fontRule, 'font-size': size, ...(fresh ? { 'line-height': theme === 'journal' ? '1.95' : '1.85' } : {}) });
    if (Object.keys(fontRule).length) css += rule('h1,h2,h3,h4,h5,h6,blockquote', fontRule);
  }
  if (!fresh) {
    if (wrap) {
      css += rule('pre,pre code,.wx-code-pre,.wx-code-text', { 'white-space': 'pre-wrap', 'overflow-wrap': 'anywhere', 'word-break': 'normal', 'max-width': '100%' });
      // Legacy themes use a horizontal -webkit-box with its own scroll area.
      // Only an explicitly selected wrap mode replaces that layout; border-box
      // also keeps the old code padding inside the available phone width.
      css += rule('.wx-code-pre,.wx-code-text', { display: 'block', 'box-sizing': 'border-box', width: 'auto', 'min-width': '0', 'max-width': '100%', 'overflow-x': 'hidden' });
    }
    if (settings.table_mode !== 'auto') css += tableCSS(THEMES.minimal);
    return css;
  }
  const selected = Object.hasOwn(PALETTES, palette) ? PALETTES[palette] : null;
  const c = { ...THEMES[theme], ...selected };
  const accentLine = c.accentLine || c.accent;
  const headingLine = selected ? accentLine : c.rule;
  css += rule('', { color: c.ink, background: c.paper, padding: '8px 0', 'max-width': '100%', 'box-sizing': 'border-box' });
  css += rule('section,div,p,ul,ol,li,blockquote,figure,table', { 'box-sizing': 'border-box' });
  css += rule('.container', { 'font-family': font, 'font-size': size, 'line-height': theme === 'journal' ? '1.95' : '1.85', color: c.ink, background: 'transparent', 'max-width': '100%' });
  css += rule('p', { margin: '0 0 18px', color: c.ink, 'letter-spacing': '0', 'text-align': 'left' });
  css += rule('h1,h2,h3,h4,h5,h6', { display: 'block', width: 'auto', 'max-width': '100%', color: c.ink, background: 'transparent', 'font-style': 'normal', 'font-weight': '700', padding: '0', 'border-left': '0', 'border-right': '0', 'border-top': '0', 'border-bottom': '0', 'box-shadow': 'none', 'letter-spacing': '0', 'text-align': 'left' });
  css += rule('h1', { 'font-size': theme === 'journal' ? '28px' : theme === 'minimal' ? '25px' : '27px', 'line-height': '1.5', margin: '8px 0 22px', 'text-align': theme === 'journal' ? 'center' : 'left' });
  css += rule('h2', { 'font-size': theme === 'journal' ? '20px' : '19px', 'line-height': '1.6', margin: '32px 0 16px', padding: theme === 'journal' ? '13px 0 0' : theme === 'minimal' ? '0 0 8px' : '0 0 0 12px', 'border-top': theme === 'journal' ? `1px solid ${headingLine}` : '0', 'border-bottom': theme === 'minimal' ? `1px solid ${headingLine}` : '0', 'border-left': theme === 'technical' ? `3px solid ${accentLine}` : '0' });
  css += rule('h3', { 'font-size': '18px', 'line-height': '1.65', margin: '25px 0 13px' });
  css += rule('h4,h5,h6', { 'font-size': '17px', 'line-height': '1.7', margin: '22px 0 12px' });
  css += rule('h1 strong,h2 strong,h3 strong,h4 strong,h5 strong,h6 strong', { color: c.ink, 'font-weight': '700' });
  css += rule('strong', { color: selected ? c.accent : c.ink, 'font-weight': '700' });
  css += rule('a', { color: c.accent, 'text-decoration': 'underline', 'overflow-wrap': 'anywhere' });
  css += rule('ul,ol', { margin: '10px 0 20px', padding: '0 0 0 22px', color: c.ink });
  css += rule('li', { margin: '7px 0', color: c.ink, 'text-align': 'left' });
  css += rule('li p', { margin: '5px 0' });
  css += rule('p code,li code,td code,th code,.wx-table-value code', { 'font-family': MONO, 'font-size': '0.85em', 'line-height': '1.7', color: c.accent, background: c.tint, padding: '2px 4px', border: '0', 'border-radius': '3px', 'white-space': 'normal', 'overflow-wrap': 'anywhere' });
  css += rule('blockquote', { margin: '23px 0', padding: theme === 'technical' ? '3px 0 3px 17px' : '15px', border: '0', 'border-left': theme === 'journal' ? '0' : `${theme === 'minimal' ? '2px' : '3px'} solid ${accentLine}`, color: c.secondary, background: theme === 'technical' ? 'transparent' : c.tint, 'font-size': size, 'line-height': '1.85', 'font-style': 'normal', 'font-weight': '400', 'text-align': 'left' });
  css += rule('blockquote p', { color: c.secondary, 'font-size': size, 'font-style': 'normal', margin: '0 0 11px' });
  css += rule('blockquote blockquote', { margin: '14px 0 5px 6px', padding: '2px 0 2px 13px', background: 'transparent', 'border-left': `2px solid ${c.rule}` });
  css += rule('.wx-alert', { margin: '22px 0', padding: '14px 15px', background: c.tint, 'border-left': `3px solid ${accentLine}`, 'border-radius': '4px', 'font-style': 'normal' });
  css += rule('.wx-alert p', { 'font-size': '15px', 'line-height': '1.85', margin: '0 0 6px', color: c.ink, 'font-style': 'normal' });
  css += rule('.wx-alert .wx-alert-title', { color: c.accent, 'font-family': SANS, 'font-size': '13px', 'font-weight': '700', margin: '0 0 7px', 'font-style': 'normal' });
  css += rule('.wx-alert-warning,.wx-alert-caution', { 'border-left': '3px solid #a55e25' });
  css += rule('.wx-alert-warning .wx-alert-title,.wx-alert-caution .wx-alert-title', { color: '#97511f' });
  css += rule('.wx-alert-title svg', { display: 'none' });
  css += rule('.wx-code-block', { margin: '20px 0 24px', padding: '0', background: c.code, color: c.codeInk, 'border-radius': theme === 'technical' ? '7px' : '3px', overflow: 'hidden', 'max-width': '100%' });
  css += rule('.wx-code-caption', { display: 'block', margin: '0', padding: '9px 14px', color: c.label, background: c.code, 'border-bottom': `1px solid ${c.codeRule}`, 'font-family': MONO, 'font-size': '11px', 'line-height': '1.5', 'text-align': 'left' });
  css += rule('.wx-code-pre', { display: 'block', margin: '0', padding: '15px 14px 18px', background: c.code, color: c.codeInk, border: '0', 'border-radius': '0', 'box-shadow': 'none', 'max-width': '100%', 'overflow-x': wrap ? 'hidden' : 'auto', 'overflow-y': 'hidden', 'font-family': MONO, 'font-size': '13px', 'line-height': '1.75', 'text-align': 'left', 'white-space': wrap ? 'pre-wrap' : 'pre', 'word-break': 'normal', 'overflow-wrap': wrap ? 'anywhere' : 'normal', 'tab-size': '4' });
  css += rule('.wx-code-text', { display: 'block', margin: '0', padding: '0', background: 'transparent', color: c.codeInk, border: '0', 'border-radius': '0', 'font-family': MONO, 'font-size': '13px', 'line-height': '1.75', 'letter-spacing': '0', 'white-space': wrap ? 'pre-wrap' : 'pre', 'word-break': 'normal', 'overflow-wrap': wrap ? 'anywhere' : 'normal', 'text-align': 'left', 'tab-size': '4', 'text-shadow': 'none' });
  const tokenGroups = [
    ['.hljs-comment,.hljs-quote', c.comment],
    ['.hljs-keyword,.hljs-doctag,.hljs-formula,.hljs-selector-tag', c.keyword],
    ['.hljs-string,.hljs-regexp,.hljs-attribute,.hljs-meta .hljs-string', c.string],
    ['.hljs-number,.hljs-literal,.hljs-type,.hljs-attr,.hljs-variable,.hljs-template-variable,.hljs-symbol,.hljs-bullet', c.number],
    ['.hljs-title,.hljs-section,.hljs-name,.hljs-built_in,.hljs-meta,.hljs-selector-id,.hljs-selector-class,.hljs-link', c.fn],
    ['.hljs-addition', c.addition], ['.hljs-deletion', c.deletion],
  ];
  for (const [tokens, color] of tokenGroups) css += rule(tokens, { color });
  css += rule('.hljs-comment,.hljs-quote', { 'font-style': 'normal' });
  css += rule('.hljs-emphasis', { 'font-style': 'italic' });
  css += rule('.hljs-strong', { 'font-weight': '700' });
  css += rule('.hljs-addition', { background: theme === 'technical' ? '#203b39' : '#e6f0e7' });
  css += rule('.hljs-deletion', { background: theme === 'technical' ? '#442d3b' : '#f8e9e7' });
  css += tableCSS(c);
  css += rule('hr', { border: '0', 'border-top': `1px solid ${c.rule}`, margin: '28px 0', height: '0', background: 'transparent' });
  css += rule('img', { 'max-width': '100%', height: 'auto' });
  css += rule('figcaption', { color: c.secondary, 'font-size': '12px', 'line-height': '1.75', 'text-align': 'center', margin: '9px 0 18px' });
  return css;
}

function tableCSS(c) {
  return rule('table', { width: '100%', 'border-collapse': 'collapse', 'border-spacing': '0', 'font-family': SANS, 'font-size': '13px', 'line-height': '1.75', color: c.ink, margin: '0', 'table-layout': 'auto', 'max-width': 'none' }) +
    rule('thead', { color: c.ink, background: c.tint }) +
    rule('th,td', { padding: '10px 11px', border: '0', 'border-bottom': `1px solid ${c.rule}`, 'vertical-align': 'top', 'font-size': '13px', 'line-height': '1.75', color: c.ink, 'white-space': 'normal', 'overflow-wrap': 'break-word' }) +
    rule('th', { 'font-weight': '700', background: c.tint }) +
    rule('td', { background: c.paper }) +
    // The width estimate decides whether scrolling is useful, not whether a
    // glyph run fits on every phone. Fixed columns plus anywhere wrapping keep
    // an auto-fit table contained even for wide Latin letters at 320 px.
    rule('.wx-table-fit', { width: '100%', 'max-width': '100%', 'table-layout': 'fixed' }) +
    rule('.wx-table-fit th,.wx-table-fit td', { 'overflow-wrap': 'anywhere', 'word-break': 'normal', 'min-width': '0' }) +
    rule('.wx-table-block', { margin: '20px 0 24px', padding: '0', 'max-width': '100%' }) +
    rule('.wx-table-scroll', { display: 'block', 'max-width': '100%', 'overflow-x': 'auto', 'overflow-y': 'hidden', '-webkit-overflow-scrolling': 'touch', padding: '0 0 6px', margin: '0' }) +
    rule('.wx-table-scroll table', { width: '100%' }) +
    rule('.wx-table-scroll th,.wx-table-scroll td', { 'white-space': 'nowrap', 'overflow-wrap': 'normal' }) +
    rule('.wx-table-hint,.wx-table-caption', { 'font-family': SANS, 'font-size': '11px', 'line-height': '1.75', color: c.secondary, margin: '0 0 9px', padding: '0' }) +
    rule('.wx-table-cards', { margin: '20px 0 24px', padding: '0', 'max-width': '100%' }) +
    rule('.wx-table-card', { margin: '0 0 13px', padding: '13px 14px', border: `1px solid ${c.rule}`, 'border-radius': '4px', background: c.paper }) +
    rule('.wx-table-field', { display: 'block', margin: '0 0 9px', padding: '0', 'font-size': '14px', 'line-height': '1.8' }) +
    rule('.wx-table-key', { display: 'block', color: c.secondary, 'font-family': SANS, 'font-size': '12px', 'line-height': '1.65', 'font-weight': '600', margin: '0 0 2px' }) +
    rule('.wx-table-value', { display: 'block', color: c.ink, 'font-family': SANS, 'font-size': '14px', 'line-height': '1.8', margin: '0', 'overflow-wrap': 'anywhere' });
}

function readNodes(node) {
  if (node.nodeType === 3) return node.nodeValue;
  if (node.nodeType !== 1) return '';
  if (node.tagName === 'BR') return '\n';
  if (node.classList.contains('line-numbers') || node.classList.contains('mac-sign')) return '';
  return [...node.childNodes].map(readNodes).join('');
}

function codeSource(code, language) {
  if (code.hasAttribute('data-wx-code')) return code.textContent;
  if (code.hasAttribute('data-source-code')) {
    try { return decodeURIComponent(code.getAttribute('data-source-code')); } catch { /* Continue with the rendered text for malformed legacy attributes. */ }
  }
  const inner = code.querySelector('.code-scroll > div') || code.querySelector('.code-block__inner') || code;
  const lines = [...inner.children];
  const isDiffLines = language.startsWith('diff-') && lines.length && lines.every((line) => /(?:^|;)\s*display\s*:\s*block\s*(?:;|$)/i.test(line.getAttribute('style') || ''));
  let text = isDiffLines ? lines.map(readNodes).join('\n') : readNodes(inner);
  // NBSP is the old renderer's space encoding, not new code authored by us.
  if (code.querySelector('.code-block__inner,.code-scroll') || code.querySelector('br')) text = text.replace(/\u00a0/g, ' ');
  if (code.hasAttribute('data-raw-code')) {
    const raw = code.getAttribute('data-raw-code');
    // Old data-raw-code attributes did not escape ampersands. Prefer readable
    // rendered text if attribute parsing changed an entity-looking code literal.
    if (raw.replace(/\t/g, '    ').replace(/\r\n/g, '\n') === text.replace(/\r\n/g, '\n') || !text) return raw;
  }
  return text;
}

const LANGUAGE_LABELS = { plaintext: '纯文本', text: '纯文本', txt: '纯文本', python: 'Python', py: 'Python', javascript: 'JavaScript', js: 'JavaScript', typescript: 'TypeScript', ts: 'TypeScript', powershell: 'PowerShell', ps1: 'PowerShell', bash: 'Bash', sh: 'Shell', shell: 'Shell', shellsession: 'Shell', console: 'Shell', c: 'C', cpp: 'C++', 'c++': 'C++', csharp: 'C#', cs: 'C#', java: 'Java', json: 'JSON', yaml: 'YAML', yml: 'YAML', xml: 'XML', html: 'HTML', css: 'CSS', sql: 'SQL', diff: 'Diff', go: 'Go', rust: 'Rust', rs: 'Rust', ruby: 'Ruby', rb: 'Ruby', ini: 'INI', markdown: 'Markdown', md: 'Markdown', dockerfile: 'Dockerfile', docker: 'Dockerfile' };
function codeLanguage(code) {
  const pending = code.getAttribute('data-language-pending');
  const match = /(?:^|\s)(?:language|lang)-([^\s]+)/i.exec(code.className || '');
  const language = String(pending || match?.[1] || 'plaintext').split(/\s+/)[0].toLowerCase();
  return /^[a-z0-9_+#.-]{1,50}$/.test(language) ? language : 'plaintext';
}
function languageLabel(language) {
  return language.startsWith('diff-') ? `Diff · ${LANGUAGE_LABELS[language.slice(5)] || language.slice(5)}` : LANGUAGE_LABELS[language] || language;
}

function prepareCode(root, document, highlighter, fresh) {
  for (const pre of [...root.querySelectorAll('pre')]) {
    const original = pre.querySelector('code');
    if (!original) continue;
    const language = codeLanguage(original);
    const source = codeSource(original, language);
    const code = document.createElement('code');
    code.className = `wx-code-text hljs language-${language}`;
    code.setAttribute('data-wx-code', 'true');
    code.textContent = source;
    const highlightLanguage = language.startsWith('diff-') ? 'diff' : language;
    try {
      if (highlighter?.getLanguage?.(highlightLanguage)) {
        const result = highlighter.highlight(source, { language: highlightLanguage, ignoreIllegals: true });
        if (typeof result?.value === 'string') code.innerHTML = result.value;
      }
    } catch {
      // Highlighting is optional. The DOM text assignment above is the safe fallback.
      code.textContent = source;
    }
    pre.replaceChildren(code);
    if (fresh) {
      pre.className = 'wx-code-pre';
      pre.removeAttribute('style');
      let block = pre.parentElement;
      if (!block?.classList.contains('wx-code-block')) {
        block = document.createElement('section');
        block.className = 'wx-code-block';
        pre.replaceWith(block);
        block.append(pre);
      }
      for (const prior of [...block.querySelectorAll('.wx-code-caption')]) prior.remove();
      const caption = document.createElement('div');
      caption.className = 'wx-code-caption';
      caption.textContent = languageLabel(language);
      block.insertBefore(caption, pre);
    } else {
      pre.classList.add('wx-code-pre');
    }
  }
}

function ownRows(table) {
  return [...table.querySelectorAll('tr')].filter((row) => row.closest('table') === table);
}
function ownCells(row) {
  return [...row.children].filter((cell) => cell.tagName === 'TH' || cell.tagName === 'TD');
}
function tableModel(table) {
  const rows = ownRows(table);
  const head = table.querySelector('thead');
  const headers = head ? [...head.querySelectorAll('th,td')].filter((cell) => cell.closest('table') === table) : rows.length && ownCells(rows[0]).every((cell) => cell.tagName === 'TH') ? ownCells(rows[0]) : [];
  const body = rows.filter((row) => !row.closest('thead') && !(headers.length && !head && row === rows[0]));
  const count = Math.max(headers.length, ...body.map((row) => ownCells(row).length), 0);
  const complex = !!table.querySelector('table,tfoot') || [...table.querySelectorAll('[rowspan],[colspan]')].some((cell) => Number(cell.getAttribute('rowspan') || 1) !== 1 || Number(cell.getAttribute('colspan') || 1) !== 1) || (head && head.querySelectorAll('tr').length > 1) || body.some((row) => ownCells(row).length !== count);
  const widths = Array.from({ length: count }, () => 0);
  for (const cells of [headers, ...body.map(ownCells)]) cells.forEach((cell, index) => {
    const width = [...cell.textContent.trim()].reduce((sum, char) => sum + (/[^\u0000-\u00ff]/.test(char) ? 13 : 7), 0);
    widths[index] = Math.max(widths[index] || 0, width + 22);
  });
  return { headers, body, count, complex, width: widths.reduce((sum, width) => sum + width, 0) };
}

function tableTarget(table, root) {
  const parent = table.parentElement;
  return parent && parent !== root && parent.tagName === 'SECTION' && !parent.classList.contains('container') && parent.children.length === 1 && parent.firstElementChild === table ? parent : table;
}
function copyContent(source, destination) {
  for (const child of [...source.childNodes]) destination.append(child.cloneNode(true));
}
function prepareTables(root, settings, document) {
  for (const table of [...root.querySelectorAll('table')]) {
    if (!root.contains(table) || table.closest('pre,code') || table.parentElement?.closest('table')) continue;
    if (table.closest('.wx-table-scroll')) continue;
    const model = tableModel(table);
    const target = tableTarget(table, root);
    if (settings.table_mode === 'cards' && !model.complex && model.body.length && model.count) {
      const cards = document.createElement('section');
      cards.className = 'wx-table-cards';
      const caption = table.querySelector('caption');
      if (caption) {
        const title = document.createElement('div');
        title.className = 'wx-table-caption';
        copyContent(caption, title);
        cards.append(title);
      }
      for (const row of model.body) {
        const card = document.createElement('section');
        card.className = 'wx-table-card';
        ownCells(row).forEach((cell, index) => {
          const field = document.createElement('div');
          field.className = 'wx-table-field';
          const key = document.createElement('span');
          key.className = 'wx-table-key';
          if (model.headers[index]) copyContent(model.headers[index], key);
          else key.textContent = `列 ${index + 1}`;
          const value = document.createElement('div');
          value.className = 'wx-table-value';
          copyContent(cell, value);
          field.append(key, value);
          card.append(field);
        });
        cards.append(card);
      }
      target.replaceWith(cards);
      continue;
    }
    if (settings.table_mode === 'scroll' || settings.table_mode === 'cards' || model.complex || model.width > 310) {
      const block = document.createElement('section');
      block.className = 'wx-table-block';
      const hint = document.createElement('div');
      hint.className = 'wx-table-hint';
      hint.textContent = '左右滑动查看完整表格';
      const scroll = document.createElement('section');
      scroll.className = 'wx-table-scroll';
      target.replaceWith(block);
      block.append(hint, scroll);
      scroll.append(table);
      table.style.setProperty('min-width', `${Math.max(360, Math.min(1600, model.width))}px`);
    } else {
      table.classList.add('wx-table-fit');
      if (target !== table) target.replaceWith(table);
    }
  }
}

function prepareAlerts(root, document) {
  const labels = { note: '提示', tip: '建议', warning: '注意', important: '重要', caution: '警告' };
  for (const quote of [...root.querySelectorAll('blockquote')]) {
    const classMatch = /(?:^|\s)markdown-alert-(note|tip|warning|important|caution)(?:\s|$)/.exec(quote.className);
    const firstParagraph = [...quote.children].find((child) => child.tagName === 'P');
    const marker = firstParagraph && /^\[!(NOTE|TIP|WARNING|IMPORTANT|CAUTION)\]/i.exec(firstParagraph.textContent);
    const kind = classMatch?.[1] || marker?.[1].toLowerCase();
    if (!kind) continue;
    quote.classList.add('wx-alert', `wx-alert-${kind}`);
    let title = quote.querySelector('.markdown-alert-title,.wx-alert-title');
    if (!title) {
      title = document.createElement('p');
      title.textContent = labels[kind];
      quote.insertBefore(title, quote.firstChild);
    }
    title.classList.add('wx-alert-title');
    if (marker) {
      // Marked's ordinary quote output starts this marker in the first text node.
      const text = [...firstParagraph.childNodes].find((node) => node.nodeType === 3 && /^\[!/i.test(node.nodeValue));
      if (text) text.nodeValue = text.nodeValue.replace(/^\[!(?:NOTE|TIP|WARNING|IMPORTANT|CAUTION)\][ \t]*/i, '');
      if (firstParagraph.firstChild?.nodeType === 3 && !firstParagraph.firstChild.nodeValue) firstParagraph.firstChild.remove();
      if (firstParagraph.firstChild?.nodeName === 'BR') firstParagraph.firstChild.remove();
    }
  }
}

/** Prepare renderer HTML before both preview CSS and Juice export inlining. */
export function prepareTypography(html, options = {}, document = globalThis.document, highlighter = globalThis.hljs) {
  const theme = typeof options?.theme === 'string' ? options.theme : 'technical';
  const settings = normalizeTypography(options, theme);
  const fresh = NEW_THEMES.has(theme);
  if (!fresh && settings.font_family === 'theme' && settings.font_size === 16 && settings.code_wrap === 'scroll' && settings.table_mode === 'auto') return { html, css: '' };
  if (!document?.createElement) throw new Error('Typography rendering requires a DOM document');
  const holder = document.createElement('div');
  holder.innerHTML = html;
  let root = holder.children.length === 1 && holder.firstElementChild.classList.contains('wx-typography') ? holder.firstElementChild : null;
  if (!root) {
    root = document.createElement('section');
    while (holder.firstChild) root.append(holder.firstChild);
    holder.append(root);
  }
  root.className = `wx-typography${fresh ? ` wx-theme-${theme}` : ' wx-theme-legacy'}`;
  if (fresh || settings.code_wrap === 'wrap') prepareCode(root, document, highlighter, fresh);
  if (fresh || settings.table_mode !== 'auto') prepareTables(root, settings, document);
  if (fresh) prepareAlerts(root, document);
  return { html: holder.innerHTML, css: typographyCSS(settings, theme, fresh, options?.palette) };
}
