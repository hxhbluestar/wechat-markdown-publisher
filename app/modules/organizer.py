"""
wechat_archive - 目录规整与输出模块
按照标准化目录结构写入文章正文、元数据、附件、评论
生成全量文章索引 CSV 和归档说明
"""

import os
import json
import csv
import logging
from datetime import datetime

from .utils import (
    sanitize_filename,
    make_article_dirname,
    unique_filename,
    now_str,
)
from .article_list import ArticleInfo
from .article_parser import ParsedArticle, MediaAsset
from .comments import CommentItem, comments_to_markdown, comments_to_json

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 文章输出
# ---------------------------------------------------------------------------

def write_article(
    root_dir: str,
    article_info: ArticleInfo,
    parsed: ParsedArticle,
    comments: list[CommentItem] = None,
    download_images: bool = True,
    download_audio: bool = True,
    download_video: bool = True,
    download_comments: bool = True,
) -> str:
    """
    将一篇文章按标准化结构写入磁盘。

    目录结构:
        {root_dir}/{year}/{pub_date}_{title}/
            article.md           - 正文 Markdown
            metadata.json        - 元数据
            images/              - 图片
            audio/               - 音频
            video/               - 视频
            comments/
                comments.md      - 评论 Markdown
                comments.json    - 评论 JSON

    参数:
        root_dir: 归档根目录（如 AMD ROCm Lab_公众号全量归档/）
        article_info: 文章信息
        parsed: 解析后的文章内容
        comments: 评论列表（可选）
        download_*/: 各类型是否已下载

    返回:
        文章目录的绝对路径
    """
    year = article_info.pub_year or "unknown"
    dirname = make_article_dirname(article_info.pub_date, article_info.title)
    article_dir = os.path.join(root_dir, year, dirname)
    os.makedirs(article_dir, exist_ok=True)

    # ---- 1. 正文 Markdown ----
    md_path = os.path.join(article_dir, "article.md")
    md_content = _build_article_markdown(article_info, parsed)
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(md_content)
    logger.debug(f"写入: {md_path}")

    # ---- 2. 元数据 JSON ----
    meta_path = os.path.join(article_dir, "metadata.json")
    meta = _build_metadata(article_info, parsed)
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    logger.debug(f"写入: {meta_path}")

    # ---- 3. 媒体目录（已在 media_downloader 中创建，此处确保目录存在）----
    if download_images and parsed.images:
        os.makedirs(os.path.join(article_dir, "images"), exist_ok=True)
    if download_audio and parsed.audio:
        os.makedirs(os.path.join(article_dir, "audio"), exist_ok=True)
    if download_video and parsed.video:
        os.makedirs(os.path.join(article_dir, "video"), exist_ok=True)

    # ---- 4. 评论 ----
    if download_comments and comments is not None:
        comments_dir = os.path.join(article_dir, "comments")
        os.makedirs(comments_dir, exist_ok=True)

        # Markdown
        md_comments = comments_to_markdown(comments, title=article_info.title)
        cm_path = os.path.join(comments_dir, "comments.md")
        with open(cm_path, "w", encoding="utf-8") as f:
            f.write(md_comments)

        # JSON
        cj_path = os.path.join(comments_dir, "comments.json")
        with open(cj_path, "w", encoding="utf-8") as f:
            f.write(comments_to_json(comments))

        logger.debug(f"写入评论: {cm_path}")

    return article_dir


def _build_article_markdown(info: ArticleInfo, parsed: ParsedArticle) -> str:
    """组装完整的文章 Markdown"""
    lines = []

    # 标题
    lines.append(f"# {info.title}")
    lines.append("")

    # 元信息头部
    lines.append("> 本文由公众号归档工具自动导出")
    lines.append(">")
    lines.append(f"> **发布时间**: {info.pub_date}")
    if info.digest:
        lines.append(f"> **摘要**: {info.digest}")
    if info.read_count is not None:
        lines.append(f"> **阅读量**: {info.read_count}")
    if info.like_count is not None:
        lines.append(f"> **在看**: {info.like_count}")
    if info.readlike_count is not None:
        lines.append(f"> **点赞**: {info.readlike_count}")
    lines.append(f"> **原文链接**: {info.url}")
    lines.append("")
    lines.append("---")
    lines.append("")

    # 正文
    if parsed.body_markdown:
        lines.append(parsed.body_markdown)
    else:
        lines.append("_（正文内容在归档时未解析到）_")

    lines.append("")
    lines.append("---")
    lines.append("")

    # 资源清单
    media_lines = []
    if parsed.images:
        media_lines.append(f"- 图片 {len(parsed.images)} 张：位于 `images/` 目录")
    if parsed.audio:
        media_lines.append(f"- 音频 {len(parsed.audio)} 个：位于 `audio/` 目录")
    if parsed.video:
        media_lines.append(f"- 视频 {len(parsed.video)} 个：位于 `video/` 目录")
    if media_lines:
        lines.append("### 附件资源")
        lines.extend(media_lines)
        lines.append("")

    # 页脚
    lines.append(
        f"_归档时间: {now_str()} | 编号: {info.msg_id}_"
    )

    return "\n".join(lines)


