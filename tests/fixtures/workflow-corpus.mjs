/** Entirely synthetic acceptance material. Contains no measured performance data. */
export const CODE_SAMPLES = Object.freeze(Object.fromEntries(Object.entries({
  python: 'message = "按装中文 <tag> & $x$"\nif True:\n\tprint(message)\n',
  cpp: '#include <iostream>\nint main() {\n\tconst char* text = "中文 <tag> & \\\"quote\\\"";\n\tstd::cout << text;\n}\n',
  tilelang: 'import tilelang as T\n@T.prim_func\ndef synthetic_kernel():\n\twith T.Kernel(1, threads=64):\n\t\tT.evaluate(0)\n',
  triton: 'import triton\nimport triton.language as tl\n@triton.jit\ndef synthetic_kernel(X):\n\tvalue = tl.load(X)\n\ttl.store(X, value)\n',
  powershell: '$message = "中文 <tag> & 保留引号"\nWrite-Output $message\n$env:SYNTHETIC_VALUE = "example-only"\n',
  bash: '# Synthetic static example; never executed by the fixture.\nprintf \'%s\\n\' "中文 <tag> & literal"\n',
  text: '合成输出日志；按装是必须原样保留的日志字符串。\n<result status="ok">literal & data</result>\n' + 'L'.repeat(270) + '\nOUTPUT-END-Ω\n',
}).map(([language, source]) => [language, source.replace(/\n$/, '')])));

export const DEVICE_CASES = Object.freeze([
  { id: 'phone-320', label: '窄屏手机', width: 320 },
  { id: 'phone-393', label: '手机 393', width: 393 },
  { id: 'phone-402', label: '手机 402', width: 402 },
  { id: 'phone-440', label: '大屏手机', width: 440 },
  { id: 'phone-412', label: 'Android 手机', width: 412 },
  { id: 'fold-344', label: '折叠屏外屏', width: 344 },
  { id: 'fold-690', label: '折叠屏展开 690', width: 690 },
  { id: 'fold-836', label: '折叠屏展开 836', width: 836 },
  { id: 'ipad-744', label: 'iPad 744', width: 744 },
  { id: 'ipad-820', label: 'iPad 820', width: 820 },
]);

export const IMAGE_TITLES = Object.freeze(Array.from({ length: 15 }, (_, i) => `图${i + 1} 合成流程配图 ${String(i + 1).padStart(2, '0')}`));
export const WIDE_TABLE_LAST_CELL = 'FINAL-ROW-LAST-COLUMN-Ω';

export function buildWorkflowMarkdown() {
  const sections = [
    '# 合成技术文章验收集', '',
    '这是纯合成的浏览器验收材料；数值和输出均为示例，不代表硬件性能、官方支持或微信真机结果。', '',
    '## 环境与阅读结构', '',
    '> 引用说明：保留原始 Markdown、可复制代码、配图原件及来源信息。', '',
    '### 代码与命令', '',
  ];
  for (const [language, text] of Object.entries(CODE_SAMPLES)) sections.push(`\`\`\`${language}\n${text}\n\`\`\``, '');
  sections.push('#### 宽表格与最后一列', '',
    '| 配置 | 长词与链接 | 中文说明 | 保留代码 | 最后一列 |',
    '| --- | --- | --- | --- | --- |',
    '| 合成 GPU A | [' + 'LONGWORD'.repeat(18) + '](https://example.org/synthetic) | ' + '中文说明完整可达'.repeat(15) + ' | `batch_size=1` | FIRST-ROW-END |',
    '| 合成 GPU B | 第二行示例 | 末行数据全部保留 | `dtype="example"` | ' + WIDE_TABLE_LAST_CELL + ' |', '',
    '##### 五级标题：深层大纲保留', '',
    '下面包含 15 张合成配图，每张都有独立引用、图注与本地素材。', '',
  );
  for (const [index, title] of IMAGE_TITLES.entries()) sections.push(`![${title}|480x240](images/synthetic-${String(index + 1).padStart(2, '0')}.png "${title}")`, '', `配图 ${index + 1} 后的独立说明段落必须保留。`, '');
  sections.push('## 公式与流程图', '',
    '行内公式示例：$x^2 + y^2 = z^2$；保留普通文字与行内代码 `$not_math$`。', '',
    '$$', '\\frac{1}{n} \\sum_{i=1}^{n} x_i', '$$', '',
    '```mermaid', 'graph TD', '  A[合成输入] --> B[本地检查]', '  B --> C[完整预览]', '```', '',
    '## 来源与验收边界', '',
    '来源：[合成材料说明](https://example.org/synthetic-source)。所有命令只作为静态文本显示。', '',
    'ARTICLE-END-KEEP-Ω', '',
  );
  return sections.join('\n');
}

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOwqdj3HwAE2AJywnY5xAAAAABJRU5ErkJggg==';
function fromBase64(base64) { return Uint8Array.from(atob(base64), char => char.charCodeAt(0)); }

/** Canvas improves visual inspection; the dependency-free fallback is a valid PNG. */
export function createWorkflowAssets({ document } = {}) {
  return IMAGE_TITLES.map((title, index) => {
    let bytes, width = 1, height = 1;
    const canvas = document?.createElement('canvas');
    const context = canvas?.getContext?.('2d');
    if (context) {
      width = canvas.width = 480; height = canvas.height = 240;
      context.fillStyle = `hsl(${(index * 31) % 360} 55% 90%)`; context.fillRect(0, 0, width, height);
      context.fillStyle = '#14416b'; context.font = '24px sans-serif'; context.fillText(title, 24, 60);
      context.strokeStyle = '#2769a2'; context.lineWidth = 4; context.strokeRect(24, 90, 180, 95); context.strokeRect(270, 90, 180, 95);
      context.beginPath(); context.moveTo(208, 138); context.lineTo(264, 138); context.stroke();
      context.font = '18px sans-serif'; context.fillText(`Synthetic ${index + 1}`, 40, 144); context.fillText('Local only', 292, 144);
      bytes = fromBase64(canvas.toDataURL('image/png').split(',')[1]);
    } else {
      const original = fromBase64(TINY_PNG);
      const marker = new TextEncoder().encode(`synthetic-corpus-${index + 1}`);
      bytes = new Uint8Array(original.length + marker.length); bytes.set(original); bytes.set(marker, original.length);
    }
    const path = `images/synthetic-${String(index + 1).padStart(2, '0')}.png`;
    return { path, title, bytes, width, height, content_type: 'image/png', size: bytes.length };
  });
}
