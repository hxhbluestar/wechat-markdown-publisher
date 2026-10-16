微信 Markdown 发布器 · Windows 服务器安装包
================================================

适用方式
--------
本安装包用于通过远程桌面登录 Windows 服务器，并在服务器本机浏览器使用。
服务只监听 127.0.0.1:8899，不要将 8899 端口开放到局域网或公网。

一键安装
--------
1. 将整个 ZIP 文件复制到 Windows 服务器本地磁盘。
2. 完整解压 ZIP；不要直接在压缩包内运行。
3. 双击 INSTALL-WINDOWS.cmd。
4. 安装完成后浏览器会打开：
   http://127.0.0.1:8899/editor/
5. 点击左侧“绑定微信公众号”，绑定公司使用的第二个公众号。

一键归档公众号
--------------
1. 点击左侧“一键归档公众号”。
2. 输入用于本地文件夹的公众号名称，保持“每次重新扫码”和
   “完成后清除登录信息”开启。
3. 点击“打开浏览器并开始归档”，用目标公众号管理员微信扫码。
4. 等待页面显示完成，然后点击“打开文件夹”。

归档会优先启动 Chrome；Chrome 不可用时自动使用 Windows 自带的 Microsoft Edge。
切换朋友的公众号时必须重新扫码；
Cookie 只保存在当前 Windows 用户的 data\private 目录，默认任务结束后自动清除。

公众号配置
----------
1. 在第二个公众号的开发者平台获取该账号自己的 AppID 和 AppSecret。
2. 将 Windows 服务器的公网出口 IPv4 加入第二个公众号接口 IP 白名单。
3. 如果绑定返回 40164，把报错中显示的 IPv4 加入白名单后重试。
4. 导入一篇测试 Markdown、设置封面、选择第二个公众号，再同步到草稿箱。

安装位置与数据
--------------
程序：%LOCALAPPDATA%\WechatMarkdownPublisher
稿件：%LOCALAPPDATA%\WechatMarkdownPublisher\data\drafts
账号：%LOCALAPPDATA%\WechatMarkdownPublisher\data\private\wechat-accounts.json
日志：%LOCALAPPDATA%\WechatMarkdownPublisher\data\logs

安装包不包含制作电脑上的公众号 AppSecret、账号配置或本地稿件。
重新运行安装程序会升级程序，但不会覆盖 data 目录。

日常使用
--------
桌面双击“WeChat Markdown Publisher”即可打开。
安装程序同时创建当前 Windows 用户的登录自启动项。
远程桌面断开不会影响运行；Windows 用户注销或服务器重启后，需要再次登录。

本地稿件列表右侧的“×”用于删除重复稿件。删除前会显示二次确认；只会删除
当前 Windows 机器上的 Markdown、封面和本地图片，不会删除公众号草稿箱内容。

公司安全要求
------------
- 只允许服务器向外访问 https://api.weixin.qq.com:443。
- 不需要、也不应创建 8899 端口的入站防火墙规则。
- data\private 只应允许安装本程序的 Windows 用户访问。
- 不要把安装后的 data\private 目录放进共享盘或普通备份。
- 如需备份账号文件，备份介质必须加密。
- 如需从其他公司电脑通过局域网访问，当前安装包不适用；必须另行增加
  HTTPS、Windows 身份认证、可信代理和访问权限控制。

故障排查
--------
浏览器打不开时，查看：
%LOCALAPPDATA%\WechatMarkdownPublisher\data\logs\server.err.log

绑定报 40164：Windows 服务器出口 IP 未加入公众号白名单。
绑定报 40125：AppSecret 不正确或已经被重置。
同步报 48001：该公众号或账号类型没有对应接口权限。

卸载
----
开始菜单 → WeChat Markdown Publisher → Uninstall。
卸载默认保留 data 目录，防止误删稿件和账号；确认不再需要后可手动删除。
