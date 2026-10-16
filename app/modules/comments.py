"""
wechat_archive - 评论区抓取模块
通过公众号文章页面的评论 API 抓取公开精选评论
保留楼层结构，包含回复链
"""

import json
import re
import logging
import time
from typing import Optional
from datetime import datetime

import requests
from bs4 import BeautifulSoup

from .utils import RateLimiter

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 数据结构
# ---------------------------------------------------------------------------

class CommentItem:
    """单条评论"""

    def __init__(self, data: dict):
        self.comment_id: str = str(data.get("id", ""))
        self.nickname: str = data.get("nick_name", "匿名用户")
        self.content: str = data.get("content", "").strip()
        self.create_time: int = data.get("create_time", 0)
        self.like_count: int = data.get("like_num", 0)
        self.is_top: bool = data.get("is_top", False)
        self.floor: int = 0

        dt = datetime.fromtimestamp(self.create_time) if self.create_time else None
        self.time_str: str = dt.strftime("%Y-%m-%d %H:%M") if dt else ""

        # 回复列表
        self.replies: list["CommentItem"] = []

    def add_reply(self, reply: "CommentItem"):
        self.replies.append(reply)

    def markdown(self, floor: int = 1) -> str:
        """生成 Markdown 格式的评论"""
        lines = []
        prefix = "⭐" if self.is_top else ""
        lines.append(f"### {prefix} #{floor} {self.nickname}")
        lines.append(f"> {self.content}")
        meta = f"> _时间: {self.time_str}  |  赞: {self.like_count}_"
        lines.append(meta)
        lines.append("")

        # 回复
        if self.replies:
            for i, reply in enumerate(self.replies):
                lines.append(f"> 💬 **{reply.nickname}** 回复:")
                lines.append(f"> {reply.content}")
                lines.append(f"> _时间: {reply.time_str}_")
                lines.append("")

        lines.append("---")
        lines.append("")
        return "\n".join(lines)

    def to_dict(self) -> dict:
        return {
            "id": self.comment_id,
            "nickname": self.nickname,
            "content": self.content,
            "time": self.time_str,
            "like_count": self.like_count,
            "is_top": self.is_top,
            "replies": [r.to_dict() for r in self.replies],
        }


# ---------------------------------------------------------------------------
# 从文章 HTML 提取评论 API 参数
# ---------------------------------------------------------------------------

def _extract_comment_params(html: str) -> dict:
    """从文章页面 HTML 中提取评论 API 所需的参数"""
    params = {}

    # 1) 提取 __appid, __data_token 等
    soup = BeautifulSoup(html, "lxml")
    for script in soup.find_all("script"):
        text = script.string or ""

        # 提取 token
        m = re.search(r'var\s+data_token\s*=\s*["\']([^"\']+)["\']', text)
        if m:
            params["token"] = m.group(1)

        # 提取 appid
        m = re.search(r'var\s+appid\s*=\s*["\']([^"\']+)["\']', text)
        if m:
            params["appid"] = m.group(1)

        # 提取 fakeid/uin
        m = re.search(r'var\s+fakeid\s*=\s*["\']([^"\']+)["\']', text)
        if m:
            params["fakeid"] = m.group(1)

    # 2) 从 meta 标签提取 __appid
    meta = soup.find("meta", attrs={"name": "__appid"})
    if meta:
        params["appid"] = meta.get("content", "")

    return params


def _extect_comment_biz(html: str) -> str:
    """从页面提取 biz 参数"""
    # 从链接中提取 biz 参数
    m = re.search(r'biz=([a-zA-Z0-9\-_]+)', html)
    if m:
        return m.group(1)
    # 从 meta content 中提取
    m = re.search(r'__biz\s*=\s*["\']([^"\']+)["\']', html)
    if m:
        return m.group(1)
    return ""


# ---------------------------------------------------------------------------
# 抓取评论
# ---------------------------------------------------------------------------

