/** Offline editorial guidance only. Commands and snippets are never executed. */
export const CONTENT_TEMPLATES = Object.freeze([
  Object.freeze({ id: "tutorial", label: "原创上手教程" }),
  Object.freeze({ id: "benchmark", label: "性能实测 / 复现报告" }),
  Object.freeze({ id: "rocm-repost", label: "ROCm 博客转载" }),
]);

export const EXPERIMENT_FIELDS = Object.freeze(
  [
    ["hardware", "硬件 / GPU 型号与数量"],
    ["vram", "显存容量与 GB / GiB 口径"],
    ["os_kernel", "操作系统 / 内核"],
    ["rocm_version", "ROCm 版本"],
    ["framework_version", "框架及版本"],
    ["model_version", "模型名称 / 固定版本"],
    ["precision", "精度 / 量化方式"],
    ["parallelism", "并行策略 / 单卡或整机"],
    ["input_output_length", "输入 / 输出长度"],
    ["concurrency", "并发数 / 批大小"],
    ["test_date", "测试日期"],
    ["raw_data_source", "原始数据 / 日志来源"],
  ].map(([key, label]) => Object.freeze({ key, label })),
);

const TUTORIAL_REQUIRED = new Set([
  "hardware",
  "os_kernel",
  "rocm_version",
  "framework_version",
]);
function fieldsFor(type) {
  return EXPERIMENT_FIELDS.map((field) => ({
    ...field,
    required:
      type === "benchmark" ||
      (type === "tutorial" && TUTORIAL_REQUIRED.has(field.key)),
  }));
}

function templateType(type) {
  if (!CONTENT_TEMPLATES.some((template) => template.id === type))
    throw new TypeError("Unknown content template");
  return type;
}

/** Return fresh, editable content and provenance; never overwrite the caller's draft. */
export function createContentTemplate(type, metadata = {}) {
  templateType(type);
  const copied = structuredClone(metadata);
  const title = String(copied.title || "待补充标题");
  const experimentFields = fieldsFor(type);
  copied.article_type = type;
  copied.experiment_conditions = { ...(copied.experiment_conditions || {}) };
  const conditions = experimentFields
    .map(
      (field) =>
        `| ${field.label} | ${copied.experiment_conditions[field.key] || "待补充"} |`,
    )
    .join("\n");
  const environment = `## 环境与复现条件\n\n| 条件 | 作者填写 |\n| --- | --- |\n${conditions}`;
  const source = `## 来源与署名\n\n- 作者：${copied.author || "待补充"}\n- 原文作者：${copied.source_author || "待补充"}\n- 来源：${copied.source_url || "待补充"}\n- 原文日期：${copied.source_date || "待补充"}\n- 导入日期：${copied.imported_at || "待补充"}`;
  const bodies = {
    tutorial: `## 目标与适用范围\n\n待补充：读者完成后能够验证的结果与前置知识。\n\n${environment}\n\n## 安装与操作步骤\n\n待补充：命令、预期输出和逐步验证。\n\n## 常见问题与回退\n\n待补充：失败条件、排查方法与恢复步骤。\n\n${source}`,
    benchmark: `## 测试问题与结论边界\n\n待补充：比较对象、同功耗条件、单卡或整机，以及结论适用范围。\n\n${environment}\n\n## 方法与指标定义\n\n待补充：预热、测量次数、统计方式；TTFT / TPOT / ITL，输出吞吐或总吞吐的定义。\n\n## 结果与原始记录\n\n待补充：标明实测数据或示例数据，保留原始日志与计算方法；不填入虚构结果。\n\n## 限制与复现步骤\n\n待补充：误差、失败样例和固定版本命令。\n\n${source}`,
    "rocm-repost": `${source}\n\n## 导读\n\n待补充：原文主题、适用版本与转载说明。\n\n## 原文译文\n\n待补充：保留作者、图注、代码原文与参考链接。\n\n## 译注与版本提示\n\n待补充：区分译者补充与原文结论；核对官方支持的具体型号及版本。`,
  };
  return {
    type,
    content: `# ${title}\n\n${bodies[type]}\n`,
    metadata: copied,
    experimentFields,
  };
}

