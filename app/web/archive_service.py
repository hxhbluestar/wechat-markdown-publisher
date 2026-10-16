"""Secret-free task wrapper around the existing local WeChat archiver.

The browser login and management-session requests stay in ``main.py``. This
module launches that command, publishes coarse progress to the local editor,
and handles cancellation and local session cleanup. Cookies and tokens are
never returned by its public status snapshot.
"""

from __future__ import annotations

import importlib.util
import json
import os
import queue
import re
import signal
import subprocess
import sys
import threading
import time
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


ACTIVE_STATUSES = {
    "starting",
    "waiting_scan",
    "loading_articles",
    "loading_stats",
    "downloading",
    "finalizing",
    "canceling",
}
ACCOUNT_NAME_INVALID = re.compile(r"[\\/:*?\"<>|\x00-\x1f\x7f]")
DOWNLOAD_LINE = re.compile(r"\[(?P<current>\d+)/(?P<total>\d+)\]\s*(?P<title>.+?)\.{0,3}$")
LIST_TOTAL_LINE = re.compile(r"公众号共有\s*(?P<total>\d+)\s*篇文章")
LIST_DONE_LINE = re.compile(r"共获取\s*(?P<total>\d+)\s*篇文章")
SUMMARY_LINE = re.compile(
    r"下载完成:\s*(?P<completed>\d+)\s*成功,\s*(?P<failed>\d+)\s*失败,\s*(?P<skipped>\d+)\s*跳过"
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class ArchiveTaskError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def normalize_options(payload: dict[str, Any], output_dir: Path) -> dict[str, Any]:
    name = str(payload.get("account_name") or "").strip()
    if not name or len(name) > 60:
        raise ArchiveTaskError("请填写公众号名称，且不要超过 60 个字")
    if name in {".", ".."} or ACCOUNT_NAME_INVALID.search(name):
        raise ArchiveTaskError("公众号名称包含不能用于文件夹的字符")

    return {
        "account_name": name,
        "output_dir": str(output_dir),
        "fresh_login": bool(payload.get("fresh_login", True)),
        "clear_session_after": bool(payload.get("clear_session_after", True)),
        "download_images": bool(payload.get("download_images", True)),
        "download_audio": bool(payload.get("download_audio", True)),
        "download_video": bool(payload.get("download_video", True)),
        "download_comments": bool(payload.get("download_comments", False)),
        "download_stats": bool(payload.get("download_stats", False)),
    }


def initial_snapshot(output_dir: Path, cookie_file: Path) -> dict[str, Any]:
    return {
        "available": True,
        "missing_dependencies": [],
        "status": "idle",
        "running": False,
        "phase": "准备就绪",
        "message": "填写公众号名称后，打开扫码窗口开始归档。",
        "account_name": "",
        "current_title": "",
        "current": 0,
        "total": 0,
        "completed": 0,
        "failed": 0,
        "skipped": 0,
        "progress": 0,
        "output_dir": str(output_dir),
        "archive_dir": "",
        "error": "",
        "started_at": "",
        "updated_at": utc_now(),
        "finished_at": "",
        "session_cached": cookie_file.is_file(),
        "job_id": "",
    }


def apply_output_line(snapshot: dict[str, Any], raw_line: str) -> None:
    """Update one public snapshot from a sanitized command-output line."""
    line = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]", "", raw_line).strip()
    if not line:
        return

    if "阶段 1/5: 登录公众号后台" in line:
        snapshot.update(
            status="starting",
            phase="启动本机浏览器",
            message="正在查找并启动 Chrome；Windows 会在失败时自动尝试 Microsoft Edge。",
        )
    elif "Chrome启动失败，自动尝试Microsoft Edge" in line:
        snapshot.update(
            status="starting",
            phase="改用 Microsoft Edge",
            message="Chrome 无法启动，正在自动尝试 Windows 自带的 Microsoft Edge。",
        )
    elif "已启动，正在加载扫码页" in line:
        snapshot.update(
            status="starting",
            phase="加载公众号登录页",
            message="浏览器已经启动，正在加载微信公众平台扫码页面。",
        )
    elif "扫码页已打开，等待管理员扫码" in line:
        snapshot.update(
            status="waiting_scan",
            phase="等待扫码登录",
            message="扫码页面已打开，请使用目标公众号管理员微信扫码。",
        )
    elif "系统浏览器弹窗已尝试打开" in line:
        snapshot.update(
            status="starting",
            phase="弹出系统浏览器",
            message="本地浏览器驱动启动受限，已尝试在系统浏览器打开微信公众平台，请完成扫码后重试。",
        )
    elif "Cookie 有效，跳过扫码步骤" in line:
        snapshot.update(
            status="loading_articles",
            phase="恢复本机登录",
            message="已使用本机缓存会话，正在读取文章列表。",
        )
    elif "登录成功" in line:
        snapshot.update(
            status="loading_articles",
            phase="读取文章列表",
            message="登录成功，正在分页读取历史文章。",
        )
    elif "阶段 2/5: 获取全量历史文章列表" in line:
        snapshot.update(
            status="loading_articles",
            phase="读取文章列表",
            message="正在分页读取全部历史文章。",
        )
    elif match := LIST_TOTAL_LINE.search(line):
        snapshot["total"] = int(match.group("total"))
        snapshot["message"] = f"已识别 {snapshot['total']} 篇文章，正在完成列表读取。"
    elif match := LIST_DONE_LINE.search(line):
        snapshot["total"] = int(match.group("total"))
        snapshot["message"] = f"文章列表读取完成，共 {snapshot['total']} 篇。"
    elif "阶段 3/5: 获取文章阅读数据" in line:
        snapshot.update(
            status="loading_stats",
            phase="读取文章数据",
            message="正在读取可用的阅读数据。",
        )
    elif "阶段 4/5: 下载文章正文与资源" in line:
        snapshot.update(
            status="downloading",
            phase="下载文章与素材",
            message="正在下载正文、封面和文章素材。",
        )
    elif snapshot.get("status") in {"downloading", "loading_stats"} and (
        match := DOWNLOAD_LINE.search(line)
    ):
        current = int(match.group("current"))
        total = int(match.group("total"))
        title = match.group("title").strip(" .")
        snapshot.update(current=current, total=total, current_title=title)
        snapshot["progress"] = min(99, round(current * 100 / max(1, total)))
        if snapshot.get("status") == "downloading":
            snapshot["message"] = f"正在处理第 {current}/{total} 篇：{title}"
    elif match := SUMMARY_LINE.search(line):
        snapshot.update(
            completed=int(match.group("completed")),
            failed=int(match.group("failed")),
            skipped=int(match.group("skipped")),
        )
    elif "阶段 5/5: 生成索引与归档说明" in line:
        snapshot.update(
            status="finalizing",
            phase="生成索引",
            message="正文与素材处理完成，正在生成索引和归档说明。",
            progress=99,
        )
    elif "未获取到任何文章" in line:
        snapshot["error"] = "没有读取到文章。请确认扫码登录的是目标公众号，并重新尝试。"
    elif "登录失败" in line:
        snapshot["error"] = "扫码登录未完成或登录窗口异常关闭，请重新尝试。"
    elif "浏览器启动失败" in line:
        snapshot["error"] = "无法启动 Chrome 或 Microsoft Edge。请确认浏览器已安装，并允许程序和 Selenium Manager 运行。"
    elif "扫码等待超时" in line:
        snapshot["error"] = "等待扫码超时。请重新开始归档，并在扫码页面出现后 2 分钟内完成登录。"
    snapshot["updated_at"] = utc_now()


