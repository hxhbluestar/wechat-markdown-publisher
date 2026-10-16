"""
wechat_archive - 公用工具模块
提供文件名清洗、时间格式化、速率控制等通用函数
"""

import os
import re
import json
import time
import random
import hashlib
from pathlib import Path
from datetime import datetime
from typing import Optional


# ---------------------------------------------------------------------------
# 文件名与路径工具
# ---------------------------------------------------------------------------

def sanitize_filename(name: str, max_length: int = 100, replace_char: str = "_") -> str:
    """去除文件名中的非法字符，控制最大长度"""
    # Windows 非法字符: \ / : * ? " < > |
    sanitized = re.sub(r'[\\/:*?"<>|]', replace_char, name)
    # 不可见控制字符
    sanitized = re.sub(r'[\x00-\x1f\x7f]', "", sanitized)
    # 前导/末尾空格和点
    sanitized = sanitized.strip(". \t")
    if not sanitized:
        sanitized = "untitled"
    if len(sanitized) > max_length:
        base, ext = os.path.splitext(sanitized)
        sanitized = base[: max_length - len(ext) - 3] + "..." + ext
    return sanitized


def make_article_dirname(pub_date: str, title: str) -> str:
    """生成标准文章目录名: YYYY-MM-DD_文章标题 (去除非法字符)"""
    date_part = pub_date[:10] if pub_date else "unknown_date"
    title_part = sanitize_filename(title.strip(), max_length=60)
    return f"{date_part}_{title_part}"


def md5_hash(text: str) -> str:
    return hashlib.md5(text.encode("utf-8")).hexdigest()


def unique_filename(directory: str, basename: str, ext: str) -> str:
    """生成不重名的文件路径，冲突时附加 hash"""
    counter = 0
    while True:
        if counter == 0:
            filename = f"{basename}{ext}"
        else:
            filename = f"{basename}_{counter}{ext}"
        fullpath = os.path.join(directory, filename)
        if not os.path.exists(fullpath):
            return fullpath
        counter += 1


# ---------------------------------------------------------------------------
# 时间工具
# ---------------------------------------------------------------------------

def parse_wechat_datetime(dt_str: str) -> Optional[datetime]:
    """解析微信时间格式，支持多种变体"""
    patterns = [
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d",
        "%Y/%m/%d",
        "%Y年%m月%d日",
    ]
    for pattern in patterns:
        try:
            return datetime.strptime(dt_str.strip(), pattern)
        except (ValueError, AttributeError):
            continue
    return None


def format_datetime(dt: datetime, fmt: str = "%Y-%m-%d %H:%M:%S") -> str:
    return dt.strftime(fmt)


def now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


# ---------------------------------------------------------------------------
# 速率控制
# ---------------------------------------------------------------------------

class RateLimiter:
    """自适应速率限制器，在 min/max 之间随机间隔"""

    def __init__(self, min_interval: float = 2.0, max_interval: float = 5.0):
        self.min_interval = min_interval
        self.max_interval = max_interval
        self._last_call: float = 0.0

    def wait(self):
        """等待一个随机间隔后返回"""
        elapsed = time.time() - self._last_call
        interval = random.uniform(self.min_interval, self.max_interval)
        if elapsed < interval:
            time.sleep(interval - elapsed)
        self._last_call = time.time()

    def batch_wait(self, count: int, threshold: int = 20, extra_sleep: float = 10.0):
        """每 threshold 次调用后额外休息"""
        if count > 0 and count % threshold == 0:
            time.sleep(extra_sleep)


# ---------------------------------------------------------------------------
# 状态文件（断点续传）
# ---------------------------------------------------------------------------

class ArchiveState:
    """记录归档进度，支持断点续传"""

    def __init__(self, state_path: str):
        self.state_path = state_path
        self.data: dict = self._load()

    def _load(self) -> dict:
        if os.path.exists(self.state_path):
            try:
                with open(self.state_path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except (json.JSONDecodeError, IOError):
                pass
        return {
            "total_articles": 0,
            "downloaded": [],
            "failed": [],
            "skipped": [],
            "comments_downloaded": [],
            "last_updated": "",
        }

    def save(self):
        self.data["last_updated"] = now_str()
        os.makedirs(os.path.dirname(self.state_path) or ".", exist_ok=True)
        with open(self.state_path, "w", encoding="utf-8") as f:
            json.dump(self.data, f, ensure_ascii=False, indent=2)

    def mark_downloaded(self, article_id: str):
        if article_id not in self.data["downloaded"]:
            self.data["downloaded"].append(article_id)
        self.save()

    def mark_failed(self, article_id: str):
        if article_id not in self.data["failed"]:
            self.data["failed"].append(article_id)
        self.save()

    def mark_comments_downloaded(self, article_id: str):
        if article_id not in self.data["comments_downloaded"]:
            self.data["comments_downloaded"].append(article_id)
        self.save()

    def is_downloaded(self, article_id: str) -> bool:
        return article_id in self.data["downloaded"]

    def is_comments_downloaded(self, article_id: str) -> bool:
        return article_id in self.data["comments_downloaded"]

    @property
    def progress(self) -> str:
        total = self.data["total_articles"]
        done = len(self.data["downloaded"])
        failed = len(self.data["failed"])
        if total == 0:
            return "等待开始…"
        return f"{done}/{total} 已完成 ({failed} 失败)"


# ---------------------------------------------------------------------------
# 目录初始化
# ---------------------------------------------------------------------------

def init_output_structure(output_dir: str, account_name: str) -> str:
    """创建标淮化归档目录结构，返回根目录路径"""
    safe_account_name = sanitize_filename(account_name, max_length=60)
    root_dir = os.path.join(output_dir, f"{safe_account_name}_公众号全量归档")
    os.makedirs(root_dir, exist_ok=True)
    # 按年份预建目录
    current_year = datetime.now().year
    for year in range(2015, current_year + 1):
        os.makedirs(os.path.join(root_dir, str(year)), exist_ok=True)
    return root_dir