/** Exactly three rule-based title structures. No remote AI service is involved. */
export function createTitleCandidates(type, metadata = {}) {
  templateType(type);
  const topic = String(metadata.topic || metadata.title || "技术主题");
  const hardware = String(metadata.hardware || "目标平台");
  const titles = {
    tutorial: [
      `${topic} 上手指南：从环境准备到结果验证`,
      `${hardware} 实践：一步步运行 ${topic}`,
      `${topic} 复现笔记：步骤、检查与常见问题`,
    ],
    benchmark: [
      `${topic} 性能实测：环境、指标与结果`,
      `${hardware} 上的 ${topic}：一次可复现测试`,
      `${topic} 测试报告：方法、数据与适用边界`,
    ],
    "rocm-repost": [
      `ROCm 博客译读：${topic}`,
      `${topic}：ROCm 原文要点与译注`,
      `从原文到实践：${topic} 技术导读`,
    ],
  };
  return titles[type].map((title, index) => ({
    id: `${type}-${index + 1}`,
    title,
    editable: true,
  }));
}

/** UTF-16 positions, shared by the preflight scanner. Does not alter source text. */
export function scanCodeRegions(content) {
  const mask = new Uint8Array(content.length);
  const lines = [];
  const fences = [];
  let open = null;
  for (let from = 0; from < content.length;) {
    const newline = content.indexOf("\n", from);
    const to = newline === -1 ? content.length : newline + 1;
    const text = content.slice(from, to).replace(/\r?\n$/, "");
    const unquoted = text.replace(/^(?: {0,3}>[ \t]?)*/, "");
    const body = unquoted.replace(/^ {0,3}/, "");
    const line = { from, to, text };
    lines.push(line);
    if (open) {
      mask.fill(1, from, to);
      const closing = /^(\x60+|~+)[ \t]*$/.exec(body);
      if (
        closing &&
        closing[1][0] === open.marker[0] &&
        closing[1].length >= open.marker.length
      ) {
        open.bodyTo = from;
        open.to = to;
        open.closed = true;
        open = null;
      }
    } else {
      const match =
        /^(?:(?:[-+*]|\d+[.)])[ \t]+)?(\x60{3,}|~{3,})([^\r\n]*)$/.exec(body);
      if (match) {
        const language = match[2].trim().split(/\s/)[0] || "";
        open = {
          from,
          to: content.length,
          bodyFrom: to,
          bodyTo: content.length,
          marker: match[1],
          language,
          closed: false,
        };
        fences.push(open);
        mask.fill(1, from, to);
      } else if (/^(?: {4}|\t)/.test(unquoted)) mask.fill(1, from, to);
    }
    from = to;
  }
  // Protect raw HTML code and comments; ordinary image tags remain inspectable.
  for (const match of content.matchAll(
    /<!--[\s\S]*?(?:-->|$)|<(pre|code|script|style)\b[^>]*>/gi,
  )) {
    if (mask[match.index]) continue;
    let to = match.index + match[0].length;
    if (match[1]) {
      const closing = new RegExp(`</${match[1]}\\s*>`, "ig");
      closing.lastIndex = to;
      const end = closing.exec(content);
      to = end ? end.index + end[0].length : content.length;
    }
    mask.fill(1, match.index, to);
  }
  const runs = [];
  for (let from = 0; from < content.length; from++) {
    if (mask[from] || content[from] !== "`") continue;
    let to = from + 1;
    while (content[to] === "`") to++;
    runs.push({ from, to });
    from = to - 1;
  }
  const next = new Map();
  for (let i = runs.length - 1; i >= 0; i--) {
    const length = runs[i].to - runs[i].from;
    runs[i].next = next.get(length);
    next.set(length, i);
  }
  for (let i = 0; i < runs.length; i++)
    if (runs[i].next !== undefined) {
      const closing = runs[i].next;
      mask.fill(1, runs[i].from, runs[closing].to);
      i = closing;
    }
  return { mask, fences, lines };
}

