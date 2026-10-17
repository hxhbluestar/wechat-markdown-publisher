import { scanCodeRegions } from "./technical-writing.mjs";

/** Render only diagram/formula nodes. Original Markdown and ordinary code stay intact. */
const SELECTOR =
  ".mermaid-diagram,.mermaid,[data-mermaid-source],code.language-mermaid,[data-math-raw],.math,.katex-pending";
const SVG_TAGS = new Set(
  "svg g defs marker path rect circle ellipse line polyline polygon text tspan textpath clippath mask lineargradient radialgradient stop style title desc use pattern filter fegaussianblur feoffset feblend fecolormatrix fecomponenttransfer fefunca fefuncr fefuncg fefuncb femerge femergenode fedropshadow".split(
    " ",
  ),
);
const DEFAULTS = {
  mode: "png",
  scale: 2,
  timeoutMs: 10000,
  maxCount: 100,
  maxSourceLength: 20000,
  maxHtmlLength: 5 * 1024 * 1024,
  maxPixels: 16000000,
  maxTotalPixels: 64000000,
  maxAssetBytes: 8 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  background: "#ffffff",
};

function normalizedFence(markdown, fence) {
  const raw = markdown.slice(fence.bodyFrom, fence.bodyTo);
  return /^(?: {0,3}>[ \t]?)+/.test(markdown.slice(fence.from, fence.bodyFrom))
    ? raw.replace(/^(?: {0,3}>[ \t]?)+/gm, "")
    : raw;
}

/** Native Markdown must not start its asynchronous Mermaid plugin first. */
export function prepareRichMarkdown(markdown) {
  if (typeof markdown !== "string" || markdown.length > 200000)
    throw new TypeError("Invalid rich Markdown source");
  const { fences } = scanCodeRegions(markdown);
  const escapeAttribute = (text) =>
    text.replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char],
    );
  let cursor = 0;
  const pieces = [];
  for (const fence of fences.filter(
    (item) => item.language.toLowerCase() === "mermaid",
  )) {
    pieces.push(markdown.slice(cursor, fence.from));
    const quote =
      /^(?: {0,3}>[ \t]?)+/.exec(
        markdown.slice(fence.from, fence.bodyFrom),
      )?.[0] || "";
    // DOMPurify's safe XML attribute policy removes values containing '-->'.
    // Encode the inert source until after native HTML sanitization.
    pieces.push(
      `${quote}<div data-mermaid-source="${escapeAttribute(encodeURIComponent(normalizedFence(markdown, fence)))}" data-rich-source-encoding="uri" data-rich-source-from="${fence.bodyFrom}" data-rich-source-to="${fence.bodyTo}"></div>\n\n`,
    );
    cursor = fence.to;
  }
  pieces.push(markdown.slice(cursor));
  return pieces.join("");
}

