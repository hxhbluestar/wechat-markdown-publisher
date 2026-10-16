"""
wechat_archive - 文章正文解析与 Markdown 转换模块
下载单篇文章 HTML，提取正文，转换为 Markdown 格式
提取文中图片、音频、视频资源 URL
"""

import re
import json
import logging
from typing import Optional
from urllib.parse import urljoin, urlparse
from html import unescape

import requests
from bs4 import BeautifulSoup, Tag
from markdownify import markdownify as md_convert

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 资源类型
# ---------------------------------------------------------------------------

class MediaAsset:
    """文章内嵌媒体资源"""

    def __init__(self, url: str, media_type: str, index: int = 0):
        self.url = url
        self.media_type = media_type  # "image" | "audio" | "video"
        self.index = index
        self.filename = ""

    @property
    def ext(self) -> str:
        ext_map = {
            "image": ".jpg",
            "audio": ".mp3",
            "video": ".mp4",
        }
        ext = ext_map.get(self.media_type, ".bin")
        # 尝试从 URL 推断扩展名
        parsed = urlparse(self.url)
        path_ext = re.search(r"\.(\w+)(?:\?|$)", parsed.path)
        if path_ext:
            detected = path_ext.group(1).lower()
            if detected in ("jpg", "jpeg", "png", "gif", "webp", "bmp"):
                return f".{detected}"
            if detected in ("mp3", "aac", "wma", "ogg"):
                return f".{detected}"
            if detected in ("mp4", "mov", "avi", "flv"):
                return f".{detected}"
        return ext

    @property
    def local_name(self) -> str:
        return f"{self.media_type}_{self.index:03d}{self.ext}"

    def __repr__(self):
        return f"<Media: {self.media_type} #{self.index}>"


# ---------------------------------------------------------------------------
# 文章解析结果
# ---------------------------------------------------------------------------

class ParsedArticle:
    """单篇文章的完整解析结果"""

    def __init__(self):
        self.title: str = ""
        self.author: str = ""
        self.publish_date: str = ""
        self.body_html: str = ""    # 正文 HTML
        self.body_markdown: str = ""  # 正文 Markdown
        self.images: list[MediaAsset] = []
        self.audio: list[MediaAsset] = []
        self.video: list[MediaAsset] = []
        self.original_url: str = ""

    @property
    def all_media(self) -> list[MediaAsset]:
        return self.images + self.audio + self.video


# ---------------------------------------------------------------------------
# 链接音频提取
# ---------------------------------------------------------------------------

def extract_audio_link(content: str) -> Optional[str]:
    """
    从文章正文 HTML 中提取音频链接。
    微信公众号文章内的音频通常通过 wx- audio 标签或 iframe 内嵌。
    """
    # mpvoice 链接模式: <mpvoice ... voice_encode_fileid="..." ...>
    voice_match = re.search(
        r'voice_encode_fileid=["\']([^"\']+)["\']', content
    )
    if voice_match:
        file_id = voice_match.group(1)
        return f"https://res.wx.qq.com/voice/getvoice?mediaid={file_id}"

    # iframe 音频模式
    iframe_match = re.search(
        r'<iframe[^>]*src=["\']([^"\']*audio[^"\']*)["\']', content, re.I
    )
    if iframe_match:
        return iframe_match.group(1)

    return None


# ---------------------------------------------------------------------------
# HTML 预处理
# ---------------------------------------------------------------------------

def _preprocess_html(html: str) -> str:
    """预处理: 移除无用的脚本、样式、注释"""
    soup = BeautifulSoup(html, "lxml")

    # 移除 script, style, iframe(非视频/音频), comment
    for tag in soup.find_all(["script", "style", "noscript"]):
        tag.decompose()

    # 移除微信特有的属性标签
    for tag in soup.find_all(True):
        attrs_to_remove = [
            "data-s", "data-ratio", "data-w", "data-type",
            "data-backsrc", "data-src_", "data-tapsrc",
        ]
        for attr in attrs_to_remove:
            if attr in tag.attrs:
                del tag.attrs[attr]

    return str(soup)


