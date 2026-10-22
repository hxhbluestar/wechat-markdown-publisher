const BLOCKS =
  "h1,h2,h3,h4,h5,h6,p,figure,pre,blockquote,ul,ol,table,hr,.wx-code-block,.wx-table-block,.wx-table-cards,.wx-alert,.katex-block";
const normalize = (text) =>
  String(text || "")
    .replace(/<[^>]*>/g, "")
    .replace(/[\s*_`~#\\]/g, "")
    .toLowerCase();
const plain = (token) =>
  token.tokens
    ? token.tokens.map(plain).join("")
    : token.items
      ? token.items.map(plain).join("")
      : token.text || "";
const codeText = (node) => {
  if(node.nodeType===3) return node.nodeValue;
  if(node.nodeType!==1 || node.getAttribute('data-wx-code-line-number')==='true') return '';
  if(node.tagName==='BR') return '\n';
  return [...node.childNodes].map(codeText).join('');
};

export function scrollSyncMarkup() {
  return '<button class="sync-scroll-toggle" id="syncScrollToggle" type="button" aria-pressed="true" title="左右双向同步滚动；点击可独立查看">⇅ 同步滚动</button>';
}

export function sourceBlocks(source, { tokens = [], content = source } = {}) {
  const chars = [],
    positions = [];
  for (let i = 0; i < source.length; i++) {
    positions.push(i);
    chars.push(source[i] === "\r" ? "\n" : source[i]);
    if (source[i] === "\r" && source[i + 1] === "\n") i++;
  }
  positions.push(source.length);
  const normalized = chars.join(""),
    body = content.replace(/\r\n?/g, "\n");
  let cursor = Math.max(0, normalized.indexOf(body));
  const blocks = [];
  for (const token of tokens) {
    const raw = (token.raw || "").replace(/\r\n?/g, "\n");
    if (!raw) continue;
    const start = normalized.indexOf(raw, cursor);
    if (start < 0) continue;
    cursor = start + raw.length;
    if (["space", "def"].includes(token.type)) continue;
    blocks.push({
      type: token.type,
      depth: token.depth,
      text: plain(token),
      from: positions[start],
      to: positions[cursor],
    });
  }
  return blocks;
}

function compatible(block, element) {
  const tag = element.tagName;
  if (block.type === "heading") return tag === "H" + block.depth;
  if (block.type === "paragraph" || block.type === "text")
    return ["P", "FIGURE"].includes(tag);
  if (block.type === "code")
    return tag === "PRE" || element.classList.contains("wx-code-block");
  if (block.type === "blockquote")
    return tag === "BLOCKQUOTE" || element.classList.contains("wx-alert");
  if (block.type === "list") return ["UL", "OL"].includes(tag);
  if (block.type === "table")
    return (
      tag === "TABLE" || element.matches(".wx-table-block,.wx-table-cards")
    );
  return block.type === "hr" && tag === "HR";
}
export function matchPreviewBlocks(preview, blocks) {
  const candidates = [...preview.querySelectorAll(BLOCKS)].filter(
    (el) => !el.parentElement.closest(BLOCKS),
  );
  const matches = [];
  let cursor = 0;
  for (const block of blocks) {
    const expected = normalize(block.text);
    for (let i = cursor; i < candidates.length; i++) {
      const element = candidates[i];
      if (!compatible(block, element)) continue;
      const code = element.querySelector("code");
      const text =
        block.type === "code"
          ? codeText(code || element)
          : element.textContent +
            " " +
            [...element.querySelectorAll("img")]
              .map((img) => img.alt || "")
              .join(" ");
      const actual = normalize(text),
        size = Math.min(32, expected.length, actual.length);
      if (
        expected &&
        (!size ||
          (!actual.includes(expected.slice(0, size)) &&
            !expected.includes(actual.slice(0, size))))
      )
        continue;
      matches.push({ ...block, element });
      cursor = i + 1;
      break;
    }
  }
  return matches;
}

export function mapScrollPosition(position, pairs, from = "source") {
  if (!pairs.length) return 0;
  const to = from === "source" ? "preview" : "source";
  if (position <= pairs[0][from]) return pairs[0][to];
  for (let i = 1; i < pairs.length; i++)
    if (position <= pairs[i][from]) {
      const a = pairs[i - 1],
        b = pairs[i],
        span = b[from] - a[from];
      return span > 0
        ? a[to] + ((b[to] - a[to]) * (position - a[from])) / span
        : b[to];
    }
  return pairs.at(-1)[to];
}

export function connectScrollSync(container, { lexMarkdown, storage } = {}) {
  const doc = container.ownerDocument || container,
    win = doc.defaultView || globalThis;
  const preview = container.querySelector("#previewArticle"),
    stage = preview?.closest(".phone-stage"),
    toggle = container.querySelector("#syncScrollToggle");
  const storageKey = "wechat-editor-scroll-sync";
  let enabled = true,
    editor = null,
    matches = [],
    valid = false,
    draftId = null,
    frame = 0,
    active = "source",
    destroyed = false;
  const pending = new Map();
  try {
    storage = storage === undefined ? win.localStorage : storage;
    enabled = storage?.getItem(storageKey) !== "off";
  } catch {
    storage = null;
  }
  const raf =
    win.requestAnimationFrame?.bind(win) || ((fn) => win.setTimeout(fn, 16));
  const cancel =
    win.cancelAnimationFrame?.bind(win) || win.clearTimeout?.bind(win);
  function updateButton() {
    if (toggle) {
      toggle.setAttribute("aria-pressed", String(enabled));
      toggle.title = enabled
        ? "左右双向同步滚动；点击可独立查看"
        : "滚动同步已关闭；点击重新开启";
    }
  }
  function write(element, top) {
    if (Math.abs(element.scrollTop - top) < 0.5) return;
    element.scrollTop = top;
    pending.set(element, element.scrollTop);
  }
  function pairs() {
    const source = editor.scrollDOM,
      smax = Math.max(0, source.scrollHeight - source.clientHeight),
      pmax = Math.max(0, stage.scrollHeight - stage.clientHeight);
    if (!smax || !pmax) return [];
    const result = [{ source: 0, preview: 0 }],
      sourceBase =
        editor.documentTop -
        source.getBoundingClientRect().top -
        (source.clientTop || 0) +
        source.scrollTop;
    const previewBase =
      stage.scrollTop -
      stage.getBoundingClientRect().top -
      (stage.clientTop || 0);
    for (const match of matches) {
      const s =
        editor.lineBlockAt(Math.min(match.from, editor.state.doc.length)).top +
        sourceBase;
      const p = match.element.getBoundingClientRect().top + previewBase,
        last = result.at(-1);
      if (s > last.source && p > last.preview && s < smax && p < pmax)
        result.push({ source: s, preview: p });
    }
    result.push({ source: smax, preview: pmax });
    return result;
  }
  function sync() {
    frame = 0;
    if (
      destroyed ||
      !enabled ||
      !valid ||
      !editor ||
      !stage ||
      editor.scrollDOM.clientHeight <= 0 ||
      stage.clientHeight <= 0
    )
      return;
    const points = pairs();
    if (!points.length) return;
    const from = active === "source" ? editor.scrollDOM : stage,
      to = active === "source" ? stage : editor.scrollDOM;
    // Chromium can stop a fractional CSS pixel short of scrollHeight-clientHeight
    // at OS/display scaling. Do not amplify that rounding in a long preview.
    const maximum = points.at(-1)[active],
      position = from.scrollTop;
    const atEdge =
      maximum - position < 1.5 ? maximum : position < 1.5 ? 0 : position;
    write(to, mapScrollPosition(atEdge, points, active));
  }
  function schedule() {
    if (!frame && !destroyed) frame = raf(sync);
  }
  function scrolled(side, event) {
    const element = side === "source" ? editor?.scrollDOM : stage;
    if (!element || event.target !== element) return;
    const expected = pending.get(element);
    pending.delete(element);
    if (expected !== undefined && Math.abs(element.scrollTop - expected) < 1.5)
      return;
    active = side;
    schedule();
  }
  const sourceScrolled = (event) => scrolled("source", event),
    previewScrolled = (event) => scrolled("preview", event);
  const sourceIntent = () => {
      active = "source";
      pending.delete(editor?.scrollDOM);
    },
    previewIntent = () => {
      active = "preview";
      pending.delete(stage);
    };
  const intentEvents = ["wheel", "pointerdown", "touchstart", "keydown"];
  function listen(element, handler, action) {
    if (!element) return;
    element[action]("scroll", handler, { passive: true });
    for (const type of intentEvents)
      element[action](type, element === stage ? previewIntent : sourceIntent, {
        passive: true,
      });
  }
  function detachEditor() {
    if (editor) listen(editor.scrollDOM, sourceScrolled, "removeEventListener");
    pending.clear();
    editor = null;
    valid = false;
  }
  function attachEditor(view) {
    detachEditor();
    editor = view;
    listen(view.scrollDOM, sourceScrolled, "addEventListener");
    active = "source";
  }
  function invalidate() {
    valid = false;
    active = "source";
  }
  function refresh(id, text) {
    if (!preview || !stage || !editor) return;
    if (id !== draftId) {
      draftId = id;
      active = "source";
      write(editor.scrollDOM, 0);
      write(stage, 0);
    }
    try {
      matches = matchPreviewBlocks(
        preview,
        sourceBlocks(text, lexMarkdown?.(text)),
      );
    } catch {
      matches = [];
    }
    for (const match of matches) {
      match.element.setAttribute("data-scroll-source-from", String(match.from));
      match.element.setAttribute("data-scroll-source-to", String(match.to));
    }
    valid = true;
    schedule();
  }
  function toggleSync() {
    enabled = !enabled;
    updateButton();
    try {
      storage?.setItem(storageKey, enabled ? "on" : "off");
    } catch {}
    pending.clear();
    if (enabled) schedule();
  }
  toggle?.addEventListener("click", toggleSync);
  listen(stage, previewScrolled, "addEventListener");
  preview?.addEventListener("load", schedule, true);
  win.addEventListener?.("resize", schedule, { passive: true });
  let observer = null;
  if (win.ResizeObserver && preview && stage) {
    observer = new win.ResizeObserver(schedule);
    for (const element of [stage, preview, preview.parentElement])
      observer.observe(element);
  }
  updateButton();
  return {
    attachEditor,
    detachEditor,
    invalidate,
    refresh,
    get enabled() {
      return enabled;
    },
    destroy() {
      destroyed = true;
      if (frame) cancel?.(frame);
      detachEditor();
      listen(stage, previewScrolled, "removeEventListener");
      toggle?.removeEventListener("click", toggleSync);
      preview?.removeEventListener("load", schedule, true);
      win.removeEventListener?.("resize", schedule);
      observer?.disconnect();
    },
  };
}
