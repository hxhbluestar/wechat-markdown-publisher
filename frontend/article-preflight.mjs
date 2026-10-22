import { analyzeMarkdown, MAX_ANALYSIS_LENGTH } from "./proofreading-core.mjs";
import { canonicalAssetPath } from "./asset-paths.mjs";
import {
  analyzeTechnicalWriting,
  scanCodeRegions,
} from "./technical-writing.mjs";

// This module is static and local: no fetch, DOM execution, command execution or
// article rewriting. Offsets always address the original UTF-16 input field.
export const PREFLIGHT_VERSION = "1";
const MAX_REPORT_ISSUES = 2000;
const IMAGE_SUFFIX = /\.(?:png|jpe?g|gif|webp)$/i;
// Matches the bundled Highlight.js grammars plus local AI/GPU aliases. text/log
// are deliberate plain output formats, not an invitation to guess a shell.
const LANGUAGES = new Set(
  "ai-python atom bash c c# c++ cc cjs cmake cmake.in console cpp cs csharp css cts cu cuda cuh cxx diff docker dockerfile gemspec go golang gql graphql gyp h h++ hh hip hip-cpp hpp html hxx ini ipython irb java javascript js json jsonc jsp jsx kotlin kt kts less llvm ll lua mak make makefile markdown md mjs mk mkd mkdown mm mts obj-c obj-c++ objc objective-c++ objectivec patch perl php php-template pl plaintext plist pluto pm podspec powershell ps ps1 psm1 psd1 pwsh py py3 pycon python python-repl python3 pytorch r rb rs rss ruby rust scss sh shell shellsession sql svg swift text thor tile-lang tile_lang tilelang toml torch triton ts tsx txt typescript vb vbnet wasm wsf xhtml xjb xml xsd xsl yaml yml zsh plain log output terminal none mermaid math latex tex".split(
    " ",
  ),
);

