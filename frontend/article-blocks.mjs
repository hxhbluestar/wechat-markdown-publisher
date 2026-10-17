// Controlled block styles: IDs depend on kind and original Markdown, never index.
// Ambiguous source or rendered matches deliberately remain unbound. Call with
// annotate:true only for preview; export uses inline styles without annotations.
import { sourceBlocks } from "./scroll-sync.mjs";

const K =
  "428a2f98 71374491 b5c0fbcf e9b5dba5 3956c25b 59f111f1 923f82a4 ab1c5ed5 d807aa98 12835b01 243185be 550c7dc3 72be5d74 80deb1fe 9bdc06a7 c19bf174 e49b69c1 efbe4786 0fc19dc6 240ca1cc 2de92c6f 4a7484aa 5cb0a9dc 76f988da 983e5152 a831c66d b00327c8 bf597fc7 c6e00bf3 d5a79147 06ca6351 14292967 27b70a85 2e1b2138 4d2c6dfc 53380d13 650a7354 766a0abb 81c2c92e 92722c85 a2bfe8a1 a81a664b c24b8b70 c76c51a3 d192e819 d6990624 f40e3585 106aa070 19a4c116 1e376c08 2748774c 34b0bcb5 391c0cb3 4ed8aa4a 5b9cca4f 682e6ff3 748f82ee 78a5636f 84c87814 8cc70208 90befffa a4506ceb bef9a3f7 c67178f2"
    .split(" ")
    .map((value) => parseInt(value, 16));
const rotr = (value, amount) => (value >>> amount) | (value << (32 - amount));
function digest(text) {
  const bytes = new TextEncoder().encode(text),
    buffer = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  buffer.set(bytes);
  buffer[bytes.length] = 128;
  const view = new DataView(buffer.buffer);
  view.setUint32(buffer.length - 4, bytes.length * 8);
  view.setUint32(buffer.length - 8, Math.floor(bytes.length / 536870912));
  const hash = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
      0x1f83d9ab, 0x5be0cd19,
    ],
    w = new Int32Array(64);
  for (let offset = 0; offset < buffer.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15],
        b = w[i - 2];
      w[i] =
        (w[i - 16] +
          (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) +
          w[i - 7] +
          (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) |
        0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i++) {
      const t1 =
          (h +
            (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
            ((e & f) ^ (~e & g)) +
            K[i] +
            w[i]) |
          0,
        t2 =
          ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) +
            ((a & b) ^ (a & c) ^ (b & c))) |
          0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    [a, b, c, d, e, f, g, h].forEach((value, i) => {
      hash[i] = (hash[i] + value) | 0;
    });
  }
  return hash
    .map((value) => (value >>> 0).toString(16).padStart(8, "0"))
    .join("");
}
const own = (object, key) =>
  object && typeof object === "object"
    ? Object.getOwnPropertyDescriptor(object, key)?.value
    : undefined;
const allowedKind = (kind) =>
  typeof kind === "string" && /^(?:h[1-6]|p|figcaption|table)$/.test(kind);
const entities = (text) =>
  text.replace(
    /&(?:#(x[0-9a-f]+|[0-9]+)|amp|lt|gt|quot|apos|nbsp);/gi,
    (match, number) => {
      if (!number)
        return {
          "&amp;": "&",
          "&lt;": "<",
          "&gt;": ">",
          "&quot;": '"',
          "&apos;": "'",
          "&nbsp;": " ",
        }[match.toLowerCase()];
      const code =
        number[0].toLowerCase() === "x"
          ? parseInt(number.slice(1), 16)
          : Number(number);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "�";
    },
  );
function inline(text) {
  return entities(
    String(text || "")
      .replace(/!?(?:\[([^\]]*)\])\([^\n]*?\)/g, "$1")
      .replace(/<[^>]*>/g, "")
      .replace(/`+([^`]*?)`+/g, "$1")
      .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
      .replace(/_{2}([^_]+)_{2}/g, "$1")
      .replace(/~~([^~]+)~~/g, "$1")
      .replace(/\\([\\`*{}_\[\]()#+.!>-])/g, "$1"),
  );
}
const plainToken = (token) =>
  Array.isArray(token.tokens)
    ? token.tokens.map(plainToken).join("")
    : entities(String(token.text || ""));
