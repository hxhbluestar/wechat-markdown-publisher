import { TYPO_RULES } from './proofreading-dictionary-20261017-proof.mjs';

// Synchronous analysis stays bounded even when a pasted document is very large.
export const MAX_ANALYSIS_LENGTH = 200000;
export const MAX_ISSUES = 500;
export const RULE_COUNT = TYPO_RULES.length;

// Chinese prose often directly touches these names: “使用GPU” is not an identifier.
const technicalNames = /(?:ROCm|Radeon|Instinct|Ryzen|Threadripper|EPYC|CUDA|OpenCL|Vulkan|DirectML|PyTorch|TensorFlow|ONNX|DeepSeek|ChatGPT|OpenAI|Llama|Qwen|Hunyuan|LLVM|Clang|CMake|Python|JavaScript|TypeScript|Node\.js|gfx\d+[a-z]*|GPT(?:-\d+(?:\.\d+)*)?|GPU|CPU|NPU|APU|HIP|AMD|NVIDIA|Intel|API|AI|Max\+?|PRO|v\d+(?:\.\d+)*)/gi;

const rulesByFirstCharacter = new Map();
for (const rule of TYPO_RULES) {
  const bucket = rulesByFirstCharacter.get(rule.original[0]) || [];
  bucket.push(rule);
  rulesByFirstCharacter.set(rule.original[0], bucket);
}
for (const bucket of rulesByFirstCharacter.values()) {
  bucket.sort((a, b) => b.original.length - a.original.length || a.original.localeCompare(b.original, 'zh-CN'));
}

function mark(mask, from, to) {
  mask.fill(1, from, to);
}

function isClear(mask, from, to) {
  for (let i = from; i < to; i++) if (mask[i]) return false;
  return true;
}

function tagEnd(text, start) {
  let quote = '';
  for (let i = start + 1; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') return i + 1;
  }
  return text.length;
}

