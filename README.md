# 微信 Markdown 发布器

在本机编辑 Markdown、管理图片与封面，并通过微信公众号官方接口同步到草稿箱。附带本地文章归档阅读器和公众号归档工具，保留现有“星河炸鸡”应用界面。

## 功能

- Markdown 编辑、预览、本地保存和多个公众号账号管理；浏览器自动暂存、重开恢复、后端版本历史、另存恢复和回收站。恢复能力以最近一次成功落盘为边界。
- 统一发布前检查覆盖标题、摘要、正文、来源和素材。服务器再次核对损坏图片、排版完整性、账号与排版器版本；确定的阻断项必须修复，提醒项逐项确认并绑定本次文章指纹。内网地址、潜在凭据及用户名使用脱敏提示，不静默改写原文。
- 文章大纲、代码折叠、分栏宽度与专注模式；局部标题、段落、图注和表格调整随稿件保存，可恢复默认值。
- 编辑区与预览双向同步滚动，按标题、段落、代码块等内容位置关联；适配机型缩放、图片加载和预览模式切换，可一键关闭同步独立查看。
- 本地离线错别字校对：正文波浪线高亮、定位、逐项/批量修改、忽略词、撤销及修改保存；同步前提醒核对常见易错词。代码、链接目标和路径自动跳过，文章不上传校对服务。见 [校对说明](docs/proofreading.md)。
- 离线 AI/GPU 代码高亮：Python/PyTorch、C++、TileLang、Triton、HIP/CUDA、PowerShell、Bash 及 Dockerfile/CMake/LLVM；等宽代码框、分层配色和公众号行内颜色导出。
- AMD 技术蓝、极简墨色、纸感期刊、曜石青四套常用文章版式；相近旧模板随已保存稿件兼容加载。支持正文、图片说明、表格字号等六项排版设置，并提供 6 款手机（含 2 款折叠屏内外屏）及 2 款 iPad 的机型预览，支持横竖屏、适合面板/100% 和自定义宽度。图片说明与表格字号均为 12–16px；新主题默认 12/13px，旧三版式保留图注约13px、表格16px，选择12px可明确调整。见 [排版说明](docs/typography.md)。
- ROCm 官方博客链接导入：提取正文、保留代码语言与表格、下载相对路径配图，并保留作者和来源链接，生成新的本地稿件。源码运行需安装 `requirements-rocm.txt`。
- Markdown、Markdown＋图片 ZIP、DOCX 和明确选择的 HTML 粘贴导入。先完成转换和素材核对，再生成新稿；保留私有原始上传副本及导入质量报告，记录图数、代码围栏、表格、来源与重复内容指纹。复杂 Word 合并单元格及公式需要作者核对。
- 原图与派生图分开保留；示意图默认无损 PNG，照片可选压缩，封面按比例与焦点裁切并提供构图安全区。GIF 提供不超过 300 帧的兼容预设，保留总时长与循环信息。网络图片需明确选择下载，并通过公网 HTTPS 地址及重定向检查。
- 同步至微信公众号草稿箱，支持复用草稿、任务阶段进度和已确认素材的增量恢复。微信后台手工改稿需明确选择；新增请求超时且结果不明时，不盲目重复新增。
- 导出 Markdown、素材和文章元数据组成的文章包；不包含账号凭据、Cookie 或密钥。
- 可选直接发布，默认关闭。
- Windows 公司直连模式：绑定物理网卡，检查固定出口；异常时停止微信请求，不自动切换代理。
- 历史文章的本地阅读、搜索和归档任务管理。

## 从源码启动

推荐使用 Windows、Python 3.12 和 Node.js 24。编辑器后端及本地阅读器所需的纯 Python Markdown 依赖已放在 `app/web/vendor/wheels/`，程序直接加载它们。HTML、Word 与图片核对需要 Beautiful Soup 和 Pillow：

```powershell
git clone https://github.com/hxhbluestar/wechat-markdown-publisher.git
cd wechat-markdown-publisher
python -m pip install beautifulsoup4==4.15.0 Pillow==12.3.0
npm ci --ignore-scripts
npm run build
New-Item -ItemType Directory -Force app/output/星河炸鸡_公众号全量归档 | Out-Null
python app/web/server.py
```

打开 <http://127.0.0.1:8899/editor/>。程序仅监听本机回环地址。公众号管理中配置自己的 AppID、AppSecret，并按微信要求设置实际公网出口白名单。

源码启动的稿件默认位于 `app/knowledge_base/drafts/`，账号配置位于 `app/knowledge_base/private/`；均被 Git 忽略。安装版使用用户的本地应用数据目录。

需要扫码归档功能时，再安装相关依赖，并准备 Chrome 或 Edge：

```powershell
python -m pip install -r requirements-archive.txt
```

网络与账号权限仍需由自己的公众号配置决定。公司直连说明见 [网络配置](docs/company-network.md)。

