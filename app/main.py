#!/usr/bin/env python3
"""
星河炸鸡 - 公众号全量归档工具
=================================
一键归档公众号所有历史文章到本地，按标准目录结构存储。

用法:
    python main.py                          # 使用默认配置
    python main.py --config my_config.yaml  # 指定配置文件
    python main.py --login-only             # 仅登录并保存 Cookie
    python main.py --resume                 # 恢复中断的归档任务

首次运行会自动弹出浏览器窗口，用管理员微信扫码登录。
登录后自动批量下载全量文章、图片、音视频、评论。
支持断点续传，中断后再次运行 --resume 继续。
"""

import os
import sys
import yaml
import time
import json
import argparse
import logging
from datetime import datetime
from typing import Optional

from tqdm import tqdm

# 添加项目根目录到路径
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from modules.utils import (
    RateLimiter,
    ArchiveState,
    init_output_structure,
    now_str,
)
from modules.login import (
    login_and_get_cookies,
    login_and_get_driver,
    extract_token_and_fakeid,
    inject_token_to_cache,
    clear_cookie_cache,
)
from modules.article_list import (
    fetch_article_list,
    fetch_article_stats,
    ArticleInfo,
)
from modules.article_parser import (
    fetch_and_parse,
    ParsedArticle,
)
from modules.media_downloader import batch_download, download_media
from modules.comments import fetch_comments, CommentItem
from modules.organizer import (
    write_article,
    write_index_csv,
    write_archive_readme,
)

# ---------------------------------------------------------------------------
# 日志配置
# ---------------------------------------------------------------------------

def setup_logging(log_dir: str = "logs"):
    os.makedirs(log_dir, exist_ok=True)
    log_file = os.path.join(log_dir, f"archive_{datetime.now():%Y%m%d_%H%M%S}.log")

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
        handlers=[
            logging.FileHandler(log_file, encoding="utf-8"),
            logging.StreamHandler(),
        ],
    )
    return logging.getLogger(__name__)


logger = setup_logging()


# ---------------------------------------------------------------------------
# 配置加载
# ---------------------------------------------------------------------------

def load_config(config_path: str = "config.yaml") -> dict:
    """加载 YAML 配置文件"""
    default_path = config_path or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "config.yaml"
    )
    if not os.path.exists(default_path):
        logger.warning(f"配置文件不存在: {default_path}，使用默认配置")
        return {
            "account_name": "星河炸鸡",
            "output_dir": "./output",
            "date_from": "",
            "date_to": "",
            "export": {
                "format": "markdown",
                "download_images": True,
                "download_audio": True,
                "download_video": True,
                "download_comments": True,
                "max_workers": 3,
            },
            "browser": {
                "type": "chrome",
                "headless": False,
                "user_data_dir": "",
                "page_load_timeout": 30,
                "implicit_wait": 10,
            },
            "rate_limit": {
                "min_interval": 2.0,
                "max_interval": 5.0,
                "retry_max": 3,
                "retry_delay": 5,
                "batch_sleep": 10,
            },
            "resume": {"enabled": True, "state_file": ".archive_state.json"},
            "comments": {"max_per_article": 100, "include_replies": True},
        }

    with open(default_path, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f)
    logger.info(f"已加载配置文件: {default_path}")
    return config


# ---------------------------------------------------------------------------
# 核心归档流程
# ---------------------------------------------------------------------------