def _extract_rich_media(soup: BeautifulSoup) -> tuple:
    """
    从文章中提取嵌入的音视频。
    返回 (images, audio, video) 三元组。
    """
    images: list[MediaAsset] = []
    audio: list[MediaAsset] = []
    video: list[MediaAsset] = []

    # --- 图片: img / wx-img tags ---
    for img in soup.find_all("img"):
        src = (
            img.get("data-src")
            or img.get("src")
            or img.get("data-croporisrc")
            or ""
        )
        if src and not src.startswith("data:"):
            src = re.sub(r"\?.*", "", src) if "?" in src else src
            images.append(MediaAsset(src, "image", len(images)))

    # --- 视频: iframe / video / wx-video ---
    for v in soup.find_all(["iframe", "video"]):
        src = v.get("src", "") or v.get("data-src", "")
        if "video" in src.lower() or "mp4" in src.lower():
            video.append(MediaAsset(src, "video", len(video)))

    # --- 音频: mpvoice / iframe ---
    for mpvoice in soup.find_all("mpvoice"):
        file_id = mpvoice.get("voice_encode_fileid", "")
        if file_id:
            url = f"https://res.wx.qq.com/voice/getvoice?mediaid={file_id}"
            audio.append(MediaAsset(url, "audio", len(audio)))

    for iframe in soup.find_all("iframe"):
        src = iframe.get("src", "")
        if "audio" in src.lower() or "voice" in src.lower():
            audio.append(MediaAsset(src, "audio", len(audio)))

    return images, audio, video


def _extract_cdn_images_from_raw_html(raw_html: str, existing_images: list[MediaAsset]):
    """
    从原始 HTML 中提取 [贴图] 模式下嵌入在 script/data 中的 cdn_url 图片。
    这些图片在 <script> 标签内，经过 HTML 预处理后会被移除，因此必须从原始 HTML 提取。
    """
    seen_urls = {img.url.split("?")[0] for img in existing_images}

    # 匹配 cdn_url: 'https://mmbiz.qpic.cn/.../0?wx_fmt=jpeg' 或双引号变体
    for pattern in [
        r"cdn_url:\s*'([^']+mmbiz[^']+)'",
        r'cdn_url:\s*"([^"]+mmbiz[^"]+)"',
    ]:
        for match in re.finditer(pattern, raw_html):
            url = match.group(1)
            clean_url = re.sub(r"\?.*", "", url)
            if clean_url in seen_urls:
                continue
            # 接受所有 mmbiz CDN 图片（包括 wx_fmt= 参数形式的）
            is_image = (
                any(ext in clean_url.lower() for ext in (".jpg", ".jpeg", ".png", ".gif", ".webp"))
                or any(ext in url.lower() for ext in ("wx_fmt=jpeg", "wx_fmt=jpg", "wx_fmt=png", "wx_fmt=gif", "wx_fmt=webp"))
                or "/mmbiz_" in url or "mmbiz.qpic.cn" in url  # 微信 CDN 图片
            )
            if is_image:
                seen_urls.add(clean_url)
                existing_images.append(MediaAsset(clean_url, "image", len(existing_images)))


def _replace_media_refs(
    soup: BeautifulSoup,
    images: list[MediaAsset],
    audio: list[MediaAsset],
    video: list[MediaAsset],
) -> str:
    """
    将 HTML 中的媒体引用替换为本地路径占位符，
    以便后续 markdownify 转换时保留引用。
    """
    # 替换图片
    img_map = {}
    for asset in images:
        img_map[asset.url] = asset.local_name
    for img in soup.find_all("img"):
        src = (
            img.get("data-src")
            or img.get("src")
            or img.get("data-croporisrc")
            or ""
        )
        clean_src = re.sub(r"\?.*", "", src) if "?" in src else src
        if clean_src in img_map:
            img["src"] = f"images/{img_map[clean_src]}"

    # 替换视频 iframe 为文本提示
    for iframe in soup.find_all("iframe"):
        src = iframe.get("src", "")
        if "video" in src.lower() or "mp4" in src.lower():
            # 替换为一个占位链接
            if video:
                video_tag = soup.new_tag("a")
                video_tag["href"] = f"video/{video[0].local_name}"
                video_tag.string = f"[视频: {video[0].local_name}]"
                iframe.replace_with(video_tag)

    # 替换音频 mpvoice
    for mpvoice in soup.find_all("mpvoice"):
        if audio:
            audio_tag = soup.new_tag("a")
            audio_tag["href"] = f"audio/{audio[0].local_name}"
            audio_tag.string = f"[音频: {audio[0].local_name}]"
            mpvoice.replace_with(audio_tag)

    return str(soup)


# ---------------------------------------------------------------------------
# 核心解析函数
# ---------------------------------------------------------------------------

