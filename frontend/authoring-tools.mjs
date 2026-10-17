import {
  describeBlocks,
  normalizeBlockOverrides,
  applyBlockOverrides,
} from "./article-blocks.mjs";
import { normalizeTypography } from "./typography.mjs";

const PRESETS = [
  ["tutorial", "原创上手教程"],
  ["benchmark", "性能实测 / 复现报告"],
  ["rocm-repost", "ROCm 博客转载"],
];
const THEMES = new Set([
  "default",
  "grace",
  "simple",
  "technical",
  "journal",
  "minimal",
  "obsidian",
  "deepsea",
  "teal",
]);
const PALETTES = new Set(["warm", "wechat", "blue", "red", "violet", "ink"]);
const preferenceKey = "wechat-authoring-preferences-v1";
const norm = (text) =>
  String(text || "")
    .replace(/\s+/g, "")
    .normalize("NFC");
const sizes = (kind) =>
  kind === "p"
    ? [15, 22]
    : kind === "figcaption" || kind === "table"
      ? [12, 16]
      : [18, 32];

export function authoringToolsMarkup() {
  return `<details class="authoring-tools" data-authoring-tools>
    <summary>写作工具 · 大纲与局部排版</summary>
    <div class="authoring-tools-body">
      <div class="authoring-view-controls">
        <button type="button" data-authoring-action="fold" aria-pressed="false">折叠代码</button>
        <button type="button" data-authoring-action="focus" aria-pressed="false">专注模式</button>
        <label>分栏比例 <input type="range" min="30" max="70" step="1" value="50" data-authoring-columns aria-label="编辑区占双栏比例"><output data-authoring-column-label>编辑区 50%</output></label>
      </div>
      <label class="authoring-search-label">搜索大纲与正文 <input type="search" maxlength="200" data-authoring-search placeholder="输入标题或正文片段"></label>
      <ol class="authoring-outline" data-authoring-outline aria-label="文章大纲与搜索结果"></ol>
      <section class="authoring-selection" data-authoring-selection hidden aria-label="局部排版">
        <strong data-authoring-selected-label></strong>
        <div class="authoring-block-fields">
          <label>字号 <input type="number" data-authoring-field="font_size" step="1" placeholder="模板值"></label>
          <label>段前 <input type="number" data-authoring-field="margin_before" min="0" max="48" step="1" placeholder="模板值"></label>
          <label>段后 <input type="number" data-authoring-field="margin_after" min="0" max="48" step="1" placeholder="模板值"></label>
          <label>行高 <input type="number" data-authoring-field="line_height" min="1.2" max="2.4" step="0.1" placeholder="模板值"></label>
        </div>
        <button type="button" data-authoring-action="reset-block">恢复模板值</button>
      </section>
      <div class="authoring-unmatched" data-authoring-unmatched hidden><span data-authoring-unmatched-label></span><button type="button" data-authoring-action="reset-unmatched">清除未匹配微调</button></div>
      <div class="authoring-presets"><label>个人排版预设 <select data-authoring-preset>${PRESETS.map(([id, label]) => `<option value="${id}">${label}</option>`).join("")}</select></label><button type="button" data-authoring-action="save-preset">保存当前排版</button><button type="button" data-authoring-action="apply-preset">应用预设</button></div>
      <p class="authoring-status" data-authoring-status role="status" aria-live="polite">点击预览中的标题、正文、图注或表格，可微调局部排版。</p>
    </div>
  </details>`;
}

function typographyPreset(value) {
  const input = value && typeof value === "object" ? value : {},
    theme = THEMES.has(input.theme) ? input.theme : "technical";
  return {
    theme,
    palette: PALETTES.has(input.palette) ? input.palette : "warm",
    ...normalizeTypography(input, theme),
  };
}