class RichError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function within(promise, remaining) {
  if (remaining <= 0) return Promise.reject(new RichError("rich-timeout"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new RichError("rich-timeout")),
      remaining,
    );
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function fragment(document, html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content;
}

function escapeText(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function serialize(root) {
  return [...root.childNodes]
    .map((node) =>
      node.nodeType === 1
        ? node.outerHTML
        : node.nodeType === 3
          ? escapeText(node.nodeValue || "")
          : node.nodeType === 8
            ? `<!--${node.nodeValue || ""}-->`
            : "",
    )
    .join("");
}

async function sha256(bytes) {
  if (!globalThis.crypto?.subtle)
    throw new RichError("rich-capability-missing");
  return [
    ...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)),
  ]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function localCSS(value) {
  if (/@import|@font-face|expression\s*\(|javascript:|\\|\/\*/i.test(value))
    return false;
  let rest = value.replace(/url\(\s*['"]?#[\w:.-]+['"]?\s*\)/gi, "");
  return !/url\s*\(/i.test(rest);
}

function safeSVG(document, svg) {
  if (
    typeof svg !== "string" ||
    svg.length > 2 * 1024 * 1024 ||
    /<!DOCTYPE|<!ENTITY|<\?|<\s*(?:script|foreignObject|image|iframe|object|embed|animate|set)\b|\son[a-z]+\s*=/i.test(
      svg,
    )
  )
    throw new RichError("rich-svg-unsafe");
  const parsed = fragment(document, svg.trim());
  const elements = [...parsed.childNodes].filter((node) => node.nodeType === 1);
  if (
    elements.length !== 1 ||
    elements[0].tagName.toLowerCase() !== "svg" ||
    [...parsed.childNodes].some(
      (node) => node.nodeType === 3 && node.textContent.trim(),
    )
  )
    throw new RichError("rich-svg-unsafe");
  const root = elements[0];
  for (const element of [root, ...root.querySelectorAll("*")]) {
    const tag = element.tagName.toLowerCase();
    if (!SVG_TAGS.has(tag)) throw new RichError("rich-svg-unsafe");
    if (tag === "style" && !localCSS(element.textContent))
      throw new RichError("rich-svg-unsafe");
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (
        /^on/.test(name) ||
        name === "src" ||
        name === "srcset" ||
        name === "xml:base"
      )
        throw new RichError("rich-svg-unsafe");
      if (
        (name === "href" || name === "xlink:href") &&
        !/^#[\w:.-]+$/.test(value)
      )
        throw new RichError("rich-svg-unsafe");
      if (name === "style" && !localCSS(value))
        throw new RichError("rich-svg-unsafe");
      if (
        !name.startsWith("xmlns") &&
        /url\s*\(/i.test(value) &&
        !localCSS(value)
      )
        throw new RichError("rich-svg-unsafe");
      if (
        !name.startsWith("xmlns") &&
        /(?:https?:|data:|javascript:|file:|ftp:)/i.test(value)
      )
        throw new RichError("rich-svg-unsafe");
    }
  }
  if (root.querySelector('[data-mml-node="merror"],.mjx-merror'))
    throw new RichError("rich-render-failed");
  root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return root;
}

function dimensions(svg) {
  const viewBox = (
    svg.getAttribute("viewBox") ||
    svg.getAttribute("viewbox") ||
    ""
  )
    .trim()
    .split(/[ ,]+/)
    .map(Number);
  const validViewBox =
    viewBox.length === 4 &&
    viewBox.every(Number.isFinite) &&
    viewBox[2] > 0 &&
    viewBox[3] > 0;
  const absolute = (value) => {
    const match = /^(\d+(?:\.\d+)?)(px|em|ex)?$/.exec(value || "");
    return match ? Number(match[1]) * ({ em: 16, ex: 8 }[match[2]] || 1) : NaN;
  };
  const css = svg.getAttribute("style") || "";
  let width = absolute(
    svg.getAttribute("width") ||
      /(?:^|;)\s*width\s*:\s*([^;!]+)/i.exec(css)?.[1]?.trim(),
  );
  let height = absolute(
    svg.getAttribute("height") ||
      /(?:^|;)\s*height\s*:\s*([^;!]+)/i.exec(css)?.[1]?.trim(),
  );
  if (validViewBox) {
    if (width > 0 && !(height > 0)) height = (width * viewBox[3]) / viewBox[2];
    else if (height > 0 && !(width > 0))
      width = (height * viewBox[2]) / viewBox[3];
    else if (!(width > 0 && height > 0)) {
      width = viewBox[2];
      height = viewBox[3];
    }
  }
  if (!(width > 0 && height > 0)) throw new RichError("rich-svg-size-missing");
  return { width, height };
}

function pixelBudget(width, height, scale, maxPixels) {
  const pixels = Math.ceil(width * scale) * Math.ceil(height * scale);
  if (
    !Number.isSafeInteger(pixels) ||
    pixels <= 0 ||
    pixels > maxPixels ||
    width * scale > 32767 ||
    height * scale > 32767
  )
    throw new RichError("rich-limit");
  return pixels;
}

function pngBytes(value) {
  const bytes =
    value instanceof Uint8Array
      ? value
      : value?.bytes instanceof Uint8Array
        ? value.bytes
        : null;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    !bytes ||
    bytes.length < 33 ||
    signature.some((byte, index) => bytes[index] !== byte) ||
    String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR"
  )
    throw new RichError("rich-png-invalid");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16),
    height = view.getUint32(20);
  if (!width || !height) throw new RichError("rich-png-invalid");
  return { bytes, width, height };
}

function unwrapMath(raw) {
  const trimmed = raw.trim();
  for (const [opening, closing] of [
    ["$$", "$$"],
    ["\\[", "\\]"],
    ["\\(", "\\)"],
    ["$", "$"],
  ])
    if (
      trimmed.startsWith(opening) &&
      trimmed.endsWith(closing) &&
      trimmed.length >= opening.length + closing.length
    )
      return trimmed.slice(opening.length, -closing.length).trim();
  return trimmed;
}

function sourceUnsafe(source, kind) {
  if (
    /(?:https?:|data:|javascript:|file:|ftp:|\/\/[A-Za-z0-9])|@import|\burl\s*\(/i.test(
      source,
    )
  )
    return true;
  return kind === "mermaid"
    ? /%%\{|^\s*click\b|<(?:script|iframe|img|object|foreignObject)\b/im.test(
        source,
      )
    : /\\(?:require|href|url|html\w*|includegraphics|style|class|cssId)\b/.test(
        source,
      );
}

function issueFor(code, index, source) {
  const messages = {
    "rich-renderer-missing": "本地图表或公式渲染器尚未加载，无法完成导出",
    "rich-source-missing":
      "无法可靠对应图表或公式源码，请保留原始 Markdown 后重试",
    "rich-source-unsafe":
      "图表或公式包含外部资源、配置指令或交互行为，请改为独立的本地静态内容",
    "rich-svg-unsafe":
      "图表输出含脚本、外部引用、HTML 或不支持的 SVG 元素，无法安全导出",
    "rich-svg-size-missing": "无法确定图表输出尺寸，请核对图表渲染结果",
    "rich-render-failed": "图表或公式渲染失败，请核对本地源码",
    "rich-timeout": "本地图表处理超时，导出尚未完成，请核对后重试",
    "rich-limit": "图表数量、尺寸、源码或输出体积超过本地处理上限",
    "rich-png-invalid": "图表转换没有生成有效的 PNG 图片，导出尚未完成",
    "rich-capability-missing":
      "当前浏览器缺少本地图表转换能力，请使用支持 Canvas 与 Web Crypto 的浏览器",
  };
  return {
    id: `${code}:${index}`,
    code,
    severity: "blocker",
    field: source?.from === undefined ? "html" : "content",
    ...(source?.from === undefined ? {} : { from: source.from, to: source.to }),
    message: messages[code] || messages["rich-render-failed"],
  };
}

/**
 * Default PNG export returns byte assets for a caller-owned staging adapter.
 * Each ``src`` equals ``asset.name`` until the caller persists/replaces it.
 * mode:'svg' is an explicit preview choice and produces no raster assets.
 * No renderer exception text or article source is copied into issue messages.
 */
export async function renderRichContent(html, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const {
    document = globalThis.document,
    markdown = "",
    mermaid,
    mathjax,
    katex,
    mode,
    scale,
  } = settings;
  if (
    typeof html !== "string" ||
    typeof markdown !== "string" ||
    !document?.createElement ||
    !["png", "svg"].includes(mode) ||
    ![2, 3].includes(scale)
  )
    throw new TypeError("Invalid rich content rendering options");
  for (const name of [
    "timeoutMs",
    "maxCount",
    "maxSourceLength",
    "maxHtmlLength",
    "maxPixels",
    "maxTotalPixels",
    "maxAssetBytes",
    "maxTotalBytes",
  ])
    if (!Number.isSafeInteger(settings[name]) || settings[name] < 1)
      throw new TypeError("Invalid rich content processing limit");
  const result = {
    html,
    assets: [],
    issues: [],
    ready: false,
    mode,
    renderedCount: 0,
  };
  if (html.length > settings.maxHtmlLength || markdown.length > 200000) {
    result.issues.push(issueFor("rich-limit", 0));
    return result;
  }
  const root = fragment(document, html);
  const all = [...root.querySelectorAll(SELECTOR)];
  const selected = all.filter((node) => !node.parentElement?.closest(SELECTOR));
  if (!selected.length) return { ...result, ready: true };
  if (selected.length > settings.maxCount) {
    result.issues.push(issueFor("rich-limit", 0));
    return result;
  }
  const diagramNodes = selected.filter(
    (node) =>
      !node.hasAttribute("data-math-raw") &&
      !node.classList.contains("math") &&
      !node.classList.contains("katex-pending"),
  );
  const { fences, mask } = scanCodeRegions(markdown);
  const diagramFences = fences.filter(
    (fence) => fence.language.toLowerCase() === "mermaid",
  );
  const deadline = Date.now() + settings.timeoutMs;
  let totalPixels = 0,
    totalBytes = 0,
    mathCursor = 0;
  const awaitWithin = (promise) => within(promise, deadline - Date.now());
  for (const [index, node] of selected.entries()) {
    let source, renderText;
    try {
      const isMath = !diagramNodes.includes(node);
      const kind = isMath ? "math" : "mermaid";
      let explicit = isMath
        ? (node.getAttribute("data-math-raw") ?? node.textContent)
        : node.getAttribute("data-mermaid-source");
      if (
        !isMath &&
        explicit !== null &&
        node.getAttribute("data-rich-source-encoding") === "uri"
      )
        explicit = decodeURIComponent(explicit);
      if (!isMath) {
        const ordinal = diagramNodes.indexOf(node);
        const fence =
          diagramFences.length === diagramNodes.length
            ? diagramFences[ordinal]
            : null;
        if (explicit !== null) {
          source = { kind, text: explicit };
          const from = Number(node.getAttribute("data-rich-source-from"));
          const to = Number(node.getAttribute("data-rich-source-to"));
          const original = diagramFences.find(
            (item) =>
              item.bodyFrom === from &&
              item.bodyTo === to &&
              normalizedFence(markdown, item) === explicit,
          );
          if (original)
            source = { kind, text: markdown.slice(from, to), from, to };
          renderText = explicit;
        } else if (fence) {
          source = {
            kind,
            text: markdown.slice(fence.bodyFrom, fence.bodyTo),
            from: fence.bodyFrom,
            to: fence.bodyTo,
          };
          renderText = normalizedFence(markdown, fence);
        } else if (
          node.tagName.toLowerCase() === "pre" ||
          node.tagName.toLowerCase() === "code"
        )
          source = { kind, text: node.textContent };
        else throw new RichError("rich-source-missing");
      } else {
        source = {
          kind,
          text: explicit,
          display:
            node.getAttribute("data-math-display") === "true" ||
            node.classList.contains("katex-block") ||
            /^\s*(?:\$\$|\\\[)/.test(explicit),
        };
        let from = markdown.indexOf(explicit, mathCursor);
        while (from !== -1 && mask[from])
          from = markdown.indexOf(
            explicit,
            from + Math.max(1, explicit.length),
          );
        if (from !== -1 && explicit.length) {
          source.from = from;
          source.to = from + explicit.length;
          mathCursor = source.to;
        }
      }
      if (!source.text?.trim()) throw new RichError("rich-source-missing");
      renderText ??= source.text;
      if (source.text.length > settings.maxSourceLength)
        throw new RichError("rich-limit");
      if (sourceUnsafe(renderText, kind))
        throw new RichError("rich-source-unsafe");
      let output =
        node.tagName.toLowerCase() === "svg"
          ? node.outerHTML
          : node.querySelector("svg")?.outerHTML;
      if (!output && !isMath) {
        if (typeof mermaid?.render !== "function")
          throw new RichError("rich-renderer-missing");
        const hash = await awaitWithin(
          sha256(new TextEncoder().encode(source.text)),
        );
        mermaid.initialize?.({
          startOnLoad: false,
          securityLevel: "strict",
          htmlLabels: false,
          flowchart: { htmlLabels: false },
          fontFamily: "sans-serif",
          deterministicIds: true,
          deterministicIDSeed: hash.slice(0, 16),
          maxTextSize: settings.maxSourceLength,
          suppressErrorRendering: true,
          secure: [
            "securityLevel",
            "startOnLoad",
            "htmlLabels",
            "flowchart",
            "maxTextSize",
          ],
        });
        output = (
          await awaitWithin(
            Promise.resolve().then(() =>
              mermaid.render(
                `rich-mermaid-${hash.slice(0, 16)}`,
                renderText.trim(),
              ),
            ),
          )
        )?.svg;
      } else if (!output && isMath) {
        if (typeof mathjax?.tex2svg === "function") {
          await awaitWithin(mathjax.startup?.promise);
          mathjax.texReset?.();
          const rendered = await awaitWithin(
            Promise.resolve().then(() =>
              mathjax.tex2svg(unwrapMath(source.text), {
                display: source.display,
              }),
            ),
          );
          output =
            rendered?.tagName?.toLowerCase() === "svg"
              ? rendered.outerHTML
              : rendered?.querySelector?.("svg")?.outerHTML;
        } else if (
          mode === "svg" &&
          typeof katex?.renderToString === "function"
        ) {
          // Local MathML is a deliberate preview fallback, never claimed as PNG.
          const mathml = await awaitWithin(
            Promise.resolve().then(() =>
              katex.renderToString(unwrapMath(source.text), {
                displayMode: source.display,
                output: "mathml",
                throwOnError: true,
                trust: false,
                maxSize: 20,
                maxExpand: 1000,
              }),
            ),
          );
          const content = fragment(document, mathml);
          if (
            !content.querySelector("math") ||
            content.querySelector("script,iframe,img,[href],[src]")
          )
            throw new RichError("rich-render-failed");
          node.replaceChildren(...content.childNodes);
          node.classList.remove("katex-pending");
          result.renderedCount++;
          continue;
        } else throw new RichError("rich-renderer-missing");
      }
      const svg = safeSVG(document, output);
      const { width, height } = dimensions(svg);
      const pixels = pixelBudget(width, height, scale, settings.maxPixels);
      totalPixels += pixels;
      if (totalPixels > settings.maxTotalPixels)
        throw new RichError("rich-limit");
      if (mode === "svg") {
        if (node.tagName.toLowerCase() === "svg") node.replaceWith(svg);
        else node.replaceChildren(svg);
      } else {
        await awaitWithin(document.fonts?.ready);
        const rasterizer = settings.rasterizeSvg || rasterizeSvg;
        const rendered = await awaitWithin(
          Promise.resolve().then(() =>
            rasterizer(svg.outerHTML, {
              document,
              width,
              height,
              scale,
              maxPixels: settings.maxPixels,
              timeoutMs: Math.max(1, deadline - Date.now()),
              background: settings.background,
            }),
          ),
        );
        const png = pngBytes(rendered);
        pixelBudget(png.width, png.height, 1, settings.maxPixels);
        totalBytes += png.bytes.byteLength;
        if (
          png.bytes.byteLength > settings.maxAssetBytes ||
          totalBytes > settings.maxTotalBytes
        )
          throw new RichError("rich-limit");
        const hash = await awaitWithin(sha256(png.bytes));
        const name = `rich-${kind}-${hash.slice(0, 24)}.png`;
        result.assets.push({
          name,
          mime: "image/png",
          bytes: png.bytes,
          sha256: hash,
          width: png.width,
          height: png.height,
          source: { ...source },
        });
        const image = document.createElement("img");
        image.setAttribute("src", name);
        image.setAttribute("alt", isMath ? "公式" : "Mermaid 图表");
        image.setAttribute("width", String(Math.ceil(width)));
        image.setAttribute(
          "style",
          `max-width:100%;height:auto;${isMath && !source.display ? "vertical-align:middle;" : ""}`,
        );
        if (
          node.tagName.toLowerCase() === "code" &&
          node.parentElement?.tagName.toLowerCase() === "pre"
        )
          node.parentElement.replaceWith(image);
        else if (
          node.tagName.toLowerCase() === "svg" ||
          node.tagName.toLowerCase() === "code" ||
          node.tagName.toLowerCase() === "pre"
        )
          node.replaceWith(image);
        else node.replaceChildren(image);
      }
      node.classList.remove("katex-pending");
      if (isMath) node.classList.remove("math");
      node.setAttribute("data-md-diagram-state", "ready");
      result.renderedCount++;
    } catch (error) {
      const code =
        error instanceof RichError ? error.code : "rich-render-failed";
      result.issues.push(issueFor(code, index, source));
    }
  }
  result.html = serialize(root);
  result.ready = !result.issues.some((issue) => issue.severity === "blocker");
  return result;
}

/** Safe SVG -> PNG only; no article or ordinary code is captured as an image. */
export async function rasterizeSvg(
  svg,
  {
    document = globalThis.document,
    width,
    height,
    scale = 2,
    maxPixels = DEFAULTS.maxPixels,
    timeoutMs = 10000,
    background = "#ffffff",
  } = {},
) {
  if (!document?.createElement || ![2, 3].includes(scale))
    throw new Error("SVG rasterization requires browser canvas/image APIs");
  const checked = safeSVG(document, svg);
  if (!(width > 0 && height > 0)) ({ width, height } = dimensions(checked));
  pixelBudget(width, height, scale, maxPixels);
  const window = document.defaultView;
  const Image = window?.Image;
  const URL = window?.URL;
  const Blob = window?.Blob;
  const canvas = document.createElement("canvas");
  if (
    typeof Image !== "function" ||
    typeof URL?.createObjectURL !== "function" ||
    typeof Blob !== "function" ||
    typeof canvas.getContext !== "function"
  )
    throw new Error("SVG rasterization requires browser canvas/image APIs");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas rasterization context is unavailable");
  if (background !== null && !/^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(background))
    throw new Error("Invalid raster background color");
  const deadline = Date.now() + timeoutMs;
  const awaitWithin = (promise) => within(promise, deadline - Date.now());
  await awaitWithin(document.fonts?.ready);
  checked.setAttribute("width", String(width));
  checked.setAttribute("height", String(height));
  const url = URL.createObjectURL(
    new Blob([checked.outerHTML], { type: "image/svg+xml;charset=utf-8" }),
  );
  try {
    const image = new Image();
    const loaded =
      typeof image.decode === "function"
        ? null
        : new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = () =>
              reject(new Error("SVG image decoding failed"));
          });
    image.src = url;
    await awaitWithin(loaded || image.decode());
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    if (background) {
      context.fillStyle = background;
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await awaitWithin(
      new Promise((resolve, reject) =>
        canvas.toBlob(
          (value) =>
            value
              ? resolve(value)
              : reject(new Error("PNG rasterization failed")),
          "image/png",
        ),
      ),
    );
    return {
      bytes: new Uint8Array(await awaitWithin(blob.arrayBuffer())),
      width: canvas.width,
      height: canvas.height,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}