/** A conservative Markdown scanner. It never rewrites or normalizes the source. */
function protectedMask(text) {
  const mask = new Uint8Array(text.length);
  let fence = null;
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline + 1;
    const raw = text.slice(start, end).replace(/\r?\n$/, '');
    const unquoted = raw.replace(/^(?: {0,3}>[ \t]?)*/, '');
    const line = unquoted.replace(/^ {0,3}/, '');
    if (fence) {
      mark(mask, start, end);
      const closing = /^(\x60+|~+)[ \t]*$/.exec(line);
      if (closing && closing[1][0] === fence.char && closing[1].length >= fence.length) fence = null;
    } else {
      const opening = /^(?:(?:[-+*]|\d+[.)])[ \t]+)?(\x60{3,}|~{3,})/.exec(line);
      if (opening) {
        fence = { char: opening[1][0], length: opening[1].length };
        mark(mask, start, end);
      } else if (/^(?: {4}|\t)/.test(unquoted) || /^ {0,3}\[[^\]\r\n]+\]:/.test(unquoted)) {
        mark(mask, start, end);
      }
    }
    start = end;
  }

  // Tags are scanned with quote awareness so an attribute containing > stays safe.
  for (let i = 0; i < text.length; i++) {
    if (mask[i] || text[i] !== '<') continue;
    if (text.startsWith('<!--', i)) {
      const closing = text.indexOf('-->', i + 4);
      const end = closing === -1 ? text.length : closing + 3;
      mark(mask, i, end);
      i = end - 1;
      continue;
    }
    if (!/[A-Za-z/!?]/.test(text[i + 1] || '')) continue;
    let end = tagEnd(text, i);
    const raw = /^<(pre|code|style|script)(?=[\s/>])/i.exec(text.slice(i, i + 12));
    if (raw && !text.slice(i, end).endsWith('/>')) {
      const closing = new RegExp(`</${raw[1]}\\s*>`, 'ig');
      closing.lastIndex = end;
      const match = closing.exec(text);
      end = match ? match.index + match[0].length : text.length;
    }
    mark(mask, i, end);
    i = end - 1;
  }

  // Precompute matching backtick runs; unmatched backticks remain normal prose.
  const runs = [];
  for (let i = 0; i < text.length; i++) {
    if (mask[i] || text[i] !== '`') continue;
    const from = i;
    while (text[i] === '`') i++;
    runs.push({ from, to: i });
    i--;
  }
  const nextRun = new Map();
  for (let i = runs.length - 1; i >= 0; i--) {
    const size = runs[i].to - runs[i].from;
    runs[i].next = nextRun.get(size);
    nextRun.set(size, i);
  }
  for (let i = 0; i < runs.length; i++) {
    if (runs[i].next !== undefined) {
      const closing = runs[i].next;
      mark(mask, runs[i].from, runs[closing].to);
      i = closing;
    }
  }

  // Keep labels/alt text readable; protect only the adjacent destination or ID.
  for (let i = 0; i < text.length - 1; i++) {
    if (mask[i] || text[i] !== ']') continue;
    const next = text[i + 1];
    if (next === '(') {
      let depth = 1;
      let quote = '';
      let end = i + 2;
      for (; end < text.length; end++) {
        const char = text[end];
        if (char === '\\') { end++; continue; }
        if (quote) { if (char === quote) quote = ''; continue; }
        if (char === '"' || char === "'") { quote = char; continue; }
        if (char === '(') depth++;
        if (char === ')' && --depth === 0) { end++; break; }
        if (char === '\n') break;
      }
      mark(mask, i + 1, end);
      i = end - 1;
    } else if (next === '[') {
      const closing = text.indexOf(']', i + 2);
      const newline = text.indexOf('\n', i + 2);
      const end = closing === -1 || (newline !== -1 && newline < closing)
        ? (newline === -1 ? text.length : newline) : closing + 1;
      mark(mask, i + 1, end);
      i = end - 1;
    }
  }

  const urls = /\b(?:https?:\/\/|ftp:\/\/|mailto:|www\.)[^\s<>"'`，。！？；：（）【】]+/gi;
  for (const match of text.matchAll(urls)) mark(mask, match.index, match.index + match[0].length);
  const paths = /(?:[A-Za-z]:[\\/]|\\\\|\.{1,2}[\\/]|\/(?=[A-Za-z0-9_.~\u3400-\u9fff]))[^\s<>"'`，。！？；：（）【】]+/g;
  for (const match of text.matchAll(paths)) mark(mask, match.index, match.index + match[0].length);

  // Tokenize once rather than retrying a filename regex at every character.
  const tokens = /[\p{L}\p{N}_.$@+%-]+/gu;
  let nextBracket = text.indexOf(']');
  let nextNewline = text.indexOf('\n');
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    const from = match.index;
    if (mask[from]) continue;
    const to = from + token.length;
    const filename = /\.(?:md|mdx|markdown|txt|json|jsonl|ya?ml|toml|ini|conf|config|log|csv|tsv|xml|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|py|pyc|ipynb|sh|ps1|bat|cmd|exe|dll|so|a|o|obj|lib|h|hpp|c|cc|cpp|cu|hip|rs|go|java|kt|swift|sql|db|sqlite|png|jpe?g|gif|webp|svg|ico|pdf|docx?|xlsx?|pptx?|zip|tar|gz|7z|mp[34]|wav|srt|vtt)$/i.test(token);
    const identifier = /[_$]/.test(token) || (/[\u3400-\u9fff]/.test(token) && /[A-Za-z]/.test(token.replace(technicalNames, '')));
    if (filename || identifier || text[to] === '(') mark(mask, from, to);
    if (/^[A-Za-z_$][\w$]*$/.test(token) && text[to] === '[') {
      if (nextBracket !== -1 && nextBracket <= to) nextBracket = text.indexOf(']', to + 1);
      if (nextNewline !== -1 && nextNewline <= to) nextNewline = text.indexOf('\n', to + 1);
      if (nextBracket !== -1 && (nextNewline === -1 || nextBracket < nextNewline)) mark(mask, from, nextBracket + 1);
    }
  }
  return mask;
}

function makeIssue(from, original, replacement, kind, confidence) {
  const to = from + original.length;
  return {
    id: `${kind}:${from}:${to}:${original}`,
    from, to, original, replacement,
    message: kind === 'typo' ? `“${original}”可能应为“${replacement}”` : '连续标点可能有误，请结合语气确认',
    kind, confidence,
  };
}