class WeChatArchiver:
    """公众号归档主控制器"""

    def __init__(self, config: dict):
        self.config = config
        self.account_name = config.get("account_name", "公众号")
        self.output_dir = config.get("output_dir", "./output")
        export = config.get("export", {})
        self.download_images = export.get("download_images", True)
        self.download_audio = export.get("download_audio", True)
        self.download_video = export.get("download_video", True)
        self.download_comments = export.get("download_comments", True)
        self.download_stats = export.get("download_stats", True)

        rl = config.get("rate_limit", {})
        self.rate_limiter = RateLimiter(
            min_interval=rl.get("min_interval", 2.0),
            max_interval=rl.get("max_interval", 5.0),
        )

        resume_cfg = config.get("resume", {})
        self.state_file = resume_cfg.get("state_file", ".archive_state.json")

        # 归档根目录
        self.root_dir = init_output_structure(self.output_dir, self.account_name)

        # 状态文件（位于归档根目录）
        state_path = os.path.join(self.root_dir, self.state_file)
        self.state = ArchiveState(state_path)

        # 存储文章列表
        self.articles: list[ArticleInfo] = []

    # -----------------------------------------------------------------------
    # 阶段 1: 登录
    # -----------------------------------------------------------------------

    def login_step(self) -> tuple:
        """执行登录，返回 (cookies, token, fakeid)"""
        logger.info("=" * 50)
        logger.info("阶段 1/5: 登录公众号后台")
        logger.info("=" * 50)

        cookies = login_and_get_cookies(self.config)
        if not cookies:
            logger.error("登录失败，请检查网络或重试")
            sys.exit(1)

        token, fakeid = extract_token_and_fakeid(cookies)
        if not token or not fakeid:
            logger.warning(
                "Cookie 中未找到 token/fakeid，将尝试从页面提取"
            )
            # 使用 Selenium 驱动提取
            driver = login_and_get_driver(self.config)
            try:
                # 从页面 URL 提取 token
                current_url = driver.current_url
                import re
                m = re.search(r'token=(\d+)', current_url)
                if m:
                    token = m.group(1)
                    cookies["token"] = token
                # 从页面 URL 或源码提取 fakeid
                m2 = re.search(r'fakeid=([a-zA-Z0-9\-_]+)', current_url)
                if not m2:
                    # 从页面源码中找
                    m2 = re.search(r'"fakeid"\s*:\s*"([^"]+)"', driver.page_source)
                if m2:
                    fakeid = m2.group(1)
                    cookies["fakeid"] = fakeid
            finally:
                driver.quit()

            # 将提取到的 token/fakeid 写回 Cookie 缓存，下次无需再弹浏览器
            if token and fakeid:
                inject_token_to_cache(token, fakeid)

        logger.info("登录成功，公众号会话已建立")
        self.cookies = cookies
        return cookies, token, fakeid

    # -----------------------------------------------------------------------
    # 阶段 2: 获取文章列表
    # -----------------------------------------------------------------------

    def fetch_article_list_step(
        self, cookies: dict, token: str, fakeid: str
    ) -> list[ArticleInfo]:
        """获取公众号全量历史文章列表"""
        logger.info("=" * 50)
        logger.info("阶段 2/5: 获取全量历史文章列表")
        logger.info("=" * 50)

        date_from = self.config.get("date_from", "")
        date_to = self.config.get("date_to", "")

        articles = fetch_article_list(
            cookies=cookies,
            token=token,
            fakeid=fakeid,
            rate_limiter=self.rate_limiter,
            date_from=date_from,
            date_to=date_to,
            on_progress=lambda done, total: logger.info(
                f"  列表进度: {done}/{total}"
            ),
        )

        self.articles = articles
        self.state.data["total_articles"] = len(articles)
        self.state.save()

        logger.info(f"共获取 {len(articles)} 篇文章")
        return articles

    # -----------------------------------------------------------------------
    # 阶段 3: 逐一获取阅读数据（可选）
    # -----------------------------------------------------------------------

    def fetch_stats_step(self, cookies: dict, token: str):
        """获取每篇文章的阅读量/在看/点赞数据"""
        if not self.download_stats:
            logger.info("已跳过文章阅读数据（可在高级选项中开启）")
            return
        logger.info("=" * 50)
        logger.info("阶段 3/5: 获取文章阅读数据")
        logger.info("=" * 50)

        total = len(self.articles)
        if total == 0:
            return

        for i, article in enumerate(self.articles):
            logger.info(f"  [{i+1}/{total}] 获取统计: {article.title[:30]}...")
            self.rate_limiter.wait()
            fetch_article_stats(cookies, token, article)
            self.rate_limiter.batch_wait(i + 1, threshold=50, extra_sleep=10)

        logger.info("阅读数据获取完成")

    # -----------------------------------------------------------------------
    # 阶段 4: 批量下载文章正文、媒体、评论
    # -----------------------------------------------------------------------

    def download_articles_step(self) -> tuple:
        """
        逐篇下载文章、媒体、评论。
        支持断点续传。

        返回:
            (成功数, 失败数)
        """
        logger.info("=" * 50)
        logger.info("阶段 4/5: 下载文章正文与资源")
        logger.info("=" * 50)

        total = len(self.articles)
        if total == 0:
            logger.warning("没有文章需要下载")
            return 0, 0

        success = 0
        failed = 0
        skipped = 0

        # 创建共享 session（article download 需 session 态 Cookie，非 dict 形式）
        import requests as req_mod
        dl_session = req_mod.Session()
        dl_session.cookies.update(self.cookies)

        for i, article in enumerate(self.articles):
            article_id = article.msg_id or article.url

            # 断点续传检查
            if self.state.is_downloaded(article_id):
                skipped += 1
                continue

            logger.info(
                f"  [{i+1}/{total}] {article.pub_date[:10]} {article.title[:40]}..."
            )

            # --- 下载文章正文 ---
            parsed = fetch_and_parse(
                url=article.url,
                title=article.title,
                publish_date=article.pub_date,
                session=dl_session,
            )
            if parsed is None:
                logger.warning(f"    下载失败: {article.url[:60]}")
                self.state.mark_failed(article_id)
                failed += 1
                continue

            # --- 预计算文章目录 ---
            from modules.utils import make_article_dirname
            year = article.pub_year or "unknown"
            dirname = make_article_dirname(article.pub_date, article.title)
            article_dir = os.path.join(self.root_dir, year, dirname)
            os.makedirs(article_dir, exist_ok=True)

            # --- 下载媒体文件（直接下到文章目录内）---
            if self.download_images and parsed.images:
                img_ok, img_total = batch_download(
                    parsed.images,
                    target_dir=article_dir,
                    desc=f"    图片 ({len(parsed.images)}张)",
                )
                if img_ok < img_total:
                    logger.warning(f"    图片 {img_ok}/{img_total} 下载成功")

            if self.download_audio and parsed.audio:
                batch_download(
                    parsed.audio,
                    target_dir=article_dir,
                    desc=f"    音频 ({len(parsed.audio)}个)",
                )

            if self.download_video and parsed.video:
                batch_download(
                    parsed.video,
                    target_dir=article_dir,
                    desc=f"    视频 ({len(parsed.video)}个)",
                )

            # --- 抓取评论 ---
            comments = None
            if self.download_comments:
                # 如果文章下载下来了，可以用 HTML 提取评论参数
                # 这里需要重新获取 HTML 或使用解析后的内容
                try:
                    import requests
                    resp = requests.get(article.url, timeout=30,
                        headers={
                            "User-Agent": (
                                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                                "AppleWebKit/537.36 (KHTML, like Gecko) "
                                "Chrome/124.0.0.0 Safari/537.36"
                            )
                        })
                    resp.encoding = "utf-8"
                    html = resp.text
                    comments = fetch_comments(
                        article_url=article.url,
                        article_html=html,
                        max_comments=self.config.get("comments", {}).get(
                            "max_per_article", 100
                        ),
                        include_replies=self.config.get("comments", {}).get(
                            "include_replies", True
                        ),
                    )
                except Exception as e:
                    logger.warning(f"    评论抓取失败: {e}")

            # --- 写入标准化目录 ---
            write_article(
                root_dir=self.root_dir,
                article_info=article,
                parsed=parsed,
                comments=comments,
                download_images=self.download_images,
                download_audio=self.download_audio,
                download_video=self.download_video,
                download_comments=self.download_comments,
            )

            # 标记完成
            self.state.mark_downloaded(article_id)
            success += 1

            # 速率控制
            self.rate_limiter.wait()
            self.rate_limiter.batch_wait(
                i + 1,
                threshold=20,
                extra_sleep=self.config.get("rate_limit", {}).get(
                    "batch_sleep", 10
                ),
            )

        logger.info(f"下载完成: {success} 成功, {failed} 失败, {skipped} 跳过")
        return success, failed

    # -----------------------------------------------------------------------
    # 阶段 5: 生成索引与归档说明
    # -----------------------------------------------------------------------

    def finalize_step(self):
        """生成索引 CSV 和归档说明文档"""
        logger.info("=" * 50)
        logger.info("阶段 5/5: 生成索引与归档说明")
        logger.info("=" * 50)

        # 索引 CSV
        write_index_csv(self.root_dir, self.articles)

        # 归档说明
        date_from = self.config.get("date_from", "")
        date_to = self.config.get("date_to", "")
        write_archive_readme(
            root_dir=self.root_dir,
            account_name=self.account_name,
            total_articles=len(self.articles),
            start_date=date_from,
            end_date=date_to,
            export_options={
                "download_images": self.download_images,
                "download_audio": self.download_audio,
                "download_video": self.download_video,
                "download_comments": self.download_comments,
            },
            articles=self.articles,
        )

        logger.info("索引与归档说明已生成")

    # -----------------------------------------------------------------------
    # 完整性校验
    # -----------------------------------------------------------------------

    def verify_step(self):
        """对归档结果做基本完整性校验"""
        logger.info("=" * 50)
        logger.info("完整性校验")
        logger.info("=" * 50)

        total = len(self.articles)
        downloaded = len(self.state.data["downloaded"])
        failed = len(self.state.data["failed"])

        # 统计实际目录数量
        year_dirs = [
            d
            for d in os.listdir(self.root_dir)
            if d.isdigit() and os.path.isdir(os.path.join(self.root_dir, d))
        ]
        actual_article_dirs = 0
        for year in year_dirs:
            year_path = os.path.join(self.root_dir, year)
            actual_article_dirs += len(
                [d for d in os.listdir(year_path)
                 if os.path.isdir(os.path.join(year_path, d))]
            )

        logger.info(f" 文章总数(列表): {total}")
        logger.info(f" 已下载(状态):  {downloaded}")
        logger.info(f" 下载失败:       {failed}")
        logger.info(f" 实际目录数:     {actual_article_dirs}")

        if actual_article_dirs != downloaded:
            logger.warning(
                f"  ⚠ 目录数与已下载数不一致!"
                f" ({actual_article_dirs} vs {downloaded})"
            )

        if failed > 0:
            logger.warning(f"  ⚠ 有 {failed} 篇文章下载失败，请检查日志")

        logger.info("校验完成")
        return actual_article_dirs == downloaded

    # -----------------------------------------------------------------------
    # 运行全部流程
    # -----------------------------------------------------------------------

    def run(self):
        """执行完整归档流程"""
        start_time = time.time()
        logger.info(f"开始归档: {self.account_name}")
        logger.info(f"输出目录: {os.path.abspath(self.root_dir)}")

        print()
        print("⭐" + "=" * 58)
        print(f"  《{self.account_name}》公众号全量归档工具")
        print("=" * 60)
        print()

        # 阶段 1: 登录
        cookies, token, fakeid = self.login_step()

        # 阶段 2: 获取文章列表
        articles = self.fetch_article_list_step(cookies, token, fakeid)
        if not articles:
            logger.warning("未获取到任何文章，请检查权限或公众号是否有历史内容")
            return

        # 阶段 3: 获取阅读数据
        self.fetch_stats_step(cookies, token)

        # 阶段 4: 下载文章
        success, failed = self.download_articles_step()

        # 阶段 5: 生成索引
        self.finalize_step()

        # 校验
        self.verify_step()

        # 汇总
        elapsed = time.time() - start_time
        print()
        print("=" * 60)
        print(f"  ✅ 归档完成!")
        print(f"  公众号:       {self.account_name}")
        print(f"  文章总数:     {len(articles)}")
        print(f"  成功下载:     {success}")
        print(f"  下载失败:     {failed}")
        print(f"  耗时:         {elapsed:.0f} 秒 ({elapsed/60:.1f} 分钟)")
        print(f"  输出目录:     {os.path.abspath(self.root_dir)}")
        print("=" * 60)
        print()


