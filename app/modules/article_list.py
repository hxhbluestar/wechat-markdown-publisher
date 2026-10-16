"""
wechat_archive - 文章列表抓取模块
通过公众号后台 API (cgi-bin/appmsg) 分批获取全量历史文章列表
支持断点续传、反爬限速
"""

import json
import time
import logging
from typing import Optional
from datetime import datetime

import requests
from tqdm import tqdm

from .utils import RateLimiter, now_str

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------
APPMSG_LIST_URL = (
    "https://mp.weixin.qq.com/cgi-bin/appmsg?"
    "token={token}&lang=zh_CN&f=json&action=list_ex&"
    "begin={page}&count=5&query=&fakeid={fakeid}&type=9"
)


# ---------------------------------------------------------------------------
# 数据结构
# ---------------------------------------------------------------------------

class ArticleInfo:
    """单篇文章的基本信息"""

    def __init__(self, data: dict):
        self.title: str = data.get("title", "").strip()
        self.url: str = data.get("link", "")
        self.msg_id: str = str(data.get("msgid", ""))
        self.aid: str = str(data.get("aid", ""))
        self.digest: str = data.get("digest", "")
        self.create_time: int = data.get("create_time", 0)
        self.update_time: int = data.get("update_time", 0)

        # 格式化日期
        dt = datetime.fromtimestamp(self.create_time) if self.create_time else None
        self.pub_date: str = dt.strftime("%Y-%m-%d %H:%M:%S") if dt else "unknown"
        self.pub_year: str = dt.strftime("%Y") if dt else "unknown"

        # 封面图
        self.cover: str = data.get("cover", "")

        # 阅读数据（从列表接口不一定有，后续逐个查询补充）
        self.read_count: Optional[int] = None        # 阅读量
        self.like_count: Optional[int] = None         # 在看
        self.readlike_count: Optional[int] = None     # 点赞

    def __repr__(self):
        return f"<Article: {self.pub_date[:10]} {self.title[:30]}>"

    def to_dict(self) -> dict:
        return {
            "title": self.title,
            "url": self.url,
            "msg_id": self.msg_id,
            "aid": self.aid,
            "digest": self.digest,
            "pub_date": self.pub_date,
            "pub_year": self.pub_year,
            "cover": self.cover,
            "read_count": self.read_count or "",
            "like_count": self.like_count or "",
            "readlike_count": self.readlike_count or "",
        }


# ---------------------------------------------------------------------------
# 获取文章列表
# ---------------------------------------------------------------------------

def fetch_article_list(
    cookies: dict,
    token: str,
    fakeid: str,
    rate_limiter: RateLimiter = None,
    date_from: str = "",
    date_to: str = "",
    on_progress=None,
) -> list[ArticleInfo]:
    """
    从公众号后台翻页获取所有历史文章列表。

    参数:
        cookies: Cookie 字典
        token: 公众号 token
        fakeid: 公众号 fakeid
        rate_limiter: 速率限制器
        date_from/date_to: 日期范围过滤（空字符串不限）
        on_progress: 进度回调函数(count, total)

    返回:
        ArticleInfo 列表（按发布时间从新到旧）
    """
    if rate_limiter is None:
        rate_limiter = RateLimiter()

    session = requests.Session()
    session.cookies.update(cookies)

    all_articles: list[ArticleInfo] = []
    page = 0
    total_count = 0
    retry_count = 0
    max_retries = 3

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Referer": "https://mp.weixin.qq.com/cgi-bin/home",
        "X-Requested-With": "XMLHttpRequest",
    }

    print("[列表] 开始抓取文章列表…")

    while True:
        url = APPMSG_LIST_URL.format(token=token, page=page, fakeid=fakeid)

        try:
            rate_limiter.wait()
            resp = session.get(url, headers=headers, timeout=30)
            data = resp.json()

            if data.get("base_resp", {}).get("ret") != 0:
                err_msg = data.get("base_resp", {}).get("err_msg", "unknown")
                logger.warning(f"API 返回错误 (page={page}): {err_msg}")
                retry_count += 1
                if retry_count > max_retries:
                    print(f"[列表] 连续 {max_retries} 次失败，停止翻页")
                    break
                time.sleep(5)
                continue

            retry_count = 0  # 重置重试计数

            # 第一页获取总数
            if page == 0:
                total_count = data.get("total", 0)
                if not total_count:
                    total_count = 999999  # API 可能返回 0，用大数兜底
                print(f"[列表] 公众号共有 {total_count if total_count < 999999 else '?'} 篇文章")
                if on_progress:
                    on_progress(0, total_count if total_count < 999999 else 1)

            article_list = data.get("app_msg_list", [])
            if not article_list:
                print(f"[列表] 第 {page//5} 页起无更多文章，停止翻页")
                break

            # 解析每篇文章
            for item in article_list:
                article = ArticleInfo(item)

                # 日期范围过滤
                if date_from and article.pub_date < date_from:
                    continue
                if date_to and article.pub_date > date_to:
                    continue

                all_articles.append(article)

            page += 5

            # 进度
            if on_progress:
                on_progress(len(all_articles), total_count)

            # 如果已经抓取超过总数，停止
            if total_count > 0 and len(all_articles) >= total_count:
                break

            # 每 20 页额外休息
            if page % 100 == 0:
                rate_limiter.batch_wait(page, threshold=100, extra_sleep=5.0)

        except requests.RequestException as e:
            logger.error(f"网络请求失败 (page={page}): {e}")
            retry_count += 1
            if retry_count > max_retries:
                print(f"[列表] 连续 {max_retries} 次网络失败，终止")
                break
            time.sleep(10)

        except json.JSONDecodeError as e:
            logger.error(f"JSON 解析失败 (page={page}): {e}")
            retry_count += 1
            if retry_count > max_retries:
                break
            time.sleep(5)

    print(f"[列表] 抓取完成，共获取 {len(all_articles)} 篇文章")
    return all_articles


# ---------------------------------------------------------------------------
# 获取单篇文章的阅读数据
# ---------------------------------------------------------------------------

def fetch_article_stats(
    cookies: dict, token: str, article: ArticleInfo
) -> dict:
    """
    获取单篇文章的阅读量、在看数、点赞数（公众号后台 API）。
    返回原始 JSON。
    """
    url = (
        f"https://mp.weixin.qq.com/cgi-bin/appmsg?action=view&"
        f"token={token}&lang=zh_CN&f=json&"
        f"appmsgid={article.aid}"
    )
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Referer": "https://mp.weixin.qq.com/",
    }
    try:
        resp = requests.get(url, cookies=cookies, headers=headers, timeout=15)
        data = resp.json()
        if data.get("base_resp", {}).get("ret") == 0:
            appmsg = data.get("appmsg", {})
            article.read_count = appmsg.get("read_count")
            article.like_count = appmsg.get("like_num")  # 在看
            article.readlike_count = appmsg.get("read_like_num")  # 点赞
        return data
    except Exception as e:
        logger.warning(f"获取阅读数据失败 {article.title[:20]}: {e}")
        return {}