def parse_article_html(
    html: str,
    original_url: str = "",
    title: str = "",
    author: str = "",
    publish_date: str = "",
) -> ParsedArticle:
    """
    解析微信公众号文章的 HTML，返回 ParsedArticle 对象。
    """
    result = ParsedArticle()
    result.title = title
    result.author = author
    result.publish_date = publish_date
    result.original_url = original_url

    # 1) 提取 [贴图] 模式下的 cdn_url 图片（必须在预处理前，因为脚本会被移除）
    raw_html_for_cdn = html
    result.images = []
    _extract_cdn_images_from_raw_html(raw_html_for_cdn, result.images)

    # 2) 预处理
    html = _preprocess_html(html)
    soup = BeautifulSoup(html, "lxml")

    # 如果未提供标题，从页面提取
    if not result.title:
        title_tag = soup.find("title")
        if title_tag:
            result.title = title_tag.get_text(strip=True)

    # 3) 定位正文
    # 微信文章的正文通常在 id="js_content" 或 class="rich_media_content" 中
    body = (
        soup.find(id="js_content")
        or soup.find(class_="rich_media_content")
        or soup.find("div", class_="rich_media_area_primary")
        or soup.find("div", class_="rich_media_area_extra")
        or soup
    )

    # 4) 提取富媒体资源（img 标签等）
    more_images, audio, video = _extract_rich_media(body)
    # 合并 CDN 图片和 img 标签图片
    for img in more_images:
        if img.url.split("?")[0] not in {i.url.split("?")[0] for i in result.images}:
            img.index = len(result.images)
            result.images.append(img)
    result.audio = audio
    result.video = video

    # 5) 替换资源引用为本地路径
    body_html = _replace_media_refs(body, result.images, audio, video)

    # 6) 生成 Markdown
    md_content = md_convert(
        body_html,
        heading_style="ATX",
        bullets="-",
        strip=["script", "style"],
        code_language="",
    )
    # 清理多余空行
    md_content = re.sub(r"\n{4,}", "\n\n", md_content)
    md_content = md_content.strip()

    # 如果没有正文，尝试用纯文本
    if not md_content:
        body_text = body.get_text(separator="\n", strip=True)
        md_content = body_text

    # 7) 仅把未能保留在正文中的图片放进兜底图库，避免重复。
    referenced_images = set(
        re.findall(r"\]\((images/image_\d+\.[^)]+)\)", md_content)
    )
    missing_images = [
        img for img in result.images
        if f"images/{img.local_name}" not in referenced_images
    ]
    if missing_images:
        gallery_lines = []
        gallery_lines.append("")
        gallery_lines.append("---")
        gallery_lines.append("")
        gallery_lines.append("## 图库")
        gallery_lines.append("")
        for img in missing_images:
            gallery_lines.append(f"![{img.local_name}](images/{img.local_name})")
            gallery_lines.append("")
        md_content = md_content.rstrip() + "\n" + "\n".join(gallery_lines)

    result.body_markdown = md_content
    result.body_html = body_html

    return result


# ---------------------------------------------------------------------------
# 从 URL 下载并解析文章
# ---------------------------------------------------------------------------

def fetch_and_parse(
    url: str,
    title: str = "",
    author: str = "",
    publish_date: str = "",
    cookies: dict = None,
    session: requests.Session = None,
    timeout: int = 30,
) -> Optional[ParsedArticle]:
    """
    下载并解析微信公众号文章。
    必须传入 cookies 或 session 以获取 [贴图] 模式的完整图片数据。
    session 优先；若提供 session 则复用其已有 Cookie。
    返回 ParsedArticle，失败返回 None。
    """
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept": (
            "text/html,application/xhtml+xml,application/xml;"
            "q=0.9,image/avif,image/webp,*/*;q=0.8"
        ),
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }

    try:
        if session:
            resp = session.get(url, headers=headers, timeout=timeout)
        else:
            resp = requests.get(url, headers=headers, cookies=cookies, timeout=timeout)
        resp.encoding = "utf-8"
        resp.raise_for_status()

        # 如果未提供标题/日期，从页面元数据提取
        soup = BeautifulSoup(resp.text, "lxml")
        if not title:
            og_title = soup.find("meta", property="og:title")
            if og_title:
                title = og_title.get("content", "")
        if not publish_date:
            time_tag = soup.find("em", id="publish_time")
            if time_tag:
                publish_date = time_tag.get_text(strip=True)
        if not author:
            # 从 og:article:author 或页面顶部提取
            og_author = soup.find("meta", property="og:article:author")
            if og_author:
                author = og_author.get("content", "")

        return parse_article_html(
            resp.text,
            original_url=url,
            title=title,
            author=author,
            publish_date=publish_date,
        )

    except requests.RequestException as e:
        logger.error(f"下载文章失败 {url[:60]}: {e}")
        return None
