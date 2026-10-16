"""
wechat_archive - 多媒体资源下载模块
下载文章内的图片、音频、视频到本地目录
支持重试、校验、超时控制
"""

import os
import logging
from typing import Optional
from urllib.parse import urlparse

import requests
from tqdm import tqdm

from .utils import RateLimiter
from .article_parser import MediaAsset

logger = logging.getLogger(__name__)

# 允许的媒体大小上限 (字节)
MAX_IMAGE_SIZE = 20 * 1024 * 1024     # 20 MB
MAX_AUDIO_SIZE = 50 * 1024 * 1024     # 50 MB
MAX_VIDEO_SIZE = 500 * 1024 * 1024    # 500 MB


# ---------------------------------------------------------------------------
# 下载单文件
# ---------------------------------------------------------------------------

def download_media(
    asset: MediaAsset,
    target_dir: str,
    session: Optional[requests.Session] = None,
    timeout: int = 60,
) -> bool:
    """
    下载一个媒体资源到指定目录。

    参数:
        asset: 媒体资源对象
        target_dir: 目标目录（如 images/、audio/、video/）
        session: 可复用的 requests Session
        timeout: 超时秒数

    返回:
        是否下载成功
    """
    os.makedirs(target_dir, exist_ok=True)
    filepath = os.path.join(target_dir, asset.local_name)

    # 如果文件已存在且大小 > 0，跳过
    if os.path.exists(filepath) and os.path.getsize(filepath) > 0:
        # 文件名已正确，直接设置
        return True

    # 设置 User-Agent
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Referer": "https://mp.weixin.qq.com/",
    }

    sess = session or requests.Session()
    max_retries = 3

    for attempt in range(1, max_retries + 1):
        try:
            resp = sess.get(
                asset.url,
                headers=headers,
                timeout=timeout,
                stream=True,
            )
            resp.raise_for_status()

            # 检查大小
            content_length = int(resp.headers.get("content-length", 0))
            size_limits = {
                "image": MAX_IMAGE_SIZE,
                "audio": MAX_AUDIO_SIZE,
                "video": MAX_VIDEO_SIZE,
            }
            if content_length > size_limits.get(asset.media_type, MAX_IMAGE_SIZE):
                logger.warning(
                    f"跳过过大文件: {asset.local_name} "
                    f"({content_length / 1024 / 1024:.1f} MB)"
                )
                return False

            # 流式写入
            with open(filepath, "wb") as f:
                for chunk in resp.iter_content(chunk_size=8192):
                    if chunk:
                        f.write(chunk)

            # 校验文件
            if os.path.getsize(filepath) == 0:
                os.remove(filepath)
                logger.warning(f"下载文件为空，重试 {attempt}/{max_retries}: {asset.url[:60]}")
                continue

            asset.filename = asset.local_name
            return True

        except requests.RequestException as e:
            logger.warning(
                f"下载失败 {attempt}/{max_retries}: "
                f"{asset.url[:50]} - {e}"
            )
            if attempt < max_retries:
                import time
                time.sleep(3)

    return False


# ---------------------------------------------------------------------------
# 批量下载
# ---------------------------------------------------------------------------

def batch_download(
    assets: list[MediaAsset],
    target_dir: str,
    rate_limiter: Optional[RateLimiter] = None,
    desc: str = "下载中",
) -> tuple[int, int]:
    """
    批量下载媒体资源。

    参数:
        assets: 媒体资源列表
        target_dir: 目标根目录（自动创建 images/audio/video 子目录）
        rate_limiter: 可选限速器
        desc: tqdm 描述文字

    返回:
        (成功数, 总数)
    """
    if rate_limiter is None:
        rate_limiter = RateLimiter(min_interval=0.5, max_interval=1.5)

    success = 0
    total = len(assets)

    if total == 0:
        return 0, 0

    # 按类型分类到子目录
    type_dirs = {
        "image": os.path.join(target_dir, "images"),
        "audio": os.path.join(target_dir, "audio"),
        "video": os.path.join(target_dir, "video"),
    }

    session = requests.Session()

    for asset in tqdm(assets, desc=desc, unit="file"):
        rate_limiter.wait()
        subdir = type_dirs.get(asset.media_type, target_dir)
        if download_media(asset, subdir, session=session):
            success += 1
        else:
            logger.warning(f"下载失败: {asset.url[:60]}")

    session.close()
    return success, total
