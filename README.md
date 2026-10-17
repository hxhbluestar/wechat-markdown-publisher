# 微信 Markdown 发布器

在本机编辑 Markdown、管理图片与封面，并通过微信公众号官方接口同步到草稿箱。附带本地文章归档阅读器和公众号归档工具，保留现有“星河炸鸡”应用界面。

## 功能

- Markdown 编辑、预览、本地保存和多个公众号账号管理。
- 本地离线错别字校对：正文波浪线高亮、定位、逐项/批量修改、忽略词、撤销及修改保存；同步前提醒核对常见易错词。代码、链接目标和路径自动跳过，文章不上传校对服务。见 [校对说明](docs/proofreading.md)。
- 离线 AI/GPU 代码高亮：Python/PyTorch、C++、TileLang、Triton、HIP/CUDA、PowerShell、Bash 及 Dockerfile/CMake/LLVM；等宽代码框、分层配色和公众号行内颜色导出。
- AMD 技术蓝、极简墨色、纸感期刊、曜石青四套常用文章版式；相近旧模板随已保存稿件兼容加载。支持正文、图片说明、表格字号等六项排版设置，并提供 6 款手机（含 2 款折叠屏内外屏）及 2 款 iPad 的机型预览，支持横竖屏、适合面板/100% 和自定义宽度。图片说明与表格字号均为 12–16px；新主题默认 12/13px，旧三版式保留图注约13px、表格16px，选择12px可明确调整。见 [排版说明](docs/typography.md)。
- ROCm 官方博客链接导入：提取正文、保留代码语言与表格、下载相对路径配图，并保留作者和来源链接，生成新的本地稿件。源码运行需安装 `requirements-rocm.txt`。
- 本地图片上传、封面选择、同步前缺图检查，兼容导入文档的相对图片目录。
- 同步至微信公众号草稿箱，支持复用已同步草稿。
- 可选直接发布，默认关闭。
- Windows 公司直连模式：绑定物理网卡，检查固定出口；异常时停止微信请求，不自动切换代理。
- 历史文章的本地阅读、搜索和归档任务管理。

## 从源码启动

推荐使用 Windows 和 Python 3.12。编辑器后端及本地阅读器所需的纯 Python Markdown 依赖已放在 `app/web/vendor/wheels/`，程序直接加载它们。

```powershell
git clone https://github.com/hxhbluestar/wechat-markdown-publisher.git
cd wechat-markdown-publisher
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

Node.js 用于运行前端模块与 DOM 回归测试；当前网页资源已经随源码提供。使用锁文件安装测试依赖后运行：

```powershell
python -m pip install -r requirements-rocm.txt
python -m unittest discover -s tests -p "test_*.py" -v
npm ci
npm test
python tools/build_frontend.py
node --check app/web/editor/assets/index-20261017-proof.js
node --check app/web/editor/assets/typography-20261017-proof.mjs
node --check app/web/editor/assets/typography-controls-20261017-proof.mjs
node --check app/web/editor/assets/company-network-20261016.mjs
```

测试覆盖后端元数据、同步校验、图片路径、编辑器安全、前端排版与控件，不调用真实微信接口。部署脚本测试仅使用临时目录和模拟进程；在没有 PowerShell 的平台跳过这些 Windows 部署测试。构建会同时生成 `typography-controls-20261017-proof.css`。

## 代码结构

| 目录 | 内容 |
| --- | --- |
| `app/web/` | Python 后端、阅读器与编辑器网页 |
| `app/modules/`、`app/main.py` | 浏览器登录和文章归档组件 |
| `frontend/` | 可读的排版、控件、图片路径、网络状态模块与页面模板 |
| `tools/build_frontend.py` | 从保存的前端产物生成可重现补丁 |
| `tests/` | 排版、同步、路径安全、固定出口保护和隔离部署回归 |
| `scripts/`、`packaging/` | Windows 安装版生命周期与打包脚本 |

目前保留了编辑器已编译的前端资源和严格匹配的补丁构建工具；尚未恢复完整的上游 TypeScript 工程。因此不能将本仓库视为可从 TypeScript 重建所有前端依赖的完整工程。

`packaging/` 是安装包组合脚本，需自行准备 `payload/app`、`payload/runtime`、`payload/scripts` 和版本信息；源码仓库不包含 Python 运行时，也不提供现成安装包。

## 发布范围

此仓库是经过清理的公开代码版本：不含公众号凭据、Cookie、原始稿件、文章配图、公司实际网络地址、本机诊断记录或内部 Git 历史。文章排版覆盖数据保留空对象，可由使用者自行维护。

项目自身尚未指定统一的开源许可证；公开可见不代表所有代码采用同一种授权。第三方组件的许可证和原有声明继续适用，见 [第三方说明](THIRD_PARTY_NOTICES.md)。