/** Place markup once outside the preview. Renderer must call
 * applyBlockOverrides(...,{document,lexMarkdown,annotate:true}) for the preview.
 * onChange receives {block_overrides}; read() returns that same metadata slice.
 * selectRange receives (from,to,block). onToggleCodeFold receives a boolean;
 * onApplyPreset receives a validated typography-only object. These callbacks
 * integrate the existing editor without importing a CodeMirror implementation.
 * Focus/columns/presets are local browser preferences, outside article metadata.
 */
export function connectAuthoringTools(
  document,
  {
    getContent = () => "",
    getMetadata = () => ({}),
    getEditor = () => null,
    getPreview = () => null,
    lexMarkdown,
    onChange = () => {},
    selectRange,
    onToggleCodeFold,
    onApplyPreset,
    storage,
  } = {},
) {
  const bar = document.querySelector("[data-authoring-tools]");
  if (!bar) throw new Error("Authoring tools markup is missing");
  const query = (selector) => bar.querySelector(selector),
    status = query("[data-authoring-status]"),
    selection = query("[data-authoring-selection]");
  const outline = query("[data-authoring-outline]"),
    search = query("[data-authoring-search]"),
    presetSelect = query("[data-authoring-preset]");
  let overrides = {},
    blocks = [],
    unmatched = [],
    selectedId = null,
    destroyed = false,
    folded = false,
    columns = 50,
    focus = false,
    presets = {};
  const grid = document.querySelector(".compose-grid"),
    body = document.body;
  const priorFocus = body?.classList.contains("authoring-focus-mode");
  const priorColumns = grid
    ? ["--authoring-source-column", "--authoring-preview-column"].map((name) =>
        grid.style.getPropertyValue(name),
      )
    : [];
  const message = (text) => {
    if (!destroyed && status) status.textContent = text;
  };
  try {
    if (storage === undefined) storage = document.defaultView?.localStorage;
  } catch {
    storage = null;
  }
  try {
    if (storage) {
      const raw = storage.getItem(preferenceKey);
      if (raw && raw.length <= 32768) {
        const settings = JSON.parse(raw);
        if (
          Number.isInteger(settings.columns) &&
          settings.columns >= 30 &&
          settings.columns <= 70
        )
          columns = settings.columns;
        focus = settings.focus === true;
        for (const [id] of PRESETS)
          if (Object.hasOwn(settings.presets || {}, id))
            presets[id] = typographyPreset(settings.presets[id]);
      }
    }
  } catch {
    message("无法读取个人排版存储；本次会话仍可使用写作工具。");
  }
  const savePreferences = () => {
    try {
      if (!storage?.setItem) throw new Error("Unavailable");
      storage.setItem(
        preferenceKey,
        JSON.stringify({ version: 1, columns, focus, presets }),
      );
      return true;
    } catch {
      message("个人预设或视图设置无法保存到浏览器存储；当前会话设置仍有效。");
      return false;
    }
  };
  const viewControls = () => {
    body?.classList.toggle("authoring-focus-mode", focus);
    if (grid) {
      grid.style.setProperty("--authoring-source-column", columns + "fr");
      grid.style.setProperty(
        "--authoring-preview-column",
        100 - columns + "fr",
      );
    }
    query("[data-authoring-columns]").value = String(columns);
    query("[data-authoring-column-label]").textContent = `编辑区 ${columns}%`;
    query('[data-authoring-action="focus"]').setAttribute(
      "aria-pressed",
      String(focus),
    );
    const fold = query('[data-authoring-action="fold"]');
    fold.disabled = typeof onToggleCodeFold !== "function";
    fold.title = fold.disabled ? "当前编辑器未提供代码折叠接口" : "";
    fold.setAttribute("aria-pressed", String(folded));
    fold.textContent = folded ? "展开代码" : "折叠代码";
  };
  const read = () => ({ block_overrides: normalizeBlockOverrides(overrides) });
  const notify = () => onChange(read());
  function updateSelection() {
    const block = blocks.find(
      (item) => item.id === selectedId && !item.ambiguous,
    );
    selection.hidden = !block;
    if (!block) {
      selectedId = null;
      return;
    }
    query("[data-authoring-selected-label]").textContent =
      `${block.kind} · ${block.text.slice(0, 80)}`;
    const [minimum, maximum] = sizes(block.kind),
      font = query('[data-authoring-field="font_size"]');
    font.min = String(minimum);
    font.max = String(maximum);
    for (const input of bar.querySelectorAll("[data-authoring-field]"))
      input.value =
        overrides[selectedId]?.[input.getAttribute("data-authoring-field")] ===
        undefined
          ? ""
          : String(
              overrides[selectedId][input.getAttribute("data-authoring-field")],
            );
  }
  function updateOutline() {
    outline.replaceChildren();
    const term = search.value.trim().toLocaleLowerCase();
    const found = blocks
      .filter((block) =>
        term
          ? block.text.toLocaleLowerCase().includes(term)
          : /^h[1-6]$/.test(block.kind),
      )
      .slice(0, 200);
    for (const block of found) {
      const item = document.createElement("li"),
        button = document.createElement("button");
      button.type = "button";
      button.setAttribute("data-authoring-from", String(block.from));
      button.setAttribute("data-authoring-to", String(block.to));
      button.textContent = `${/^h/.test(block.kind) ? block.kind.toUpperCase() + " · " : ""}${block.text.slice(0, 120)}`;
      item.append(button);
      outline.append(item);
    }
    if (!found.length) {
      const item = document.createElement("li");
      item.textContent = term
        ? "没有匹配内容"
        : "添加 Markdown 标题后可从这里导航";
      outline.append(item);
    }
  }
  function refresh(content = getContent()) {
    if (destroyed) return;
    try {
      blocks = describeBlocks(content, lexMarkdown);
      const preview = getPreview();
      unmatched = preview
        ? applyBlockOverrides(preview.innerHTML, content, overrides, {
            document,
            lexMarkdown,
          }).unmatched
        : Object.keys(overrides).map((id) => ({
            id,
            reason: "render-unmatched",
          }));
      const notice = query("[data-authoring-unmatched]");
      notice.hidden = unmatched.length === 0;
      query("[data-authoring-unmatched-label]").textContent =
        `${unmatched.length} 项局部微调未匹配到唯一原文块，已暂停应用。可检查原文或主动清除。`;
      updateOutline();
      updateSelection();
    } catch (error) {
      blocks = [];
      selectedId = null;
      selection.hidden = true;
      message("无法分析当前文章：" + error.message);
    }
  }
  function load(metadata = {}) {
    if (destroyed) return;
    overrides = normalizeBlockOverrides(metadata.block_overrides);
    selectedId = null;
    selection.hidden = true;
    if (PRESETS.some(([id]) => id === metadata.article_type))
      presetSelect.value = metadata.article_type;
    refresh();
  }
  function fieldChanged(event) {
    const input = event.target.closest?.("[data-authoring-field]");
    if (!input || !bar.contains(input)) return;
    const block = blocks.find(
      (item) => item.id === selectedId && !item.ambiguous,
    );
    if (!block) return;
    const field = input.getAttribute("data-authoring-field"),
      next = { ...(overrides[selectedId] || { kind: block.kind }) };
    if (input.value.trim() === "") delete next[field];
    else {
      const value = Number(input.value),
        trial = normalizeBlockOverrides({
          [selectedId]: { kind: block.kind, [field]: value },
        });
      if (trial[selectedId]?.[field] !== value) {
        message("请输入控件允许范围内的数值；文章尚未修改。");
        updateSelection();
        return;
      }
      next[field] = value;
    }
    const proposed = { ...overrides, [selectedId]: next },
      normalized = normalizeBlockOverrides(proposed);
    if (
      Object.keys(proposed).length > 200 &&
      !Object.hasOwn(overrides, selectedId)
    ) {
      message("局部微调已达到 200 项上限，请先清除不再需要的微调。");
      updateSelection();
      return;
    }
    overrides = normalized;
    notify();
    message("局部排版已更新；保存稿件可保留这些微调。");
  }
  function inputChanged(event) {
    if (event.target === search) updateOutline();
    if (event.target === query("[data-authoring-columns]")) {
      const value = Number(event.target.value);
      if (Number.isFinite(value))
        columns = Math.round(Math.max(30, Math.min(70, value)));
      viewControls();
      savePreferences();
    }
  }
  function click(event) {
    if (destroyed) return;
    const preview = getPreview(),
      target = event.target;
    const candidate = target.closest?.("[data-article-block]");
    if (
      candidate &&
      preview?.contains(candidate) &&
      !candidate.closest("pre,code,script,style,svg,math")
    ) {
      const id = candidate.getAttribute("data-article-block"),
        block = blocks.find((item) => item.id === id && !item.ambiguous);
      const kind = candidate.matches("figcaption,.md-figcaption")
        ? "figcaption"
        : candidate.tagName.toLowerCase();
      if (
        block &&
        block.kind === kind &&
        /^(?:h[1-6]|p|figcaption|table)$/.test(kind) &&
        norm(candidate.textContent) === norm(block.text)
      ) {
        selectedId = id;
        bar.open = true;
        bar.setAttribute("open", "");
        updateSelection();
        message("局部微调只作用于当前选中的唯一原文块。");
      }
      return;
    }
    const button = target.closest?.("button");
    if (!button || !bar.contains(button)) return;
    if (button.hasAttribute("data-authoring-from")) {
      const from = Number(button.getAttribute("data-authoring-from")),
        to = Number(button.getAttribute("data-authoring-to")),
        block = blocks.find((item) => item.from === from && item.to === to);
      if (selectRange) selectRange(from, to, block);
      else {
        const editor = getEditor();
        editor?.dispatch({
          selection: { anchor: from, head: to },
          scrollIntoView: true,
        });
        editor?.focus?.();
      }
      return;
    }
    const action = button.getAttribute("data-authoring-action");
    if (action === "focus") {
      focus = !focus;
      viewControls();
      savePreferences();
    }
    if (action === "fold" && typeof onToggleCodeFold === "function") {
      try {
        folded = !folded;
        onToggleCodeFold(folded);
        viewControls();
      } catch (error) {
        folded = !folded;
        message("无法切换代码折叠：" + error.message);
      }
    }
    if (action === "reset-block" && selectedId) {
      delete overrides[selectedId];
      updateSelection();
      notify();
      message("已恢复模板默认排版。");
    }
    if (action === "reset-unmatched") {
      for (const { id } of unmatched) delete overrides[id];
      refresh();
      notify();
      message("已清除未匹配微调，其他局部排版保留。");
    }
    if (action === "save-preset") {
      presets[presetSelect.value] = typographyPreset(getMetadata());
      if (savePreferences()) message("当前排版已保存为所选类型的个人预设。");
    }
    if (action === "apply-preset") {
      const preset = presets[presetSelect.value];
      if (!preset) {
        message("此类型尚无个人预设，请先保存当前排版。");
        return;
      }
      if (typeof onApplyPreset !== "function") {
        message("当前编辑器未提供应用个人预设的接口。");
        return;
      }
      onApplyPreset(typographyPreset(preset));
      notify();
      message("已应用个人排版预设；正文和局部微调均保留。");
    }
  }
  bar.addEventListener("change", fieldChanged);
  bar.addEventListener("input", inputChanged);
  document.addEventListener("click", click);
  viewControls();
  return {
    load,
    read,
    refresh,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      bar.removeEventListener("change", fieldChanged);
      bar.removeEventListener("input", inputChanged);
      document.removeEventListener("click", click);
      body?.classList.toggle("authoring-focus-mode", Boolean(priorFocus));
      if (grid)
        ["--authoring-source-column", "--authoring-preview-column"].forEach(
          (name, index) => {
            if (priorColumns[index])
              grid.style.setProperty(name, priorColumns[index]);
            else grid.style.removeProperty(name);
          },
        );
    },
  };
}