const normalized = (text) =>
  String(text || "")
    .replace(/\s+/g, "")
    .normalize("NFC");

function fallbackTokens(source) {
  const lines = source.replace(/\r\n?/g, "\n").split(/(?<=\n)/),
    tokens = [];
  let index = 0;
  if (/^\ufeff?---\s*\n$/.test(lines[0] || "")) {
    index = 1;
    while (
      index < lines.length &&
      !/^(?:---|\.\.\.)\s*(?:\n|$)/.test(lines[index])
    )
      index++;
    index = Math.min(lines.length, index + 1);
  }
  const special = (line) =>
    /^ {0,3}(?:#{1,6}\s|`{3,}|~{3,}|>|[-+*]\s|\d+\.\s|<)/.test(line);
  while (index < lines.length && tokens.length < 2000) {
    const start = index,
      line = lines[index];
    if (!line.trim()) {
      tokens.push({ type: "space", raw: line });
      index++;
      continue;
    }
    const fence = /^ {0,3}(`{3,}|~{3,})([^\n]*)/.exec(line);
    if (fence) {
      index++;
      while (
        index < lines.length &&
        !new RegExp(
          "^ {0,3}" + fence[1][0] + "{" + fence[1].length + ",}\\s*$",
        ).test(lines[index].trimEnd())
      )
        index++;
      if (index < lines.length) index++;
      tokens.push({
        type: "code",
        raw: lines.slice(start, index).join(""),
        text: lines.slice(start + 1, index - 1).join(""),
      });
      continue;
    }
    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.trimEnd());
    if (heading) {
      tokens.push({
        type: "heading",
        depth: heading[1].length,
        text: heading[2],
        raw: line,
      });
      index++;
      continue;
    }
    if (
      index + 1 < lines.length &&
      /^ {0,3}(?:=+|-+)\s*$/.test(lines[index + 1].trimEnd())
    ) {
      tokens.push({
        type: "heading",
        depth: lines[index + 1].trim()[0] === "=" ? 1 : 2,
        text: line.trim(),
        raw: line + lines[index + 1],
      });
      index += 2;
      continue;
    }
    if (
      index + 1 < lines.length &&
      line.includes("|") &&
      /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(
        lines[index + 1].trimEnd(),
      )
    ) {
      index += 2;
      while (
        index < lines.length &&
        lines[index].includes("|") &&
        lines[index].trim()
      )
        index++;
      tokens.push({
        type: "table",
        raw: lines.slice(start, index).join(""),
        text: [line, ...lines.slice(start + 2, index)]
          .map((row) => row.replace(/\|/g, " "))
          .join(" "),
      });
      continue;
    }
    if (special(line)) {
      index++;
      while (
        index < lines.length &&
        lines[index].trim() &&
        !/^ {0,3}#{1,6}\s/.test(lines[index])
      )
        index++;
      tokens.push({
        type: "unsupported",
        raw: lines.slice(start, index).join(""),
      });
      continue;
    }
    index++;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !special(lines[index])
    )
      index++;
    const raw = lines.slice(start, index).join("");
    tokens.push({ type: "paragraph", raw, text: raw.trim() });
  }
  return tokens;
}

/** Offsets are source UTF-16 positions. Duplicate IDs have ambiguous:true and
 * are never styled, even if only one duplicate happens to be visible in HTML.
 * lexMarkdown may return tokens or the existing {tokens,content} lexer format.
 */
export function describeBlocks(content, lexMarkdown) {
  content = String(content || "");
  if (content.length > 5 * 1024 * 1024)
    throw new RangeError("Article blocks exceed the 5 MiB analysis limit");
  let parsed = lexMarkdown?.(content);
  if (Array.isArray(parsed)) parsed = { tokens: parsed };
  if (!parsed?.tokens) parsed = { tokens: fallbackTokens(content) };
  const spans = sourceBlocks(content, parsed),
    tokens = parsed.tokens.filter(
      (token) => !["space", "def"].includes(token.type),
    );
  const blocks = [];
  // Pair by source span raw position rather than a DOM occurrence index.
  let tokenCursor = 0;
  for (const span of spans.slice(0, 2000)) {
    while (
      tokenCursor < tokens.length &&
      tokens[tokenCursor].type !== span.type
    )
      tokenCursor++;
    const token = tokens[tokenCursor++] || {},
      raw = content.slice(span.from, span.to);
    let kind =
      span.type === "heading"
        ? "h" + span.depth
        : span.type === "paragraph" || span.type === "text"
          ? "p"
          : span.type === "table"
            ? "table"
            : span.type === "code"
              ? "code"
              : null;
    if (!kind) continue;
    let text = token.tokens
      ? token.tokens.map(plainToken).join("")
      : inline(token.text || span.text);
    if (kind === "table" && token.header)
      text = [token.header, ...(token.rows || [])]
        .flat()
        .map((cell) =>
          cell.tokens
            ? cell.tokens.map(plainToken).join("")
            : inline(cell.text),
        )
        .join(" ");
    blocks.push({ kind, from: span.from, to: span.to, text: text.trim(), raw });
  }
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.kind !== "p") continue;
    const image = /^!\[([^\]]*)\]\([^\n]*?(?:\s+["']([^"']*)["'])?\)\s*$/.exec(
      block.raw.trim(),
    );
    if (!image) continue;
    const explanation =
      blocks[i + 1]?.kind === "p" &&
      /^(?:图\s*|figure\s*)\d+(?:[.-]\d+)*(?:\s*[:：.、-]\s*|\s+)\S/i.test(
        blocks[i + 1].text,
      )
        ? blocks[i + 1]
        : null;
    const alt = image[1].trim(),
      title = image[2]?.trim() || "";
    const generic =
      /^(?:(?:image|img|photo|picture|图片|图像|照片)[\s_-]*\d*|(?:图|figure)[\s_-]*\d+|[^\s]+\.(?:png|jpe?g|gif|webp|svg)|(?:微信图片|微信截图|截图|屏幕截图|screenshot|IMG|DSC|PXL)[\s_-]*\d[\da-z\s_.:()-]*)$/i.test(
        alt,
      );
    const description = title || (!explanation && !generic ? alt : "");
    block.kind = description || explanation ? "figcaption" : "image";
    block.text = description;
    if (explanation) {
      if (normalized(description) !== normalized(explanation.text))
        block.text = [description, explanation.text].filter(Boolean).join("\n");
      block.to = explanation.to;
      block.raw = content.slice(block.from, block.to);
      blocks.splice(i + 1, 1);
    }
  }
  const counts = new Map();
  for (const block of blocks) {
    block.id =
      "block-" +
      digest(block.kind + "\0" + block.raw.replace(/\r\n?/g, "\n").trim());
    counts.set(block.id, (counts.get(block.id) || 0) + 1);
  }
  return blocks.map((block) => ({
    ...block,
    ambiguous: counts.get(block.id) > 1,
  }));
}

export function normalizeBlockOverrides(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = [];
  for (const id of Object.keys(value).sort()) {
    if (result.length >= 200) break;
    if (!/^block-[a-f0-9]{64}$/.test(id)) continue;
    const input = own(value, id),
      kind = own(input, "kind");
    if (!allowedKind(kind)) continue;
    const output = { kind },
      limits =
        kind === "p"
          ? [15, 22]
          : kind === "table" || kind === "figcaption"
            ? [12, 16]
            : [18, 32];
    for (const field of [
      "font_size",
      "margin_before",
      "margin_after",
      "line_height",
    ]) {
      const number = own(input, field);
      if (typeof number !== "number" || !Number.isFinite(number)) continue;
      if (
        (field === "font_size" &&
          Number.isInteger(number) &&
          number >= limits[0] &&
          number <= limits[1]) ||
        (/^margin_/.test(field) &&
          Number.isInteger(number) &&
          number >= 0 &&
          number <= 48) ||
        (field === "line_height" && number >= 1.2 && number <= 2.4)
      )
        output[field] = number;
    }
    if (Object.keys(output).length > 1) result.push([id, output]);
  }
  return Object.fromEntries(result);
}

function matchElements(root, blocks) {
  const candidates = [
    ...root.querySelectorAll(
      "h1,h2,h3,h4,h5,h6,p,figcaption,.md-figcaption,table",
    ),
  ].filter((element) => {
    if (element.closest("pre,code,script,style,svg,math,template"))
      return false;
    if (
      element.tagName === "P" &&
      (element.closest("figcaption,.md-figcaption,table,li,blockquote") ||
        element.querySelector("img"))
    )
      return false;
    if (
      /^H[1-6]$/.test(element.tagName) &&
      element.closest("table,figure,li,blockquote")
    )
      return false;
    return true;
  });
  const elementKind = (element) =>
    element.matches("figcaption,.md-figcaption")
      ? "figcaption"
      : element.tagName.toLowerCase();
  const matches = new Map(),
    reasons = new Map();
  const sourceCounts = new Map(),
    rendered = new Map(),
    key = (kind, text) => kind + "\0" + normalized(text);
  for (const block of blocks) {
    const value = key(block.kind, block.text);
    sourceCounts.set(value, (sourceCounts.get(value) || 0) + 1);
  }
  for (const element of candidates) {
    const value = key(elementKind(element), element.textContent);
    if (!rendered.has(value)) rendered.set(value, []);
    rendered.get(value).push(element);
  }
  for (const block of blocks) {
    if (!allowedKind(block.kind)) continue;
    if (block.ambiguous) {
      reasons.set(block.id, "ambiguous");
      continue;
    }
    const value = key(block.kind, block.text),
      sameSource = sourceCounts.get(value),
      found = rendered.get(value) || [];
    if (found.length === 1 && sameSource === 1) matches.set(block.id, found[0]);
    else
      reasons.set(
        block.id,
        found.length > 1 || (sameSource > 1 && found.length)
          ? "render-ambiguous"
          : "render-unmatched",
      );
  }
  return { candidates, matches, reasons };
}

/** Returns {html,blocks,unmatched:[{id,reason}]}. No DOM string mutation occurs
 * with empty overrides and annotate:false. Annotation is rebuilt by matching
 * semantic text; preexisting data attributes are never trusted as identities.
 */
export function applyBlockOverrides(html, content, value, options = {}) {
  const blocks = describeBlocks(content, options.lexMarkdown),
    overrides = normalizeBlockOverrides(value);
  if (!Object.keys(overrides).length && !options.annotate)
    return { html, blocks, unmatched: [] };
  const document = options.document;
  if (!document?.createElement)
    throw new TypeError("A trusted DOM document is required for block styles");
  const root = document.createElement("div");
  root.innerHTML = html;
  const { candidates, matches, reasons } = matchElements(root, blocks),
    byId = new Map(blocks.map((block) => [block.id, block])),
    unmatched = [];
  for (const element of candidates) {
    element.removeAttribute("data-article-block");
    element.removeAttribute("data-article-block-kind");
  }
  if (options.annotate)
    for (const [id, element] of matches) {
      element.setAttribute("data-article-block", id);
      element.setAttribute("data-article-block-kind", byId.get(id).kind);
    }
  for (const [id, override] of Object.entries(overrides)) {
    const block = byId.get(id),
      element = matches.get(id);
    const reason = !block
      ? "missing"
      : block.kind !== override.kind
        ? "kind-mismatch"
        : reasons.get(id);
    if (reason || !element) {
      unmatched.push({ id, reason: reason || "render-unmatched" });
      continue;
    }
    const set = (node, key, value) =>
      node.style.setProperty(key, String(value), "important");
    if (override.font_size !== undefined) {
      set(element, "font-size", override.font_size + "px");
      for (const child of element.querySelectorAll("span,strong,em,a,p,th,td"))
        if (!child.closest("pre,code,svg,math"))
          set(child, "font-size", "inherit");
    }
    if (override.line_height !== undefined) {
      set(element, "line-height", override.line_height);
      for (const child of element.querySelectorAll("span,strong,em,a,p,th,td"))
        if (!child.closest("pre,code,svg,math"))
          set(child, "line-height", "inherit");
    }
    const wrapper = element.parentElement?.classList.contains("wx-flow-block")
      ? element.parentElement
      : null;
    if (override.margin_before !== undefined) {
      if (wrapper) set(wrapper, "padding-top", "0px");
      set(element, "margin-top", override.margin_before + "px");
    }
    if (override.margin_after !== undefined)
      set(element, "margin-bottom", override.margin_after + "px");
  }
  return { html: root.innerHTML, blocks, unmatched };
}