def fetch_comments(
    article_url: str,
    article_html: str,
    max_comments: int = 100,
    include_replies: bool = True,
    rate_limiter: Optional[RateLimiter] = None,
) -> list[CommentItem]:
    """
    抓取一篇文章的精选评论。

    参数:
        article_url: 文章 URL
        article_html: 文章页面 HTML（用于提取参数）
        max_comments: 最大评论抓取数
        include_replies: 是否包含回复
        rate_limiter: 速率限制器

    返回:
        CommentItem 列表（按楼层排序）
    """
    if rate_limiter is None:
        rate_limiter = RateLimiter(min_interval=1.0, max_interval=2.0)

    biz = _extect_comment_biz(article_html)
    if not biz:
        logger.warning("无法提取 biz 参数，跳过评论抓取")
        return []

    # 评论 API 地址
    # 微信文章的精选评论通过 __t 时间戳分离
    params = _extract_comment_params(article_html)
    if not params.get("token"):
        logger.warning("无法提取 data_token，跳过评论抓取")
        return []

    comment_url = (
        f"https://mp.weixin.qq.com/mp/comment/list?"
        f"biz={biz}&"
        f"token={params.get('token', '')}&"
        f"appid={params.get('appid', 'wx_profile')}&"
        f"is_video_comment=0&"
        f"count={min(max_comments, 100)}&"
        f"action=list&"
        f"_={int(time.time() * 1000)}"
    )

    # 从文章 URL 提取 comment_id 或 appmsgid
    # 常见格式: https://mp.weixin.qq.com/s/xxx
    # 或 mp.weixin.qq.com/cgi-bin/appmsg?action=view&...
    path_match = re.search(r"/s/([a-zA-Z0-9_-]+)", article_url)
    if path_match:
        # __biz 参数在 URL 中
        pass  # biz 已经在上面提取了
    else:
        # 尝试从 HTML 中的 __msgid 提取
        msgid_match = re.search(r'var\s+msgid\s*=\s*["\']?(\d+)["\']?', article_html)
        if msgid_match:
            msgid = msgid_match.group(1)
            comment_url += f"&appmsgid={msgid}"

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Referer": article_url,
        "Accept": "application/json, text/plain, */*",
    }

    # 设置 Cookie: 需要 pass_ticket 等
    # 如果 cookie 有 pass_ticket 则带上

    comments: list[CommentItem] = []
    page = 0

    while page < 10:  # 最多翻 10 页
        rate_limiter.wait()
        page_url = f"{comment_url}&page={page}"

        try:
            resp = requests.get(page_url, headers=headers, timeout=15)
            resp.encoding = "utf-8"
            data = resp.json()

            if data.get("ret") != 0:
                logger.warning(f"评论 API 返回错误 (page={page}): {data.get('errmsg', '')}")
                break

            comment_list = data.get("comment", {}).get("comment_list", [])
            if not comment_list:
                break

            for item_data in comment_list:
                comment = CommentItem(item_data)
                comment.floor = len(comments) + 1

                # 回复
                if include_replies:
                    reply_list = item_data.get("reply", {}).get("reply_list", [])
                    for reply_data in reply_list:
                        reply = CommentItem(reply_data)
                        comment.add_reply(reply)

                comments.append(comment)

            # 检查是否还有更多
            total_count = data.get("comment", {}).get("total_count", 0)
            if len(comments) >= total_count or len(comments) >= max_comments:
                break

            page += 1

        except requests.RequestException as e:
            logger.warning(f"评论接口请求失败 (page={page}): {e}")
            break
        except json.JSONDecodeError as e:
            logger.warning(f"评论接口响应非 JSON: {e}")
            break
        except Exception as e:
            logger.warning(f"评论解析异常: {e}")
            break

    logger.info(f"文章评论: 获取 {len(comments)} 条精选评论")
    return comments


# ---------------------------------------------------------------------------
# 评论导出为 Markdown
# ---------------------------------------------------------------------------

def comments_to_markdown(comments: list[CommentItem], title: str = "") -> str:
    """将评论列表导出为 Markdown 格式"""
    lines = []

    lines.append("---")
    lines.append("")
    lines.append(f"## 💬 评论区")
    lines.append("")
    if title:
        lines.append(f"文章标题: {title}")
        lines.append("")

    if not comments:
        lines.append("_暂无公开精选评论_")
        lines.append("")
        return "\n".join(lines)

    lines.append(f"共 {len(comments)} 条精选评论\n")

    for i, comment in enumerate(comments):
        lines.append(comment.markdown(floor=i + 1))

    return "\n".join(lines)


def comments_to_json(comments: list[CommentItem]) -> str:
    """将评论列表导出为 JSON"""
    return json.dumps(
        [c.to_dict() for c in comments],
        ensure_ascii=False,
        indent=2,
    )