function privateFindings(text) {
  const findings = [];
  const add = (code, from, to, message) =>
    findings.push({
      code,
      severity: "confirm",
      from,
      to,
      message,
      masked: "[已脱敏]",
    });
  for (const match of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    const octets = match[0].split(".").map(Number);
    if (octets.some((part) => part > 255)) continue;
    const [a, b] = octets;
    if (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    )
      add(
        "privacy-private-ip",
        match.index,
        match.index + match[0].length,
        "检测到潜在内网 / 本机地址 [已脱敏]，请确认是否适合公开",
      );
  }
  for (const match of text.matchAll(
    /(?<![\w:])(?:f[cd][0-9a-f]{2}:[0-9a-f:]+|fe[89ab][0-9a-f]:[0-9a-f:]+|::1)(?![\w:])/gi,
  ))
    add(
      "privacy-private-ip",
      match.index,
      match.index + match[0].length,
      "检测到潜在内网 / 本机 IPv6 地址 [已脱敏]，请确认是否适合公开",
    );
  const credentials =
    /\b(?:[A-Z_]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|API[_-]?TOKEN|AUTH[_-]?TOKEN|SECRET|PASSWORD|PASSWD|TOKEN)[A-Z_]*)\b["']?\s*[:=]\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s\r\n;,]+))/gi;
  for (const match of text.matchAll(credentials)) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    if (
      value.length < 8 ||
      /^(?:<[^>]*>|\$\{[^}]*\}|\$[\w]+|your[_-].*|example|placeholder|redacted|\*+|x+)$/i.test(
        value,
      )
    )
      continue;
    const from = match.index + match[0].lastIndexOf(value);
    add(
      "privacy-secret",
      from,
      from + value.length,
      "检测到潜在凭据或令牌 [已脱敏]，请核对后再公开",
    );
  }
  for (const match of text.matchAll(
    /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  ))
    add(
      "privacy-secret",
      match.index,
      match.index + match[0].length,
      "检测到潜在密钥 [已脱敏]，请核对后再公开",
    );
  for (const match of text.matchAll(
    /\bBearer[ \t]+([A-Za-z0-9_.~+\/-]{12,}={0,2})/gi,
  )) {
    const from = match.index + match[0].lastIndexOf(match[1]);
    add(
      "privacy-secret",
      from,
      from + match[1].length,
      "检测到潜在访问令牌 [已脱敏]，请核对后再公开",
    );
  }
  for (const match of text.matchAll(
    /(?:\b[A-Za-z]:[\\/]Users[\\/]|\/home\/|\/Users\/)([^\s\\/<>"'`]+)|\b([A-Za-z_][\w.-]*)@(?=[A-Za-z0-9][A-Za-z0-9.-]*(?::|\b))/g,
  )) {
    const user = match[1] || match[2];
    if (
      /^(?:user|username|example|your_user|your_username|root|USERNAME)$/i.test(
        user,
      )
    )
      continue;
    const from = match.index + match[0].lastIndexOf(user);
    add(
      "privacy-username",
      from,
      from + user.length,
      "检测到潜在真实用户名 [已脱敏]，请确认是否为有意示例",
    );
  }
  for (const match of text.matchAll(
    /\b(?:hostname|host_name|主机名)\s*[:=]\s*["']?([A-Za-z][\w.-]{2,})/gi,
  )) {
    if (/^(?:localhost|example|your[-_]host)$/i.test(match[1])) continue;
    const from = match.index + match[0].lastIndexOf(match[1]);
    add(
      "privacy-hostname",
      from,
      from + match[1].length,
      "检测到潜在内部主机名 [已脱敏]，请确认是否适合公开",
    );
  }
  return findings;
}

function escaped(text, at) {
  let count = 0;
  while (at > 0 && text[--at] === "\\") count++;
  return count % 2 === 1;
}

function closingBracket(text, start) {
  let depth = 1;
  for (let at = start + 1; at < text.length; at++) {
    if (escaped(text, at)) continue;
    if (text[at] === "[") depth++;
    if (text[at] === "]" && --depth === 0) return at;
    if (text[at] === "\n") return -1;
  }
  return -1;
}

function destination(text, start) {
  let at = start;
  while (/[ \t]/.test(text[at] || "") && at < text.length) at++;
  if (text[at] === "<") {
    const end = text.indexOf(">", at + 1);
    if (end === -1 || text.slice(at, end).includes("\n")) return null;
    return {
      source: text.slice(at + 1, end),
      from: at + 1,
      to: end,
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
      if (depth === 0) break;
      depth--;
    }
  }
  return {
    source: text.slice(from, at).replace(/\\([() ])/g, "$1"),
    from,
    to: at,
    end: at,
  };
}

function htmlAttributes(tag, tagFrom = 0) {
  const result = new Map();
  const start = /^<[\w:-]+/.exec(tag)?.[0].length || 0;
  const rest = tag.slice(start);
  for (const match of rest.matchAll(
    /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g,
  )) {
    const name = match[1].toLowerCase();
    if (result.has(name)) continue;
    const value = match[2] ?? match[3] ?? match[4];
    if (value === undefined) {
      result.set(name, { value: "" });
      continue;
    }
    const equals = match[0].indexOf("=") + 1;
    const suffix = match[0].slice(equals);
    const leading = suffix.search(/\S/);
    const from =
      tagFrom +
      start +
      match.index +
      equals +
      leading +
      (/^["']/.test(suffix.slice(leading)) ? 1 : 0);
    result.set(name, { value, from, to: from + value.length });
  }
  return result;
}

function imageReferences(content, mask) {
  const references = [];
  const definitions = new Map();
  for (const match of content.matchAll(/^ {0,3}\[([^\]\r\n]+)\]:[ \t]*/gm)) {
    if (mask[match.index]) continue;
    const target = destination(content, match.index + match[0].length);
    if (target && !definitions.has(match[1].trim().toLowerCase()))
      definitions.set(match[1].trim().toLowerCase(), target);
  }
  for (let at = 0; at < content.length - 1; at++) {
    if (
      mask[at] ||
      escaped(content, at) ||
      content[at] !== "!" ||
      content[at + 1] !== "["
    )
      continue;
    const close = closingBracket(content, at + 1);
    if (close === -1) continue;
    const next = close + 1;
    if (content[next] === "(") {
      const target = destination(content, next + 1);
      if (target) references.push(target);
      at = target?.end ?? close;
    } else {
      const labelEnd =
        content[next] === "[" ? closingBracket(content, next) : -1;
      const explicit = labelEnd !== -1 ? content.slice(next + 1, labelEnd) : "";
      const key = (explicit || content.slice(at + 2, close))
        .trim()
        .toLowerCase();
      const target = definitions.get(key);
      if (target) references.push({ ...target, referenceFrom: at });
      else
        references.push({
          source: "",
          from: at,
          to: labelEnd === -1 ? close + 1 : labelEnd + 1,
          unresolved: true,
        });
      at = labelEnd === -1 ? close : labelEnd;
    }
  }
  for (const match of content.matchAll(
    /<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi,
  )) {
    if (mask[match.index]) continue;
    const attribute = htmlAttributes(match[0], match.index).get("src");
    if (!attribute)
      references.push({
        source: "",
        from: match.index,
        to: match.index + match[0].length,
      });
    else {
      references.push({
        source: attribute.value.replace(/&amp;/g, "&"),
        from: attribute.from ?? match.index,
        to: attribute.to ?? match.index + match[0].length,
      });
    }
  }
  return references;
}

function tableColumns(line) {
  const cells = line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/);
  return cells;
}

function htmlFindings(html, add) {
  for (const match of html.matchAll(
    /<([A-Za-z][\w:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/g,
  )) {
    const tag = match[1].toLowerCase();
    const attributes = htmlAttributes(match[0], match.index);
    const classes = (attributes.get("class")?.value || "").split(/\s+/);
    const args = {
      field: "html",
      from: match.index,
      to: match.index + match[0].length,
    };
    if (
      ["pre", "code", "div"].includes(tag) &&
      classes.some((name) => ["mermaid", "language-mermaid"].includes(name))
    ) {
      const close = html.indexOf(`</${tag}`, match.index + match[0].length);
      const body = html.slice(
        match.index + match[0].length,
        close === -1 ? html.length : close,
      );
      if (!/<(?:svg|img)\b/i.test(body))
        add({
          code: "render-mermaid-unresolved",
          severity: "blocker",
          message: "图表仍是未渲染的 Mermaid 源码，请完成渲染",
          ...args,
        });
    }
    if (
      tag !== "svg" &&
      classes.includes("math") &&
      !classes.some((name) => /^(?:katex|MathJax)/.test(name))
    )
      add({
        code: "render-math-unresolved",
        severity: "blocker",
        message: "公式仍带有未渲染标记，请核对公式输出",
        ...args,
      });
    const style = attributes.get("style")?.value || "";
    const css = Object.fromEntries(
      style
        .split(";")
        .map((item) => {
          const colon = item.indexOf(":");
          return colon === -1
            ? []
            : [
                item.slice(0, colon).trim().toLowerCase(),
                item
                  .slice(colon + 1)
                  .trim()
                  .toLowerCase(),
              ];
        })
        .filter((item) => item.length),
    );
    const size = /^([\d.]+)px$/.exec(css["font-size"] || "");
    const line = /^([\d.]+)px$/.exec(css["line-height"] || "");
    const inlineAnnotation =
      ["sup", "sub"].includes(tag) &&
      (css.display || "inline").replace(/\s*!important\s*$/, "").trim() ===
        "inline";
    if (
      !inlineAnnotation &&
      ((size && line && Number(line[1]) < Number(size[1])) ||
        (/^(?:0(?:\.\d+)?|\.\d+)$/.test(css["line-height"] || "") &&
          Number(css["line-height"]) < 1))
    )
      add({
        code: "render-line-height",
        severity: "confirm",
        message: "文字行高可能小于字号，请在手机预览中核对重叠",
        ...args,
      });
    if (
      (css.overflow === "hidden" || css["overflow-y"] === "hidden") &&
      /\d(?:px|em|rem)/.test(css.height || css["max-height"] || "")
    )
      add({
        code: "render-clipping",
        severity: "confirm",
        message: "固定高度同时隐藏溢出内容，存在裁切风险，请核对文字是否完整",
        ...args,
      });
  }
}

/**
 * Aggregate immutable local advice. Missing/unsupported/broken/remote images and
 * definite unresolved render output block syncing. Integrity of actual bytes,
 * external resources and final WeChat layout must be checked by their owners.
 */
export function analyzeArticle({
  content = "",
  metadata = {},
  assets = [],
  html,
  draftId = "",
  includeTechnical = true,
  ignoredWords = [],
} = {}) {
  if (
    typeof content !== "string" ||
    !metadata ||
    typeof metadata !== "object" ||
    !Array.isArray(assets) ||
    (html !== undefined && typeof html !== "string")
  )
    throw new TypeError("Invalid article preflight input");
  const source = content.slice(0, MAX_ANALYSIS_LENGTH);
  let truncated = source.length < content.length,
    adviceTruncated = false;
  const issues = [];
  const seen = new Set();
  const add = (issue) => {
    const field = issue.field || "content";
    const id = `${issue.code}:${field}:${issue.from ?? "-"}:${issue.to ?? "-"}`;
    if (seen.has(id)) return;
    seen.add(id);
    if (
      issues.length >= MAX_REPORT_ISSUES &&
      !["analysis-truncated", "advice-truncated"].includes(issue.code)
    ) {
      if (issue.severity !== "blocker") {
        adviceTruncated = true;
        return;
      }
      // Advice cannot consume the capacity reserved for actual upload errors.
      const adviceIndex = issues.findIndex(
        (item) => item.severity !== "blocker",
      );
      if (adviceIndex === -1) {
        truncated = true;
        return;
      }
      issues.splice(adviceIndex, 1);
      adviceTruncated = true;
    }
    // Uncertain findings are advice for the author, not a draft-upload gate.
    issues.push({
      id,
      ...issue,
      field,
      severity: issue.severity === "confirm" ? "info" : issue.severity,
    });
  };
  const { mask, lines, fences } = scanCodeRegions(source);
  const assetMap = new Map(
    assets
      .filter((asset) => asset && typeof asset.path === "string")
      .map((asset) => [asset.path, asset]),
  );
  const references = imageReferences(source, mask);
  for (const ref of references) {
    const position = { from: ref.from, to: ref.to };
    if (ref.unresolved)
      add({
        code: "image-reference-missing",
        severity: "blocker",
        message: "图片引用缺少对应的链接定义",
        ...position,
      });
    else if (!ref.source.trim())
      add({
        code: "image-empty",
        severity: "blocker",
        message: "图片地址为空，请选择素材",
        ...position,
      });
    else if (/^(?:https?:|data:|blob:|\/\/)/i.test(ref.source))
      add({
        code: "image-remote",
        severity: "blocker",
        message: "图片尚未成为本地素材，请导入后再同步",
        ...position,
      });
    else {
      const path = canonicalAssetPath(ref.source, draftId);
      if (
        !IMAGE_SUFFIX.test(path) ||
        /(?:^|\/)\.\.(?:\/|$)|[:\0\r\n\\]/.test(path) ||
        !/^(?:images\/|cover\.)/.test(path)
      )
        add({
          code: "image-unsupported",
          severity: "blocker",
          message: "图片路径或格式不能用于同步，请导入受支持的本地素材",
          ...position,
        });
      else {
        const asset = assetMap.get(path);
        if (!asset)
          add({
            code: "image-missing",
            severity: "blocker",
            message: "图片引用没有对应的本地素材，请补充原图",
            ...position,
          });
        else if (
          (typeof asset.size === "number" && asset.size <= 0) ||
          asset.broken === true ||
          asset.valid === false ||
          ["failed", "broken", "error"].includes(asset.status) ||
          (asset.content_type &&
            !/^image\/(?:png|jpeg|gif|webp)$/i.test(asset.content_type))
        )
          add({
            code: "image-broken",
            severity: "blocker",
            message: "图片为空或校验失败，请重新导入原图",
            ...position,
          });
      }
    }
  }
  for (const fence of fences) {
    const position = { from: fence.from, to: fence.bodyFrom };
    if (!fence.language)
      add({
        code: "code-language-missing",
        severity: "info",
        message: "代码块未标语言；日志可明确标为 text 或 log",
        ...position,
      });
    else if (!LANGUAGES.has(fence.language.toLowerCase()))
      add({
        code: "code-language-unsupported",
        severity: "info",
        message:
          "代码语言未在本地已知列表中，请核对高亮；纯输出可保留 text / log",
        ...position,
      });
    if (!fence.closed)
      add({
        code: "code-fence-unclosed",
        severity: "confirm",
        message: "代码围栏尚未闭合，请核对代码和后续正文的边界",
        ...position,
      });
  }
  let fenceIndex = 0;
  for (const line of lines) {
    while (fences[fenceIndex] && line.from >= fences[fenceIndex].bodyTo)
      fenceIndex++;
    if (
      fences[fenceIndex] &&
      line.from >= fences[fenceIndex].bodyFrom &&
      [...line.text].length > 140
    )
      add({
        code: "code-line-long",
        severity: "info",
        from: line.from,
        to: line.from + line.text.length,
        message: "代码行较长，请核对手机滚动或换行后仍能完整复制",
      });
  }
  const headings = new Set();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (mask[line.from]) continue;
    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.text);
    if (heading) {
      const title = heading[2].trim().toLowerCase();
      const position = { from: line.from, to: line.from + line.text.length };
      if (heading[1].length > 4)
        add({
          code: "heading-deep",
          severity: "info",
          message: "标题超过四级，建议核对手机阅读层次",
          ...position,
        });
      if (headings.has(title))
        add({
          code: "heading-duplicate",
          severity: "confirm",
          message: "正文出现重复标题，请核对是否重复导入或有意复用",
          ...position,
        });
      headings.add(title);
    }
    const next = lines[index + 1];
    if (
      next &&
      !mask[next.from] &&
      line.text.includes("|") &&
      /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next.text) &&
      tableColumns(line.text).length >= 5
    )
      add({
        code: "table-wide",
        severity: "info",
        from: line.from,
        to: line.from + line.text.length,
        message: "表格至少五列，请核对手机上所有列和文字均可访问",
      });
  }
  for (const [field, text] of [
    ["content", source],
    ["title", String(metadata.title || "")],
    ["digest", String(metadata.digest || "")],
  ]) {
    const privacy = privateFindings(text);
    for (const issue of privacy) add({ ...issue, field });
    const overlapsPrivacy = (issue) =>
      privacy.some((item) => issue.from < item.to && issue.to > item.from);
    const proofreading = analyzeMarkdown(text, { ignoredWords });
    adviceTruncated ||= proofreading.truncated;
    for (const issue of proofreading.issues)
      if (!overlapsPrivacy(issue))
        add({
          code: "proofreading",
          severity: "confirm",
          field,
          from: issue.from,
          to: issue.to,
          message: issue.message,
          suggested: issue.replacement,
          kind: issue.kind,
        });
    const localMask = field === "content" ? mask : scanCodeRegions(text).mask;
    for (const match of text.matchAll(
      /\b(?:TODO|TBD|FIXME)\b|待补充|待完善|占位(?:符|提示)?|\{\{[^}\r\n]+\}\}/gi,
    ))
      if (
        !localMask[match.index] &&
        !overlapsPrivacy({
          from: match.index,
          to: match.index + match[0].length,
        })
      )
        add({
          code: "placeholder",
          severity: "confirm",
          field,
          from: match.index,
          to: match.index + match[0].length,
          message: "检测到待补充或占位提示，请作者确认内容已完成",
        });
    if (includeTechnical)
      for (const issue of analyzeTechnicalWriting(
        text,
        field === "content" ? metadata : {},
      ))
        if (!overlapsPrivacy(issue))
          add({
            ...issue,
            field: issue.field === "content" ? field : issue.field,
          });
  }
  if (!String(metadata.source_url || metadata.sourceUrl || "").trim())
    add({
      code: "source-empty",
      severity: "confirm",
      field: "source_url",
      message:
        "独立来源字段为空；请核对原创署名或补充转载来源，正文中的引用仍予保留",
    });
  if (html !== undefined) {
    const rendered = html.slice(0, 5 * 1024 * 1024);
    truncated ||= rendered.length < html.length;
    htmlFindings(rendered, add);
  }
  if (adviceTruncated)
    add({
      code: "advice-truncated",
      severity: "info",
      field: "content",
      message: "建议较多，报告已省略部分提醒；不影响同步到草稿箱",
    });
  if (truncated)
    add({
      code: "analysis-truncated",
      severity: "blocker",
      field: "content",
      message: "文章超出本地检查范围，请拆分或进一步核对；预检尚未覆盖全文",
    });
  const counts = { blocker: 0, confirm: 0, info: 0, total: issues.length };
  for (const issue of issues) counts[issue.severity]++;
  return {
    version: PREFLIGHT_VERSION,
    issues,
    counts,
    canSync: counts.blocker === 0,
    truncated: truncated || adviceTruncated,
  };
}
