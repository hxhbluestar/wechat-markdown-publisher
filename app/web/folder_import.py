"""Offline folder envelopes: one selected Markdown and an original assets tree.

The browser constructs the ZIP; callers never provide a server filesystem path.
Validation completes before DraftStore stages or exposes the new draft.
"""
from __future__ import annotations

import hashlib
import html
import io
import posixpath
import re
import stat
import unicodedata
import zipfile
from datetime import datetime, timezone
from pathlib import PurePosixPath
from urllib.parse import unquote, urlsplit

from article_import import ArticleImportError, _counts, _front_metadata, _image_asset, _image_references, _protected_markdown, _text, _url_kind

MAX_FOLDER_BYTES = 256 * 1024 * 1024
MAX_ATTACHMENT_BYTES = 128 * 1024 * 1024
MAX_FOLDER_FILES = 512
IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.gif', '.webp'}
VIDEO_MIMES = {'.mp4':'video/mp4', '.m4v':'video/mp4', '.mov':'video/quicktime', '.webm':'video/webm'}
_RESERVED = re.compile(r'(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?', re.I)

def safe_folder_path(value):
    if not isinstance(value,str) or not value or len(value)>1024 or unicodedata.normalize('NFC',value)!=value:
        raise ArticleImportError('附件路径为空、过长或字符格式无效')
    parts=value.split('/')
    if any(not p or p in ('.','..') or p.endswith((' ','.')) or _RESERVED.fullmatch(p)
           or any(ord(c)<32 or c in '\\:<>"|?*' for c in p) for p in parts):
        raise ArticleImportError('附件路径不能越过目录或使用系统保留名称')
    # Actual names containing percent escapes are ambiguous after URL decoding.
    if re.search(r'%[0-9a-f]{2}',value,re.I):
        raise ArticleImportError('附件文件名不能包含百分号编码，请先重命名文件')
    return value

def safe_attachment_path(value):
    clean=safe_folder_path(value)
    if not clean.startswith('assets/') or len(clean.split('/'))<2:
        raise ArticleImportError('文章附件必须放在 assets/ 目录中')
    return clean

def attachment_kind(path):
    suffix=PurePosixPath(path).suffix.lower()
    if suffix in IMAGE_EXTS:return 'image'
    if suffix in VIDEO_MIMES:return 'video'
    return 'attachment'

