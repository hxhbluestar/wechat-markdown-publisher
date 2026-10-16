# 本地运行依赖

`wheels/` 内为纯 Python 离线依赖，`server.py` 会直接从这些 wheel 加载：

- `markdown-it-py==4.0.0`
- `mdurl==0.1.2`

运行站点时不需要访问 PyPI 或其他网络服务。许可证及包元数据保留在 wheel 内。