Runner = Callable[[dict[str, Any], Callable[[str], None], threading.Event], int]


class ArchiveTaskManager:
    """Own one local archive job and expose a secret-free status snapshot."""

    def __init__(
        self,
        project_dir: Path,
        *,
        output_dir: Path | None = None,
        runner: Runner | None = None,
    ) -> None:
        self.project_dir = project_dir.resolve()
        configured_output = output_dir or Path(
            os.environ.get("WECHAT_IMPORT_DIR", self.project_dir / "output")
        )
        self.output_dir = configured_output.resolve()
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.private_dir = Path(
            os.environ.get(
                "WECHAT_ARCHIVE_JOB_DIR",
                self.project_dir / "knowledge_base" / "private" / "archive-jobs",
            )
        ).resolve()
        self.private_dir.mkdir(parents=True, exist_ok=True)
        self.cookie_file = Path(
            os.environ.get(
                "WECHAT_COOKIE_FILE",
                self.project_dir / ".cache" / "wechat_cookies.pkl",
            )
        ).resolve()
        self.log_dir = Path(
            os.environ.get("WECHAT_ARCHIVE_LOG_DIR", self.project_dir / "logs")
        ).resolve()
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self._runner = runner or self._run_subprocess
        self._lock = threading.RLock()
        self._cancel = threading.Event()
        self._thread: threading.Thread | None = None
        self._snapshot = initial_snapshot(self.output_dir, self.cookie_file)
        self._apply_availability()

    def _apply_availability(self) -> None:
        missing: list[str] = []
        if not (self.project_dir / "main.py").is_file():
            missing.append("归档程序")
        for module, label in (
            ("selenium", "Selenium"),
            ("yaml", "PyYAML"),
            ("bs4", "BeautifulSoup"),
            ("markdownify", "Markdown 转换器"),
            ("requests", "Requests"),
        ):
            if importlib.util.find_spec(module) is None:
                missing.append(label)
        self._snapshot["missing_dependencies"] = missing
        self._snapshot["available"] = not missing
        if missing:
            self._snapshot["phase"] = "归档组件未就绪"
            self._snapshot["message"] = "缺少组件：" + "、".join(missing)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            result = deepcopy(self._snapshot)
            result["session_cached"] = self.cookie_file.is_file()
            result["running"] = result["status"] in ACTIVE_STATUSES
            return result

    def start(self, payload: dict[str, Any]) -> dict[str, Any]:
        options = normalize_options(payload, self.output_dir)
        with self._lock:
            if not self._snapshot["available"]:
                raise ArchiveTaskError(self._snapshot["message"], 503)
            if self._snapshot["status"] in ACTIVE_STATUSES:
                raise ArchiveTaskError("已有归档任务正在运行，请等待完成或先取消", 409)
            if options["fresh_login"]:
                self._clear_cookie_file()

            job_id = uuid.uuid4().hex[:12]
            archive_dir = self.output_dir / f"{options['account_name']}_公众号全量归档"
            self._snapshot = {
                **initial_snapshot(self.output_dir, self.cookie_file),
                "status": "starting",
                "running": True,
                "phase": "启动本机浏览器",
                "message": "正在启动 Chrome；Windows 会在失败时自动尝试 Microsoft Edge。",
                "account_name": options["account_name"],
                "archive_dir": str(archive_dir),
                "started_at": utc_now(),
                "job_id": job_id,
            }
            self._cancel = threading.Event()
            self._thread = threading.Thread(
                target=self._execute,
                args=(options,),
                daemon=True,
                name=f"wechat-archive-{job_id}",
            )
            self._thread.start()
            return self.snapshot()

    def cancel(self) -> dict[str, Any]:
        with self._lock:
            if self._snapshot["status"] not in ACTIVE_STATUSES:
                raise ArchiveTaskError("当前没有正在运行的归档任务", 409)
            self._cancel.set()
            self._snapshot.update(
                status="canceling",
                phase="正在停止",
                message="正在安全停止任务，已经保存的文章不会删除。",
                updated_at=utc_now(),
            )
            return self.snapshot()

    def clear_session(self) -> dict[str, Any]:
        with self._lock:
            if self._snapshot["status"] in ACTIVE_STATUSES:
                raise ArchiveTaskError("请先停止正在运行的归档任务", 409)
            self._clear_cookie_file()
            self._snapshot["session_cached"] = False
            self._snapshot["updated_at"] = utc_now()
            return self.snapshot()

    def open_output(self) -> dict[str, str]:
        with self._lock:
            raw_archive_dir = str(self._snapshot.get("archive_dir") or "")
            archive_dir = Path(raw_archive_dir) if raw_archive_dir else self.output_dir
            target = archive_dir if archive_dir.is_dir() else self.output_dir
        if target != self.output_dir and self.output_dir not in target.parents:
            raise ArchiveTaskError("归档目录无效", 400)
        try:
            if sys.platform == "darwin":
                subprocess.Popen(["open", str(target)])
            elif os.name == "nt":
                subprocess.Popen(["explorer.exe", str(target)])
            else:
                subprocess.Popen(["xdg-open", str(target)])
        except OSError as exc:
            raise ArchiveTaskError("无法打开归档目录，请按页面显示的路径手动打开", 500) from exc
        return {"path": str(target)}

    def _clear_cookie_file(self) -> None:
        try:
            self.cookie_file.unlink(missing_ok=True)
        except OSError as exc:
            raise ArchiveTaskError("无法清除旧的公众号登录信息，请关闭扫码窗口后重试", 500) from exc

    def _emit(self, line: str) -> None:
        if "token:" in line.lower() or "fakeid:" in line.lower():
            line = "登录成功，公众号会话已建立"
        with self._lock:
            apply_output_line(self._snapshot, line)

    def _execute(self, options: dict[str, Any]) -> None:
        return_code = 1
        try:
            return_code = self._runner(options, self._emit, self._cancel)
        except Exception as exc:  # pragma: no cover - defensive thread boundary
            with self._lock:
                self._snapshot["error"] = f"归档任务异常：{type(exc).__name__}"
        finally:
            if options.get("clear_session_after"):
                try:
                    self._clear_cookie_file()
                except ArchiveTaskError:
                    pass
            with self._lock:
                cancelled = self._cancel.is_set()
                has_error = bool(self._snapshot.get("error"))
                if cancelled:
                    self._snapshot.update(
                        status="cancelled",
                        phase="已停止",
                        message="任务已停止，已完成的文章和断点记录仍保留。",
                    )
                elif return_code == 0 and not has_error:
                    self._snapshot.update(
                        status="completed",
                        phase="归档完成",
                        message="文章与素材已经保存到本地，可以打开归档目录查看。",
                        progress=100,
                    )
                else:
                    message = self._snapshot.get("error") or "归档进程异常结束，请查看提示后重试。"
                    self._snapshot.update(
                        status="failed",
                        phase="归档未完成",
                        message=message,
                        error=message,
                    )
                self._snapshot.update(
                    running=False,
                    finished_at=utc_now(),
                    updated_at=utc_now(),
                    session_cached=self.cookie_file.is_file(),
                )

    def _run_subprocess(
        self,
        options: dict[str, Any],
        emit: Callable[[str], None],
        cancel: threading.Event,
    ) -> int:
        job_id = str(self._snapshot["job_id"])
        config_path = self.private_dir / f"{job_id}.json"
        log_path = self.log_dir / f"archive-ui-{job_id}.log"
        config = {
            "account_name": options["account_name"],
            "output_dir": options["output_dir"],
            "date_from": "",
            "date_to": "",
            "export": {
                "format": "markdown",
                "download_images": options["download_images"],
                "download_audio": options["download_audio"],
                "download_video": options["download_video"],
                "download_comments": options["download_comments"],
                "download_stats": options["download_stats"],
                "max_workers": 1,
            },
            "browser": {
                "type": "chrome",
                "headless": False,
                "user_data_dir": "",
                "chromedriver_path": "",
                "page_load_timeout": 30,
                "implicit_wait": 10,
            },
            "rate_limit": {
                "min_interval": 0.5,
                "max_interval": 1.5,
                "retry_max": 3,
                "retry_delay": 5,
                "batch_sleep": 5,
            },
            "resume": {"enabled": True, "state_file": ".archive_state.json"},
            "comments": {"max_per_article": 100, "include_replies": True},
        }
        config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2), "utf-8")
        try:
            kwargs: dict[str, Any] = {
                "cwd": str(self.project_dir),
                "stdout": subprocess.PIPE,
                "stderr": subprocess.STDOUT,
                "stdin": subprocess.DEVNULL,
                "text": True,
                "encoding": "utf-8",
                "errors": "replace",
                "bufsize": 1,
                "env": {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONUTF8": "1"},
            }
            if os.name == "nt":
                kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
            else:
                kwargs["start_new_session"] = True
            process = subprocess.Popen(
                [sys.executable, str(self.project_dir / "main.py"), "--config", str(config_path), "--resume"],
                **kwargs,
            )
            lines: queue.Queue[str | None] = queue.Queue()

            def read_output() -> None:
                assert process.stdout is not None
                for line in process.stdout:
                    lines.put(line)
                lines.put(None)

            threading.Thread(target=read_output, daemon=True).start()
            with log_path.open("a", encoding="utf-8") as log_file:
                stream_done = False
                while not stream_done or process.poll() is None:
                    if cancel.is_set() and process.poll() is None:
                        self._terminate_process(process)
                    try:
                        line = lines.get(timeout=0.2)
                    except queue.Empty:
                        continue
                    if line is None:
                        stream_done = True
                        continue
                    log_file.write(line)
                    log_file.flush()
                    emit(line)
            return process.wait(timeout=10)
        finally:
            try:
                config_path.unlink(missing_ok=True)
            except OSError:
                pass

    @staticmethod
    def _terminate_process(process: subprocess.Popen[str]) -> None:
        if process.poll() is not None:
            return
        try:
            if os.name == "nt":
                subprocess.run(
                    ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=8,
                    check=False,
                )
            else:
                os.killpg(process.pid, signal.SIGTERM)
                deadline = time.monotonic() + 5
                while process.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.1)
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
        except (OSError, subprocess.SubprocessError):
            process.terminate()
