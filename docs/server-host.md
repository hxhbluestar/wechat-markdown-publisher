# Windows 内网发布服务器

服务器版在现有本机后端外增加 Caddy HTTPS 和 Basic Authentication。后端仍只监听 `127.0.0.1`，网页、稿件、图片和 API 全部经过登录；保留原 CSRF 校验。入口在改写后端 Host/Origin 之前拒绝外部 Origin 和跨站写请求，允许从其他网页正常点击进入编辑器的顶层 GET 导航。

部署目录包含 `app/`、官方 Python 运行时 `runtime/`、`gateway/caddy.exe`、`gateway/Caddyfile`、`scripts/` 和独立的 `data/`。使用官方 Caddy Windows amd64 包，安装前按该版本官方 checksums 文件声明的 SHA512 校验，保留其许可证。

## 私有配置

`data/private/server-host.json` 的字段为 `listen_ip`、`https_port`、`backend_port`、`login_user`、`password_hash`。端口不能相同；后端端口不创建入站规则。`password_hash` 使用 `caddy hash-password` 的输出，不保存明文网页登录密码。`server.crt` 和 `server.key` 分别是入口证书与私钥，证书 SAN 必须包含实际访问 IP，启用 serverAuth，用于该服务器的自签名证书不得具备 CA 签发权限。

整个部署目录应只授权 SYSTEM 和本机管理员；公众号账号配置另存为 `data/private/wechat-accounts.json`。安装时不迁移浏览器 Cookie、运行中任务或旧 PID。脚本生成密码哈希时，向 Caddy 标准输入写入原始 UTF-8 字节和一个 LF；不要经过 Windows 文本模式自动转换成 CRLF，以免把回车算入密码。

将 `packaging/server/Caddyfile` 放至服务器 `gateway/Caddyfile`，将两个 `*-server-host.ps1` 脚本放至 `scripts/`。在服务器管理员 PowerShell 执行：

```powershell
& 'D:\Publisher\scripts\install-server-host.ps1' -Root 'D:\Publisher'
```

安装器遇到同名任务或端口占用时拒绝覆盖。两个 SYSTEM 计划任务在开机时启动，失败后按一分钟间隔重试，不依赖用户登录。HTTPS 防火墙规则默认仅允许 LocalSubnet，也可通过 `-RemoteScope` 指定更窄的客户机 IP 范围。

首次使用的客户机需要信任该服务器证书。核对证书 SHA256 和访问 IP 后，将仅供此服务器使用的非 CA 证书导入当前用户的受信任根证书存储。其他电脑也需执行对应信任步骤，不能以关闭 TLS 校验代替。网页登录账号与 Windows 管理员账号分离。

客户端安装目录的 `data/private/server-target.json` 可配置 `{"url":"https://server.example.test:8899/editor/"}`。已有桌面快捷方式会打开该服务器，不再启动本机副本。配置只接受不含账号密码、查询参数或片段的 HTTPS 地址；配置损坏时明确报错，避免静默退回本机造成稿件分叉。未配置的普通安装继续使用本机编辑器。

## 验收与维护

检查未登录访问返回 401，正确登录可以打开编辑器及素材；错误密码不能访问；外站 Origin/跨站 POST 返回 403，缺失编辑器 Token 的写请求被后端拒绝。用可恢复的合成稿件检查创建、保存、恢复和删除，再确认原有稿件及素材哈希没有变化。微信接口出口及白名单必须从服务器实测。

整页验收必须包含并发资源加载：HTTPS/HTTP2 会同时向后端建立多个连接，Python 旧版本默认的 5 个待接入连接会在 Windows 上导致部分 CSS/JS 返回 502。后端使用 128 个待接入连接的队列；回归测试以 32 个独立连接分三轮检查资源状态和完整字节。服务器上线后，还应在 Chrome 中检查所有样式表都已解析、桌面版视图切换已隐藏、排版设置和同步弹窗显示正常，不能只逐个访问静态文件。

更新前备份代码、版本和私有数据，停止两个任务，核对所属进程后停止相关 Python/Caddy 进程，更新经过测试的代码，再启动任务并重新验收。保留服务器 `data/`、运行时、TLS 私钥和网关配置；本机版 `deploy-typography.ps1` 的 8899 进程识别规则不适用于服务器网关，不应直接用于该目录。

参考：[Caddy Basic Authentication](https://caddyserver.com/docs/caddyfile/directives/basic_auth)、[反向代理](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)。