/** Analyze local text only. Offsets are JavaScript UTF-16 string indices. */
export function analyzeMarkdown(text, { ignoredWords = [] } = {}) {
  return analyzeSource(text,{ignoredWords});
}

// During correction validation only collect the requested IDs. Ignored phrases
// earlier in the document must not consume the public 500-suggestion budget.
function analyzeSource(text, { ignoredWords = [] } = {}, wantedIds=null) {
  if (typeof text !== 'string') throw new TypeError('Proofreading text must be a string');
  if (!Array.isArray(ignoredWords) || ignoredWords.some(word => typeof word !== 'string')) {
    throw new TypeError('ignoredWords must be an array of strings');
  }
  const source = text.slice(0, MAX_ANALYSIS_LENGTH);
  const mask = protectedMask(source);
  const ignored = new Set(ignoredWords);
  const issues = [];
  let truncated = source.length < text.length;
  for (let from = 0; from < source.length; from++) {
    if (mask[from]) continue;
    let issue;
    for (const rule of rulesByFirstCharacter.get(source[from]) || []) {
      const to = from + rule.original.length;
      if (source.startsWith(rule.original, from) && isClear(mask, from, to)) {
        if (!ignored.has(rule.original)) issue = makeIssue(from, rule.original, rule.replacement, 'typo', rule.confidence);
        // Prefer the full phrase even when that exact phrase is ignored.
        from = to - 1;
        break;
      }
    }
    if (!issue && /[，,。；;：:！？!?、]/.test(source[from])) {
      let to = from + 1;
      while (to < source.length && source[to] === source[from] && !mask[to]) to++;
      if (to > from + 1) {
        const original = source.slice(from, to);
        if (!ignored.has(original)) issue = makeIssue(from, original, source[from], 'punctuation', 'review');
        from = to - 1;
      }
    }
    if (issue && (!wantedIds || wantedIds.has(issue.id))) {
      if (issues.length === MAX_ISSUES) { truncated = true; break; }
      issues.push(issue);
    }
  }
  return { issues, truncated };
}

function ownValue(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Invalid proofreading suggestion');
  return descriptor.value;
}

/**
 * Validate the entire selection before constructing a result. Reanalysis also
 * prevents forged suggestions from editing protected Markdown or inserting HTML.
 */
export function applyCorrections(text, issues) {
  if (typeof text !== 'string' || !Array.isArray(issues) || issues.length > MAX_ISSUES) {
    throw new TypeError('Invalid proofreading correction request');
  }
  const wantedIds=new Set(Array.from({length:issues.length},(_,index)=>ownValue(ownValue(issues,String(index)),'id')));
  const current = new Map(analyzeSource(text,{},wantedIds).issues.map(issue => [issue.id, issue]));
  const changes = [];
  for (let index = 0; index < issues.length; index++) {
    const issue = ownValue(issues, String(index));
    if (!issue || typeof issue !== 'object' || (Object.getPrototypeOf(issue) !== Object.prototype && Object.getPrototypeOf(issue) !== null)) {
      throw new TypeError('Invalid proofreading suggestion');
    }
    const values = Object.fromEntries(['id', 'from', 'to', 'original', 'replacement', 'kind', 'confidence']
      .map(key => [key, ownValue(issue, key)]));
    const { from, to, original, replacement, id } = values;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to > text.length ||
        typeof original !== 'string' || typeof replacement !== 'string' || replacement.length === 0 ||
        typeof id !== 'string' || text.slice(from, to) !== original) {
      throw new Error('Proofreading suggestion is stale or invalid');
    }
    const expected = current.get(id);
    if (!expected || Object.keys(values).some(key => values[key] !== expected[key])) {
      throw new Error('Proofreading suggestion is stale or invalid');
    }
    changes.push({ from, to, insert: replacement });
  }
  changes.sort((a, b) => a.from - b.from || a.to - b.to);
  for (let i = 1; i < changes.length; i++) {
    if (changes[i].from < changes[i - 1].to) throw new Error('Proofreading suggestions overlap');
  }
  const pieces = [];
  let cursor = 0;
  for (const change of changes) {
    pieces.push(text.slice(cursor, change.from), change.insert);
    cursor = change.to;
  }
  pieces.push(text.slice(cursor));
  return { text: pieces.join(''), changes };
}
