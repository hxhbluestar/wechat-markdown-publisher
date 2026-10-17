# 本地运行依赖

`wheels/` 内为纯 Python 离线依赖，`server.py` 会直接从这些 wheel 加载：

- `markdown-it-py==4.0.0`
- `mdurl==0.1.2`

运行站点时不需要访问 PyPI 或其他网络服务。许可证及包元数据保留在 wheel 内。

## PowerShell 代码高亮

`highlight-powershell-11.11.1.min.js` 是 Highlight.js 11.11.1 的 PowerShell 语法模块，与页面已有的同版本 Highlight.js 配合使用；未标注或不支持的语言保留纯文本。

- 官方语法源文件：[highlightjs/highlight.js · powershell.js · 11.11.1](https://github.com/highlightjs/highlight.js/blob/11.11.1/src/languages/powershell.js)。
- 采用 [BSD-3-Clause 许可证](https://github.com/highlightjs/highlight.js/blob/11.11.1/LICENSE)，版权声明为 `Copyright (c) 2006, Ivan Sagalaev. All rights reserved.`；允许修改和再分发，须保留版权、许可条件及免责声明，不得使用原作者或贡献者姓名为衍生产品背书。
- 公开仓库保留的许可证全文位于 `licenses/highlightjs.txt`；维护工程对应文件位于 `publication/licenses/highlightjs.txt`。已有 `app/web/highlight.min.js` 中的原始声明继续保留。

此文件只注册语法，不连接外部服务，也不包含 PowerShell 执行能力。

## AI/GPU 与构建语法

- `highlight-extras-11.11.1.js`：来自 npm 官方 `highlight.js@11.11.1` 的 `lib/languages/dockerfile.js`、`cmake.js`、`llvm.js`，保留原语法并封装浏览器注册；同样适用上述 BSD-3-Clause 许可证。
- `highlight-ai-20261017.js`：工程维护的词法扩展，由 `frontend/code-languages.js` 构建复制，基于现有 Python/C++ 模式注册 AI Python、TileLang、Triton、HIP、CUDA，保留原有语法。并补充 LLVM `ll` 别名。
- 加载顺序：核心 → PowerShell → extras → AI/GPU → 编辑器模块。全部本地同步加载，无自动语言猜测、无代码执行、无远程依赖。