def validate_attachment(path,data):
    safe_attachment_path(path)
    if not isinstance(data,bytes) or len(data)>MAX_ATTACHMENT_BYTES:
        raise ArticleImportError('单个附件不能超过 128 MiB')
    kind=attachment_kind(path)
    mime='application/octet-stream'
    if kind=='image':
        verified=_image_asset(data)
        expected={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp'}[PurePosixPath(path).suffix.lower()]
        if verified['mime']!=expected:raise ArticleImportError('图片扩展名与实际内容不一致：'+path)
        mime=verified['mime']
    elif kind=='video':
        suffix=PurePosixPath(path).suffix.lower()
        if suffix=='.webm':valid=data.startswith(b'\x1aE\xdf\xa3') and b'webm' in data[:4096].lower()
        else:
            valid=len(data)>=16 and data[4:8]==b'ftyp' and 16<=int.from_bytes(data[:4],'big')<=len(data)
            if suffix=='.mov' and not valid:
                valid=len(data)>=8 and data[4:8] in (b'moov',b'mdat',b'wide',b'free',b'skip') and (int.from_bytes(data[:4],'big')==0 or 8<=int.from_bytes(data[:4],'big')<=len(data))
        if not valid:raise ArticleImportError('视频容器无效或文件损坏：'+path)
        mime=VIDEO_MIMES[suffix]
    return {'name':path,'bytes':data,'kind':kind,'mime':mime,'sha256':hashlib.sha256(data).hexdigest()}

def read_folder_archive(data,entry):
    if not isinstance(data,bytes) or not data or len(data)>MAX_FOLDER_BYTES:raise ArticleImportError('文章文件夹总大小不能超过 256 MiB')
    entry=safe_folder_path(entry)
    if '/' in entry or PurePosixPath(entry).suffix.lower() not in ('.md','.markdown'):raise ArticleImportError('请选择文件夹根目录的一篇 Markdown 正文')
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            entries=z.infolist()
            if len(entries)>MAX_FOLDER_FILES:raise ArticleImportError('文章文件夹最多包含 512 个文件')
            total=0;seen=set();files={}
            for item in entries:
                path=safe_folder_path(item.filename)
                if item.orig_filename!=item.filename or path.casefold() in seen:raise ArticleImportError('文件夹包含重复或大小写冲突的附件路径')
                seen.add(path.casefold())
                if path!=entry:safe_attachment_path(path)
                if stat.S_IFMT((item.external_attr>>16)&0xffff) not in (0,stat.S_IFREG):raise ArticleImportError('文件夹不能包含链接或特殊文件')
                if item.flag_bits&1 or item.compress_type not in (zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED):raise ArticleImportError('不支持加密或特殊压缩的文章文件夹')
                limit=6*1024*1024 if path==entry else MAX_ATTACHMENT_BYTES
                total+=item.file_size
                if item.file_size>limit or total>MAX_FOLDER_BYTES or item.file_size>max(1,item.compress_size)*200:raise ArticleImportError('附件大小或展开大小超过限制')
            for item in entries:
                with z.open(item) as stream:raw=stream.read(item.file_size+1)
                if len(raw)!=item.file_size:raise ArticleImportError('附件长度不匹配')
                files[item.filename]=raw
            if entry not in files:raise ArticleImportError('文件夹缺少选定的 Markdown 正文')
            return files
    except ArticleImportError:raise
    except (OSError,ValueError,RuntimeError,zipfile.BadZipFile,EOFError) as exc:raise ArticleImportError('文章文件夹传输包损坏') from exc

def prepare_folder_import(data,entry,folder=''):
    files=read_folder_archive(data,entry)
    content=_text(files[entry]);assets=[]
    for name,raw in files.items():
        if name!=entry:assets.append(validate_attachment(name,raw))
    by_path={a['name']:a for a in assets};first_image='';remote=[]
    for _start,_end,source in _image_references(content):
        if _url_kind(source)=='remote':remote.append(source);continue
        try:relative=unquote(urlsplit(source).path)
        except ValueError as exc:raise ArticleImportError('正文图片路径无效') from exc
        if relative.startswith('./'):relative=relative[2:]
        safe_attachment_path(relative)
        if relative not in by_path:raise ArticleImportError('正文引用的图片未包含在 assets/ 中：'+relative)
        if by_path[relative]['kind'] not in ('image','video'):raise ArticleImportError('Markdown 图片引用必须指向真实图片或视频：'+relative)
        if by_path[relative]['kind']=='image' and not first_image:first_image=relative
    from server_preflight import _local_attachment_links
    for _start,_end,relative in _local_attachment_links(_protected_markdown(content)[0],'',all_local=True):
        safe_attachment_path(relative)
        if relative not in by_path:raise ArticleImportError('正文引用的附件未包含在 assets/ 中：'+relative)
    masked=_protected_markdown(content)[0]
    for tag in re.finditer(r'<(?:video|audio|source)\b[^>]{0,8192}>',masked,re.I):
        for attribute in re.finditer(r'''\b(src|poster)\s*=\s*(?:(["'])(.*?)\2|([^\s>]+))''',tag[0],re.I|re.S):
            source=html.unescape(attribute[3] if attribute[3] is not None else attribute[4])
            if _url_kind(source)=='remote':continue
            relative=unquote(urlsplit(source).path)
            if relative.startswith('./'):relative=relative[2:]
            safe_attachment_path(relative)
            if relative not in by_path:raise ArticleImportError('正文引用的媒体或封面附件缺失：'+relative)
            if attribute[1].lower()=='poster' and by_path[relative]['kind']!='image':raise ArticleImportError('视频封面必须指向图片附件：'+relative)
    counts=_counts(content);now=datetime.now(timezone.utc).isoformat();digest=hashlib.sha256(data).hexdigest()
    metadata=_front_metadata(content)
    heading=re.search(r'^ {0,3}#\s+(.+?)\s*#*\s*$',_protected_markdown(content)[0],re.M)
    title=metadata.get('title') or (heading[1] if heading else PurePosixPath(entry).stem)
    metadata.update(title=title,imported_at=now,import_fingerprint=digest,import_kind='folder')
    if first_image:metadata.setdefault('cover',first_image)
    kinds={kind:sum(a['kind']==kind for a in assets) for kind in ('image','video','attachment')}
    warnings=[]
    if remote:warnings.append('正文仍含网络图片；同步前需要下载为本地素材。')
    if kinds['video']:warnings.append('视频已随文章保存，可在编辑器预览；公众号正文视频需要在公众号后台插入。')
    report={'status':'needs_review' if warnings else 'ready','before':counts,'after':counts,'asset_count':len(assets),
            'image_count':kinds['image'],'video_count':kinds['video'],'attachment_count':kinds['attachment'],
            'missing_images':[],'remote_images':list(dict.fromkeys(remote)),'warnings':warnings,'errors':[],
            'conversions':[],'entry':entry,'folder':str(folder)[:255],
            'provenance':{'filename':entry,'kind':'folder','sha256':digest,'imported_at':now}}
    return {'content':content,'title':title,'metadata':metadata,'assets':assets,'report':report,
            'source_original':{'filename':PurePosixPath(entry).stem+'.zip','bytes':data,'kind':'folder','sha256':digest}}