## 测试和构建

Node.js 24 用于构建可读应用入口和运行前端模块、DOM 回归；当前网页产物随源码提供。使用锁文件安装依赖后运行：

```powershell
python -m pip install beautifulsoup4==4.15.0 Pillow==12.3.0
python -X utf8 -m unittest discover -s tests -p "test_*.py" -v
npm ci --ignore-scripts
npm test
npm run build
```

测试使用合成文章、真实本地图片字节和模拟外部接口，不登录或写入真实微信。部署测试仅使用临时目录与模拟进程；缺少 PowerShell 时跳过。CI 在 Windows 上运行 Python、Node 和 DOM 回归，连续两次构建比较文件哈希，并核对提交的产物。

CI 的凭据扫描覆盖一方源码及敏感目录路径；合成测试夹具和固定第三方包不包含在此有限扫描中。npm registry 漏洞报告作为独立建议性产物保留；建议性步骤失败不能被解释为依赖已通过安全审查。这些检查不等同于 iOS、Android 的真实微信验收。

## 代码结构

| 目录 | 内容 |
| --- | --- |
| `app/web/` | Python 后端、阅读器与编辑器网页 |
| `app/modules/`、`app/main.py` | 浏览器登录和文章归档组件 |
| `frontend/` | 可读应用入口、保存恢复、校对、预检、写作与素材工具；固定底层运行时位于 `vendor/` |
| `tools/build-frontend.mjs` | 使用锁定版本的 esbuild 从可读入口构建 |
| `tools/build_frontend.py` | 兼容旧调用方式的构建入口 |
| `config/deployment-files.json` | 本轮安装版更新的逐文件白名单 |
| `tests/` | 排版、同步、路径安全、固定出口保护和隔离部署回归 |
| `scripts/`、`packaging/` | Windows 安装版生命周期与打包脚本 |

应用入口及新增行为由可读模块构建，不再依赖对压缩符号追加补丁。编辑器底层运行时和图表分块仍是固定第三方产物，来源见 `frontend/vendor/NOTICE.md`；这并不等于恢复了全部上游 TypeScript 源码或完整历史依赖 SBOM。

`packaging/` 是安装包组合脚本，需自行准备 `payload/app`、`payload/runtime`、`payload/scripts` 和版本信息；源码仓库不包含 Python 运行时，也不提供现成安装包。

## 已有安装版更新

先完成测试与构建，等待同步或归档任务结束并关闭编辑窗口。部署脚本只更新白名单内代码、静态资源和版本文件；稿件、图片、账号、Cookie、公司网络配置、运行时和启动脚本不在更新清单中。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/deploy-typography.ps1 `
  -SourceRoot 'C:\publisher\source' `
  -PackageRoot 'C:\publisher' `
  -InstallRoot "$env:LOCALAPPDATA\WechatMarkdownPublisher"
```

三个参数均指实际绝对目录。普通源码目录缺省使用脚本所在源码根及其父目录；包含 `.worktrees` 或 `worktrees` 的工作树必须显式提供 `PackageRoot`，避免推导到错误的 payload。脚本拒绝越界、重解析点、无关监听进程和活动连接；停止服务前逐文件备份并核对哈希。复制或启动失败时，先停止替换进程，再恢复旧文件及删除本次新建的白名单文件；备份清单保存在源码 `releases/`。

## 转换边界

- 本地导入上传上限 12 MiB；ZIP 最多 256 项，展开合计 64 MiB，正文最多 128 处图片引用；图片和派生结果各不超过 10 MiB。
- 图片处理另有限制单帧及累计解码像素、保留帧和处理时间的预算。时间检查位于读取、帧和编码边界，不能中断正在执行的原生编码调用。
- GIF 的 300 帧是兼容预设，不是本项目声明的现行微信统一限制。透明 GIF 使用二值透明度；降帧可能改变局部动画细节，原件保留。
- 当前不安装外部 SVG 转换器；发布前 SVG 图表需准备本地 PNG 派生图。复杂 Word 排版与公式不承诺逐像素还原。
- 浏览器机型预览用于检查宽度和布局；真实微信的公式、图注、长代码、宽表和深色模式仍需在设备端核对。

## 发布范围

此仓库是经过清理的公开代码版本：不含公众号凭据、Cookie、原始稿件、文章配图、公司实际网络地址、本机诊断记录或内部 Git 历史。文章排版覆盖数据保留空对象，可由使用者自行维护。

公开导出只复制纳入 Git 的应用、构建工具、依赖清单、测试与公开文档，并过滤常见私有目录和凭据文件。已有公开目录中历史遗留的文件不会自动删除，发布前仍需检查差异与残留文件。

项目自身尚未指定统一的开源许可证；公开可见不代表所有代码采用同一种授权。第三方组件的许可证和原有声明继续适用，见 [第三方说明](THIRD_PARTY_NOTICES.md)。