# ---------------------------------------------------------------------------
# CLI 入口
# ---------------------------------------------------------------------------

def parse_args():
    parser = argparse.ArgumentParser(
        description="星河炸鸡 - 公众号全量归档工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
    python main.py                          # 完整归档流程
    python main.py --config custom.yaml     # 使用自定义配置
    python main.py --login-only             # 仅登录（保存 Cookie）
    python main.py --resume                 # 恢复中断任务
    python main.py --clear-cache            # 清除 Cookie 缓存
        """,
    )
    parser.add_argument(
        "--config",
        default="config.yaml",
        help="配置文件路径（默认: config.yaml）",
    )
    parser.add_argument(
        "--login-only",
        action="store_true",
        help="仅执行登录步骤，保存 Cookie 后退出",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="恢复上次中断的归档任务",
    )
    parser.add_argument(
        "--clear-cache",
        action="store_true",
        help="清除缓存的 Cookie",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="日志级别（默认: INFO）",
    )
    return parser.parse_args()


def main():
    args = parse_args()

    # 清除 Cookie 缓存
    if args.clear_cache:
        clear_cookie_cache()
        print("Cookie 缓存已清除")
        return

    # 加载配置
    config = load_config(args.config)

    # 设置日志级别
    logging.getLogger().setLevel(getattr(logging, args.log_level))

    # 创建归档器
    archiver = WeChatArchiver(config)

    if args.login_only:
        # 仅登录
        archiver.login_step()
        print("登录完成，Cookie 已保存")
        return

    # 完整运行
    archiver.run()


if __name__ == "__main__":
    main()