function proseOnly(content) {
  const { mask } = scanCodeRegions(content);
  for (const match of content.matchAll(
    /\]\((?:\\.|[^)\n])*\)|\b(?:https?:\/\/|www\.)[^\s<>，。！？；：（）【】]+|<[^>]*>|(?:[A-Za-z]:[\\/]|\.{1,2}\/|(?<![A-Za-z0-9])\/)[^\s<>"'`，。！？；：（）【】]+/g,
  ))
    mask.fill(1, match.index, match.index + match[0].length);
  return content
    .split("")
    .map((char, index) => (mask[index] ? " " : char))
    .join("");
}

/** Returns suggestions only, with safe fixed wording and no source excerpts. */
export function analyzeTechnicalWriting(content, metadata = {}) {
  if (typeof content !== "string")
    throw new TypeError("Technical writing content must be a string");
  const prose = proseOnly(content);
  const issues = [];
  const add = (code, from, to, message, extra = {}) =>
    issues.push({
      code,
      severity: "info",
      field: "content",
      from,
      to,
      message,
      ...extra,
    });
  const terms = new Map(
    [
      "AMD",
      "ROCm",
      "PyTorch",
      "TileLang",
      "Triton",
      "HIP",
      "vLLM",
      "SGLang",
    ].map((term) => [term.toLowerCase(), term]),
  );
  for (const match of prose.matchAll(
    /AMD|ROCm|PyTorch|TileLang|Triton|HIP|vLLM|SGLang/gi,
  )) {
    const before = prose[match.index - 1] || "";
    const after = prose[match.index + match[0].length] || "";
    if (/[A-Za-z0-9_$.-]/.test(before) || /[A-Za-z0-9_$.-]/.test(after))
      continue;
    const suggested = terms.get(match[0].toLowerCase());
    if (match[0] !== suggested)
      add(
        "technical-term",
        match.index,
        match.index + match[0].length,
        `核对技术专名大小写：${suggested}；品牌和版本由作者确认`,
        { suggested },
      );
  }
  const guidance = [
    [
      "metric-latency-definition",
      /\b(?:TTFT|TPOT|ITL)\b/i,
      "说明 TTFT / TPOT / ITL 的定义、单位、统计方法及是否包含排队时间",
    ],
    [
      "metric-memory-units",
      /\b(?:GB|GiB)\b/,
      "核对 GB 与 GiB 的单位口径，并注明显存容量或测量值",
    ],
    [
      "metric-throughput-definition",
      /(?:输出吞吐|总吞吐|吞吐量|tokens?\s*\/\s*s)/i,
      "说明输出吞吐或总吞吐、单卡或整机，以及输入输出长度与并发",
    ],
    [
      "version-unpinned",
      /\b(?:latest|nightly)\b/i,
      "可变版本引用建议补充测试日期及固定版本或提交号",
    ],
    [
      "agentic-context",
      /\b(?:Agentic AI|AI agents?)\b/i,
      "结合上下文区分“智能体 AI”和“AI 智能体”，不自动统一译法",
    ],
  ];
  for (const [code, pattern, message] of guidance) {
    const match = pattern.exec(prose);
    if (match) add(code, match.index, match.index + match[0].length, message);
  }
  if (["tutorial", "benchmark"].includes(metadata.article_type)) {
    const conditions = metadata.experiment_conditions || {};
    for (const field of fieldsFor(metadata.article_type)) {
      const value =
        conditions[field.key] === undefined || conditions[field.key] === null
          ? ""
          : String(conditions[field.key]).trim();
      if (
        field.required &&
        (!value || /^(?:待补充|待完善|TODO|TBD|\{\{[^}]*\}\})$/i.test(value))
      ) {
        issues.push({
          code: "experiment-condition-missing",
          severity: "confirm",
          field: `experiment_conditions.${field.key}`,
          message: `请补充复现条件：${field.label}`,
        });
      }
    }
  }
  return issues;
}
