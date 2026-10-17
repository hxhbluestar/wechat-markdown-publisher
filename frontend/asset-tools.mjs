import { scanCodeRegions } from "./technical-writing.mjs";
import { canonicalAssetPath } from "./asset-paths.mjs";

function sourceText(content) {
  if (typeof content !== "string" || content.length > 200000)
    throw new TypeError("Invalid asset content");
  return content;
}
function isEscaped(text, from) {
  let count = 0;
  while (from > 0 && text[--from] === "\\") count++;
  return count % 2 === 1;
}
function bracketEnd(text, start) {
  let depth = 1;
  for (let at = start + 1; at < text.length && text[at] !== "\n"; at++) {
    if (isEscaped(text, at)) continue;
    if (text[at] === "[") depth++;
    if (text[at] === "]" && --depth === 0) return at;
  }
  return -1;
}
function targetAt(text, at) {
  while (at < text.length && /[ \t]/.test(text[at])) at++;
  if (text[at] === "<") {
    const end = text.indexOf(">", at + 1);
    if (end === -1 || text.slice(at, end).includes("\n")) return null;
    return {
      source: text.slice(at + 1, end),
      sourceFrom: at + 1,
      sourceTo: end,
      end: end + 1,
    };
  }
  const from = at;
  let depth = 0;
  for (; at < text.length; at++) {
    if (text[at] === "\\") {
      at++;
      continue;
    }
    if (/\s/.test(text[at])) break;
    if (text[at] === "(") depth++;
    if (text[at] === ")") {
      if (!depth) break;
      depth--;
    }
  }
  return {
    source: text.slice(from, at).replace(/\\([() ])/g, "$1"),
    sourceFrom: from,
    sourceTo: at,
    end: at,
  };
}
function decodeEntities(text) {
  return text.replace(
    /&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi,
    (entity) => {
      const value = entity.slice(1, -1).toLowerCase();
      const named = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
      if (Object.hasOwn(named, value)) return named[value];
      const point = value.startsWith("#x")
        ? Number.parseInt(value.slice(2), 16)
        : Number(value.slice(1));
      return Number.isInteger(point) && point > 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : entity;
    },
  );
}
function attributes(tag, tagFrom) {
  const start = /^<img\b/i.exec(tag)[0].length;
  const found = new Map();
  for (const match of tag
    .slice(start)
    .matchAll(
      /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g,
    )) {
    const name = match[1].toLowerCase();
    if (found.has(name)) continue;
    const raw = match[2] ?? match[3] ?? match[4];
    if (raw === undefined) continue;
    const equals = match[0].indexOf("=") + 1;
    const suffix = match[0].slice(equals);
    const offset = suffix.search(/\S/);
    const quote = /^["']/.test(suffix.slice(offset)) ? suffix[offset] : "";
    const from =
      tagFrom + start + match.index + equals + offset + (quote ? 1 : 0);
    found.set(name, {
      from,
      to: from + raw.length,
      raw,
      value: decodeEntities(raw),
      quote,
    });
  }
  return found;
}

function imageSpans(content) {
  sourceText(content);
  const { mask } = scanCodeRegions(content);
  const markdownMask = mask.slice();
  const tags = [
    ...content.matchAll(/<[A-Za-z][\w:-]*\b(?:[^>"']|"[^"]*"|'[^']*')*>/g),
  ];
  for (const tag of tags)
    markdownMask.fill(1, tag.index, tag.index + tag[0].length);
  const definitions = new Map();
  const keyOf = (label) => label.trim().replace(/\s+/g, " ").toLowerCase();
  for (const match of content.matchAll(/^ {0,3}\[([^\]\r\n]+)\]:[ \t]*/gm)) {
    if (mask[match.index]) continue;
    const target = targetAt(content, match.index + match[0].length);
    if (target && !definitions.has(keyOf(match[1]))) {
      const newline = content.indexOf("\n", target.end);
      const suffix = content
        .slice(target.end, newline === -1 ? content.length : newline)
        .trim();
      definitions.set(keyOf(match[1]), {
        ...target,
        title: /^(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^\r\n]*\))$/.test(suffix)
          ? suffix
          : "",
      });
    }
  }
  const images = [];
  for (let at = 0; at < content.length - 1; at++) {
    if (
      markdownMask[at] ||
      isEscaped(content, at) ||
      !content.startsWith("![", at)
    )
      continue;
    const close = bracketEnd(content, at + 1);
    if (close < 0) continue;
    const common = {
      kind: "markdown",
      from: at,
      captionFrom: at + 2,
      captionTo: close,
      caption: content.slice(at + 2, close).replace(/\\([\\\[\]`*_<>])/g, "$1"),
      prefix: content.slice(at, close + 1),
    };
    if (content[close + 1] === "(") {
      const target = targetAt(content, close + 2);
      if (target)
        images.push({ ...common, ...target, to: target.end, reference: false });
      at = target?.end ?? close;
    } else {
      const labelEnd =
        content[close + 1] === "[" ? bracketEnd(content, close + 1) : -1;
      const label = labelEnd < 0 ? "" : content.slice(close + 2, labelEnd);
      const target = definitions.get(
        keyOf(label || content.slice(at + 2, close)),
      );
      images.push({
        ...common,
        source: target?.source || "",
        title: target?.title || "",
        to: labelEnd < 0 ? close + 1 : labelEnd + 1,
        reference: true,
      });
      at = labelEnd < 0 ? close : labelEnd;
    }
  }
  for (const match of tags) {
    if (mask[match.index] || !/^<img\b/i.test(match[0])) continue;
    const values = attributes(match[0], match.index);
    const src = values.get("src"),
      alt = values.get("alt");
    const insertion =
      match.index + match[0].length - (match[0].endsWith("/>") ? 2 : 1);
    images.push({
      kind: "html",
      from: match.index,
      to: match.index + match[0].length,
      source: src?.value || "",
      sourceFrom: src?.from,
      sourceTo: src?.to,
      sourceQuote: src?.quote,
      caption: alt?.value || "",
      captionFrom: alt?.from,
      captionTo: alt?.to,
      captionQuote: alt?.quote,
      insertion,
    });
  }
  return images.sort((a, b) => a.from - b.from);
}

function localPath(value) {
  if (typeof value !== "string")
    throw new TypeError("Invalid local asset path");
  const path = canonicalAssetPath(value);
  if (
    !/^(?:images\/|cover\.)/.test(path) ||
    !/\.(?:png|jpe?g|gif|webp)$/i.test(path) ||
    /[:<>"|?*\0\r\n\\]/.test(path) ||
    path
      .split("/")
      .some(
        (part) =>
          !part || part === ".." || part.endsWith(" ") || part.endsWith("."),
      )
  )
    throw new TypeError("Invalid local asset path");
  return path;
}
const htmlEscape = (text) =>
  text.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
const pathURL = (path) =>
  path.replace(/[\s<>"'()\\]/g, (character) => encodeURIComponent(character));
function applySpans(content, changes) {
  changes.sort((a, b) => b.from - a.from);
  let previous = content.length + 1;
  for (const change of changes) {
    if (change.to > previous || change.from < 0 || change.to < change.from)
      throw new Error("Overlapping image edits");
    content =
      content.slice(0, change.from) + change.insert + content.slice(change.to);
    previous = change.from;
  }
  return content;
}

/** Pure image-only rewrite; normal links sharing a definition remain untouched. */
export function rewriteImageSources(
  content,
  oldUrl,
  newPath,
  { draftId = "" } = {},
) {
  sourceText(content);
  if (typeof oldUrl !== "string" || !oldUrl)
    throw new TypeError("Invalid old image source");
  const path = pathURL(localPath(newPath));
  const remote = /^(?:https?:|data:|blob:|\/\/)/i.test(oldUrl);
  const wanted = remote ? oldUrl : canonicalAssetPath(oldUrl, draftId);
  const changes = [];
  for (const image of imageSpans(content)) {
    const source = remote
      ? image.source
      : canonicalAssetPath(image.source, draftId);
    if (source !== wanted) continue;
    if (image.reference)
      changes.push({
        from: image.from,
        to: image.to,
        insert: `${image.prefix}(${path}${image.title ? " " + image.title : ""})`,
      });
    else if (image.sourceFrom !== undefined)
      changes.push({
        from: image.sourceFrom,
        to: image.sourceTo,
        insert: image.kind === "html" ? htmlEscape(path) : path,
      });
  }
  return applySpans(content, changes);
}

export function listImageCaptions(content) {
  return imageSpans(content).map((image, index) => ({
    index,
    source: image.source,
    caption: image.caption,
    from: image.from,
    to: image.to,
  }));
}

/** Captions are text, never newly interpreted Markdown or injected HTML. */
export function applyCaptionEdits(content, captions) {
  const images = imageSpans(content);
  if (
    !Array.isArray(captions) ||
    captions.length !== images.length ||
    captions.some(
      (caption) =>
        typeof caption !== "string" ||
        /[\r\n]/.test(caption) ||
        caption.length > 1000,
    )
  )
    throw new TypeError("Invalid caption count or text");
  const changes = [];
  for (const [index, image] of images.entries()) {
    if (captions[index] === image.caption) continue;
    const insert =
      image.kind === "html"
        ? htmlEscape(captions[index])
        : captions[index].replace(/[\\\[\]`*_<>]/g, "\\$&");
    if (image.captionFrom !== undefined) {
      // Unquoted HTML attributes must become quoted when edited.
      const quoted =
        image.kind === "html" && !image.captionQuote ? `"${insert}"` : insert;
      changes.push({
        from: image.captionFrom,
        to: image.captionTo,
        insert: quoted,
      });
    } else
      changes.push({
        from: image.insertion,
        to: image.insertion,
        insert: ` alt="${insert}"`,
      });
  }
  return applySpans(content, changes);
}

export function assetToolsMarkup() {
  return `<button type="button" class="toolbar-button" id="openAssetTools">素材工具</button>
<dialog id="assetToolsDialog" class="asset-tools-dialog" aria-labelledby="assetToolsTitle"><header><div><small>本机素材工作台</small><h2 id="assetToolsTitle">素材、图注与封面</h2></div><button type="button" id="closeAssetTools" aria-label="关闭素材工具">×</button></header>
<div class="asset-tools-content"><section><div class="asset-tools-heading"><h3>素材清单</h3><button type="button" id="refreshAssetTools">刷新</button></div><p>原图与派生图分别保留；未引用与重复素材仅提示，不自动删除。</p><div id="assetToolsList"></div></section>
<section class="asset-tools-actions"><h3>生成派生素材</h3><p id="assetToolsSelection">先从左侧选择原图。</p><div class="asset-tools-fields"><label>处理方式<select id="assetDeriveMode"><option value="diagram" selected>截图 / 流程图（无损 PNG）</option><option value="photo">照片压缩</option><option value="gif">GIF 兼容预设</option><option value="cover">封面裁切</option></select></label><label>照片质量<input id="assetPhotoQuality" type="range" min="40" max="95" value="85"><output id="assetPhotoQualityValue">85</output></label><label>最大宽度（选填）<input id="assetMaxWidth" type="number" min="1" max="16000" placeholder="保留原宽"></label><label>最大高度（选填）<input id="assetMaxHeight" type="number" min="1" max="16000" placeholder="保留原高"></label><label>GIF 帧数预设<input id="assetGifFrames" type="number" min="1" max="300" value="300"></label><label>封面宽高比<select id="assetCoverRatio"><option value="2.35" selected>2.35 : 1</option><option value="1">1 : 1</option><option value="0.75">3 : 4</option></select></label><label>焦点 X<input id="assetFocalX" type="range" min="0" max="1" step="0.01" value="0.5"></label><label>焦点 Y<input id="assetFocalY" type="range" min="0" max="1" step="0.01" value="0.5"></label></div><p class="asset-tools-note">GIF 不超过 300 帧是本地兼容预设，并非本轮核实的统一平台上限。封面安全区是构图参考，需在微信预览中核对。</p><button type="button" id="assetDerive" disabled>生成并预览派生图</button>
<h3>下载网络配图</h3><label>正文中的完整图片 URL<input id="assetRemoteUrl" type="url" placeholder="https://example.org/image.png"></label><button type="button" id="assetDownloadRemote">下载为本地素材并预览</button><p class="asset-tools-note">只有后端受保护的下载接口会访问图片来源；导入完成后再明确替换正文引用。</p>
<div id="assetToolsPreview" class="asset-tools-preview" aria-live="polite"></div><div class="asset-tools-apply"><button type="button" id="assetApplyReferences" disabled>使用此图替换正文引用</button><button type="button" id="assetUseCover" disabled>将此图设为封面</button></div></section></div>
<section class="asset-caption-tools"><h3>批量图注（图片替代文字）</h3><p>每个图片引用占一行；代码示例与普通链接不会修改。先预览，再应用到当前稿件。</p><ol id="assetCaptionSources"></ol><label>逐行编辑图注<textarea id="assetCaptionList" rows="6"></textarea></label><button type="button" id="assetPreviewCaptions">预览图注更改</button><pre id="assetCaptionPreview"></pre><button type="button" id="assetApplyCaptions" disabled>应用已预览的图注</button></section><footer id="assetToolsStatus" role="status" aria-live="polite"></footer></dialog>`;
}

/** All requests are same-origin editor API calls; previews never fetch source URLs. */
export function connectAssetTools(document, adapter) {
  const a = adapter,
    $ = (selector) => document.querySelector(selector),
    dialog = $("#assetToolsDialog");
  if (!dialog || typeof a?.request !== "function")
    throw new TypeError("Asset tools markup and adapter are required");
  const list = $("#assetToolsList"),
    preview = $("#assetToolsPreview"),
    status = $("#assetToolsStatus");
  const listeners = [];
  let destroyed = false,
    epoch = 0,
    inventory = [],
    selected = null,
    staged = null,
    captionStage = null,
    working = false,
    viewDraftId = "";
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  };
  const note = (text) => {
    if (!destroyed) {
      status.textContent = text;
      a.toast?.(text);
    }
  };
  const current = () => {
    const draft = a.getDraft?.();
    if (!draft?.id) throw new Error("no-draft");
    return draft;
  };
  const currentView = () => {
    const draft = current();
    if (draft.id !== viewDraftId) throw new Error("stale-asset-view");
    return draft;
  };
  const sameDraft = (id) => !destroyed && a.getDraft?.()?.id === id;
  const stale = () =>
    note("稿件或输入已变化，当前内容已保留；请刷新并重新预览后应用。");
  const buttons = () => {
    $("#assetDerive").disabled = working || !selected;
    $("#assetDownloadRemote").disabled = working;
    $("#assetApplyReferences").disabled = working || !staged;
    $("#assetUseCover").disabled = working || !staged;
    $("#assetApplyCaptions").disabled = working || !captionStage;
  };
  const on = (node, type, handler) => {
    node.addEventListener(type, handler);
    listeners.push(() => node.removeEventListener(type, handler));
  };
  const action = (handler) => async (event) => {
    if (destroyed || working) return;
    try {
      await handler(event);
    } catch {
      note("素材操作未完成，原图与当前输入已保留；请核对后重试。");
    } finally {
      if (!destroyed) buttons();
    }
  };
  const api = (id) => `/api/editor/drafts/${encodeURIComponent(id)}/assets`;
  function imagePreview(path, id, target, guide = false) {
    try {
      path = localPath(path);
      const url = a.assetUrl?.(path, id);
      const expected = `/api/editor/drafts/${encodeURIComponent(id)}/assets/`;
      if (typeof url !== "string" || !url.startsWith(expected)) return;
      const frame = el("div", undefined, "asset-tools-image-frame");
      const image = el("img");
      image.setAttribute("src", url);
      image.alt = "本地素材预览";
      frame.append(image);
      if (guide) {
        frame.classList.add("has-safe-area");
        const outline = el("span", "安全区参考", "asset-tools-safe-area");
        outline.setAttribute("aria-hidden", "true");
        frame.append(outline);
      }
      target.append(frame);
    } catch {
      /* An unsafe path is still shown as text; it is never an image URL. */
    }
  }
  function captions() {
    const items = listImageCaptions(sourceText(a.getContent?.() || ""));
    $("#assetCaptionSources").replaceChildren(
      ...items.map((item) =>
        el("li", `${item.index + 1}. ${item.source || "未解析的图片引用"}`),
      ),
    );
    $("#assetCaptionList").value = items
      .map((item) => item.caption.replace(/[\r\n]+/g, " "))
      .join("\n");
    $("#assetCaptionPreview").textContent = "";
    captionStage = null;
  }
  function renderInventory(id) {
    list.replaceChildren();
    if (!inventory.length) list.append(el("p", "当前稿件没有本地素材。"));
    for (const asset of inventory) {
      const card = el("article", undefined, "asset-tools-card");
      card.append(
        el("h4", asset.path),
        el(
          "p",
          `${asset.width ?? "—"} × ${asset.height ?? "—"} px · ${asset.size ?? "—"} bytes · ${asset.format || "未知格式"} · ${asset.frames ?? "—"} 帧 · 正文引用 ${asset.reference_count ?? "—"} 次`,
        ),
      );
      if (Array.isArray(asset.captions) && asset.captions.length)
        card.append(el("p", `图注：${asset.captions.join("；")}`));
      if (asset.duplicate_of)
        card.append(el("p", `重复素材：${asset.duplicate_of}（原件仍保留）`));
      if (asset.derivation)
        card.append(
          el(
            "p",
            `派生来源：${asset.derivation.source_path || asset.derivation.source || "已记录"} · 原图哈希 ${asset.derivation.source_hash || "未提供"}`,
          ),
        );
      const select = el("button", "选择此原图");
      select.type = "button";
      select.dataset.assetSelect = asset.path;
      card.append(select);
      list.append(card);
    }
  }
  async function refresh() {
    if (destroyed) return;
    const ticket = ++epoch;
    let id;
    try {
      id = current().id;
    } catch {
      viewDraftId = "";
      staged = captionStage = selected = null;
      preview.replaceChildren();
      list.replaceChildren(el("p", "请先选择一篇稿件。"));
      buttons();
      return;
    }
    viewDraftId = "";
    staged = captionStage = selected = null;
    preview.replaceChildren();
    $("#assetToolsSelection").textContent = "先从左侧选择原图。";
    buttons();
    const result = await a.request(api(id));
    if (ticket !== epoch || !sameDraft(id)) return;
    viewDraftId = id;
    inventory = Array.isArray(result?.items)
      ? result.items.filter((item) => item && typeof item.path === "string")
      : [];
    renderInventory(id);
    captions();
    buttons();
  }
  async function open() {
    if (destroyed) return;
    status.textContent = "";
    if (!dialog.hasAttribute("open")) dialog.showModal();
    try {
      await refresh();
    } catch {
      note("素材清单暂时无法读取，稿件内容已保留。");
    }
  }
  function showStage(asset, derivation, id, oldUrl, expected) {
    localPath(asset?.path);
    staged = {
      asset,
      derivation: derivation || {},
      id,
      oldUrl,
      expected,
      expectedCover: a.getMetadata?.()?.cover || "",
    };
    preview.replaceChildren(
      el("h3", "派生素材预览 · 尚未替换正文或封面"),
      el("p", asset.path),
      el(
        "p",
        `${asset.width ?? "—"} × ${asset.height ?? "—"} px · ${asset.size ?? "—"} bytes · ${asset.frames ?? "—"} 帧`,
      ),
    );
    imagePreview(asset.path, id, preview, !!derivation?.safe_area);
    preview.append(
      el(
        "p",
        `原图：${derivation?.source_path || oldUrl || "已保留"} · 哈希 ${derivation?.source_hash || "未提供"}`,
      ),
    );
    if (derivation?.crop_box)
      preview.append(
        el("p", `裁切范围：${JSON.stringify(derivation.crop_box)}`),
      );
    if (derivation?.safe_area)
      preview.append(
        el(
          "p",
          "安全区 / 构图参考：中心约 80%，不是平台裁切保证；请在微信预览中核对。",
        ),
      );
    note("预览已生成。请核对尺寸和裁切，再明确选择替换引用或设为封面。");
    buttons();
  }
  function deriveOptions(mode) {
    const options = {};
    for (const [selector, key] of [
      ["#assetMaxWidth", "max_width"],
      ["#assetMaxHeight", "max_height"],
    ]) {
      const raw = $(selector).value.trim();
      if (raw) {
        const number = Number(raw);
        if (!Number.isInteger(number) || number < 1 || number > 16000)
          throw new Error("invalid-size");
        options[key] = number;
      }
    }
    if (mode === "photo")
      options.quality = Number($("#assetPhotoQuality").value);
    if (mode === "gif") {
      const frames = Number($("#assetGifFrames").value);
      if (!Number.isInteger(frames) || frames < 1 || frames > 300)
        throw new Error("invalid-frames");
      options.max_frames = frames;
    }
    if (mode === "cover") {
      options.ratio = Number($("#assetCoverRatio").value);
      options.focal_point = [
        Number($("#assetFocalX").value),
        Number($("#assetFocalY").value),
      ];
      if (
        !options.focal_point.every(
          (number) => Number.isFinite(number) && number >= 0 && number <= 1,
        )
      )
        throw new Error("invalid-focal-point");
    }
    return options;
  }
  async function derive() {
    const draft = currentView(),
      asset = selected;
    if (!asset) return;
    localPath(asset.path);
    const mode = $("#assetDeriveMode").value;
    if (!["photo", "diagram", "gif", "cover"].includes(mode))
      throw new Error("invalid-mode");
    const expected = sourceText(a.getContent()),
      ticket = epoch;
    working = true;
    staged = null;
    buttons();
    try {
      const result = await a.request(api(draft.id) + "/derive", {
        method: "POST",
        body: JSON.stringify({
          path: asset.path,
          mode,
          options: deriveOptions(mode),
        }),
      });
      if (ticket !== epoch || !sameDraft(draft.id)) return;
      showStage(
        result.asset,
        result.derivation,
        draft.id,
        asset.path,
        expected,
      );
    } finally {
      working = false;
    }
  }
  async function downloadRemote() {
    const draft = currentView(),
      url = $("#assetRemoteUrl").value.trim(),
      expected = sourceText(a.getContent()),
      ticket = epoch;
    if (!/^https?:\/\/[^\s]+$/i.test(url)) {
      note("请填写完整的 HTTP / HTTPS 图片 URL，由后端核对可访问性。");
      return;
    }
    working = true;
    staged = null;
    buttons();
    try {
      const result = await a.request(api(draft.id) + "/download-remote", {
        method: "POST",
        body: JSON.stringify({ url }),
      });
      if (ticket !== epoch || !sameDraft(draft.id)) return;
      showStage(result.asset, result.derivation || {}, draft.id, url, expected);
    } finally {
      working = false;
    }
  }
  async function applyBody(stage = staged) {
    if (!stage || !sameDraft(stage.id) || a.getContent() !== stage.expected) {
      stale();
      return;
    }
    const next =
      stage.next ??
      rewriteImageSources(stage.expected, stage.oldUrl, stage.asset.path, {
        draftId: stage.id,
      });
    if (next === stage.expected) {
      note("正文中没有需要替换的匹配图片引用，原文已保留。");
      return;
    }
    working = true;
    buttons();
    try {
      if (
        (await a.beforeChange?.(
          stage.next === undefined
            ? "asset-reference-replace"
            : "asset-caption-batch",
        )) === false
      ) {
        note("版本快照未确认完成，更改尚未应用。");
        return;
      }
      if (!sameDraft(stage.id) || a.getContent() !== stage.expected) {
        stale();
        return;
      }
      const accepted = await a.replaceContent(next, stage.expected, stage.id);
      if (accepted === false) {
        stale();
        return;
      }
      if (!sameDraft(stage.id)) return;
      captionStage = null;
      if (stage.next === undefined) stage.expected = next;
      await a.onChanged?.();
      captions();
      note("更改已应用到当前编辑区；原图与代码原文仍保留，请核对并保存。");
    } finally {
      working = false;
    }
  }
  async function useCover() {
    const stage = staged;
    if (
      !stage ||
      !sameDraft(stage.id) ||
      (a.getMetadata?.()?.cover || "") !== stage.expectedCover
    ) {
      stale();
      return;
    }
    working = true;
    buttons();
    try {
      if ((await a.beforeChange?.("asset-cover-select")) === false) {
        note("版本快照未确认完成，封面尚未更改。");
        return;
      }
      if (
        !sameDraft(stage.id) ||
        (a.getMetadata?.()?.cover || "") !== stage.expectedCover
      ) {
        stale();
        return;
      }
      const accepted = await a.applyMetadata?.(
        { cover: stage.asset.path },
        stage.id,
      );
      if (accepted === false) {
        stale();
        return;
      }
      if (!sameDraft(stage.id)) return;
      stage.expectedCover = stage.asset.path;
      await a.onChanged?.();
      note("封面已选择为派生素材；原封面文件仍保留，请核对并保存。");
    } finally {
      working = false;
    }
  }
  function previewCaptions() {
    const id = currentView().id,
      expected = sourceText(a.getContent());
    const before = listImageCaptions(expected),
      raw = $("#assetCaptionList").value.replace(/\r\n/g, "\n");
    const values = before.length || raw ? raw.split("\n") : [];
    const next = applyCaptionEdits(expected, values);
    $("#assetCaptionPreview").textContent = before
      .map(
        (item, index) => `${index + 1}. ${item.caption}\n   → ${values[index]}`,
      )
      .join("\n");
    captionStage = { id, expected, next };
    buttons();
    note("图注更改已预览，尚未应用。");
  }
  on($("#openAssetTools"), "click", action(open));
  on($("#closeAssetTools"), "click", () => {
    if (!destroyed) dialog.close();
  });
  on($("#refreshAssetTools"), "click", action(refresh));
  on(
    list,
    "click",
    action((event) => {
      const trigger = event.target.closest("[data-asset-select]");
      if (!trigger) return;
      currentView();
      const asset = inventory.find(
        (item) => item.path === trigger.dataset.assetSelect,
      );
      if (!asset) return;
      localPath(asset.path);
      selected = asset;
      staged = null;
      preview.replaceChildren();
      $("#assetToolsSelection").textContent = `已选择：${asset.path}`;
      imagePreview(asset.path, current().id, preview);
      buttons();
    }),
  );
  on($("#assetPhotoQuality"), "input", () => {
    $("#assetPhotoQualityValue").textContent = $("#assetPhotoQuality").value;
  });
  on($("#assetDerive"), "click", action(derive));
  on($("#assetDownloadRemote"), "click", action(downloadRemote));
  on(
    $("#assetApplyReferences"),
    "click",
    action(() => applyBody()),
  );
  on($("#assetUseCover"), "click", action(useCover));
  on($("#assetCaptionList"), "input", () => {
    captionStage = null;
    $("#assetCaptionPreview").textContent = "";
    buttons();
  });
  on($("#assetPreviewCaptions"), "click", action(previewCaptions));
  on(
    $("#assetApplyCaptions"),
    "click",
    action(() => applyBody(captionStage)),
  );
  return {
    open,
    refresh,
    destroy() {
      destroyed = true;
      epoch++;
      staged = captionStage = selected = null;
      for (const remove of listeners) remove();
      if (dialog.hasAttribute("open")) dialog.close();
    },
  };
}