def _build_metadata(info: ArticleInfo, parsed: ParsedArticle) -> dict:
    """构建元数据 JSON"""
    return {
        "title": info.title,
        "url": info.url,
        "msg_id": info.msg_id,
        "aid": info.aid,
        "digest": info.digest,
        "pub_date": info.pub_date,
        "pub_year": info.pub_year,
        "cover": info.cover,
        "read_count": info.read_count,
        "like_count": info.like_count,
        "readlike_count": info.readlike_count,
        "author": info.title,  # placeholder
        "media_summary": {
            "images": len(parsed.images),
            "audio": len(parsed.audio),
            "video": len(parsed.video),
        },
        "archive_time": now_str(),
    }


# ---------------------------------------------------------------------------
# 全量文章索引 CSV
# ---------------------------------------------------------------------------

def write_index_csv(root_dir: str, articles: list[ArticleInfo]) -> str:
    """
    生成全量文章索引 CSV。

    返回:
        CSV 文件路径
    """
    csv_path = os.path.join(root_dir, "全量文章索引表.csv")
    fieldnames = [
        "标题",
        "发布日期",
        "年份",
        "原文链接",
        "摘要",
        "分类",
        "阅读量",
        "在看数",
        "点赞数",
    ]

    with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for article in articles:
            writer.writerow({
                "标题": article.title,
                "发布日期": article.pub_date,
                "年份": article.pub_year,
                "原文链接": article.url,
                "摘要": article.digest,
                "分类": "",
                "阅读量": article.read_count or "",
                "在看数": article.like_count or "",
                "点赞数": article.readlike_count or "",
            })

    logger.info(f"索引表已生成: {csv_path}")
    return csv_path


# ---------------------------------------------------------------------------
# 归档说明文档
# ---------------------------------------------------------------------------

def write_archive_readme(
    root_dir: str,
    account_name: str,
    total_articles: int,
    start_date: str,
    end_date: str,
    export_options: dict,
    articles: list[ArticleInfo] = None,
) -> str:
    """
    创建归档说明文档。

    返回:
        文档路径
    """
    readme_path = os.path.join(root_dir, "归档说明.md")
    now = now_str()

    # 统计年份分布
    year_dist = {}
    if articles:
        for a in articles:
            y = a.pub_year
            year_dist[y] = year_dist.get(y, 0) + 1
    year_lines = "\n".join(
        f"  - {y} 年：{c} 篇" for y, c in sorted(year_dist.items())
    )

    date_range = f"{start_date} 至 {end_date}" if start_date and end_date else "全量历史"

    content = f"""# 公众号归档说明

## 基本信息

- **公众号名称**: {account_name}
- **归档时间**: {now}
- **文章总数**: {total_articles} 篇
- **数据范围**: {date_range}
- **导出工具**: AMD ROCm Lab公众号归档工具 v1.0

## 目录结构

```
{account_name}_公众号全量归档/
├── 归档说明.md               # 本文件
├── 全量文章索引表.csv          # 所有文章清单
├── YYYY/                      # 按年份分层
│   ├── YYYY-MM-DD_文章标题/    # 单篇文章目录
│   │   ├── article.md         # 正文 Markdown
│   │   ├── metadata.json      # 元数据
│   │   ├── images/            # 文章内图片
│   │   ├── audio/             # 文章内音频
│   │   ├── video/             # 文章内视频
│   │   └── comments/          # 评论区
│   │       ├── comments.md
│   │       └── comments.json
│   └── ...
└── ...
```

## 导出选项

| 选项 | 状态 |
|------|------|
| 正文格式 | Markdown |
| 图片下载 | {'✅ 已启用' if export_options.get('download_images') else '❌ 未启用'} |
| 音频下载 | {'✅ 已启用' if export_options.get('download_audio') else '❌ 未启用'} |
| 视频下载 | {'✅ 已启用' if export_options.get('download_video') else '❌ 未启用'} |
| 评论采集 | {'✅ 已启用' if export_options.get('download_comments') else '❌ 未启用'} |

## 年度分布

{year_lines if year_lines else '（无数据）'}

## 使用说明

1. **离线查看**: 所有资源已下载到本地，无需网络即可完整查看
2. **Markdown 正文**: 使用任意 Markdown 编辑器打开 `article.md`
3. **图片/音视频**: 在对应子目录中，文章 Markdown 已使用相对路径引用
4. **评论**: 在 `comments/comments.md` 中按楼层排列
5. **搜索**: 可使用系统搜索工具在 `article.md` 和 `comments.md` 中全文检索

## 后续维护

- **增量更新**: 后续可按月/季度运行工具，会自动跳过已归档文章
- **备份建议**: 建议在本机 + NAS/云盘各存放一份
- **恢复**: 将整个目录复制到任意位置即可恢复

## 免责声明

本归档仅供个人备份与参考使用，请勿将内容用于商业用途或公开发布。
"""

    with open(readme_path, "w", encoding="utf-8") as f:
        f.write(content)

    logger.info(f"归档说明已生成: {readme_path}")
    return readme_path
