"""
wechat_archive - 登录模块
通过 Selenium 模拟登录 mp.weixin.qq.com，扫码鉴权后提取 Cookie
支持 Cookie 缓存复用，避免每次重新扫码
"""

import os
import json
import pickle
import re
import time
import shutil
from typing import Optional

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.edge.options import Options as EdgeOptions
from selenium.webdriver.chrome.service import Service

# ---------------------------------------------------------------------------
# 公众号后台 URL 常量
# ---------------------------------------------------------------------------
WECHAT_MP_URL = "https://mp.weixin.qq.com/"
WECHAT_ARTICLE_LIST_URL = (
    "https://mp.weixin.qq.com/cgi-bin/appmsg?"
    "token={token}&lang=zh_CN&f=json&action=list_ex&"
    "begin={page}&count=5&query=&fakeid={fakeid}&type=9"
)

# Cookie 缓存路径（项目运行目录）
DEFAULT_COOKIE_CACHE_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".cache")
COOKIE_CACHE_FILE = os.path.abspath(
    os.environ.get(
        "WECHAT_COOKIE_FILE",
        os.path.join(DEFAULT_COOKIE_CACHE_DIR, "wechat_cookies.pkl"),
    )
)
COOKIE_CACHE_DIR = os.path.dirname(COOKIE_CACHE_FILE)


def extract_backend_identifiers(current_url: str, page_source: str = "") -> tuple[str, str]:
    """Extract management identifiers without logging or exposing their values."""
    token_match = None
    fakeid_match = None

    token_patterns = (
        r"(?:[?&]|\b)token=(\d+)",
        r'"token"\s*:\s*"?([0-9]+)"?',
        r"token\s*[:=]\s*\"?([0-9]+)\"?",
    )
    fakeid_patterns = (
        r"(?:[?&]|\b)fakeid=([a-zA-Z0-9_\-]+)",
        r'["\']fakeid["\']\s*[:=]\s*["\']([^"\']+)["\']',
        r'"fakeid"\s*:\s*"([^"]+)"',
        r"fakeid\s*[:=]\s*['\"]([^'\"]+)['\"]",
        r'"biz"\s*:\s*"([^"]+)"',
    )

    for pattern in token_patterns:
        token_match = re.search(pattern, current_url)
        if token_match:
            break

    if not token_match:
        for pattern in token_patterns:
            token_match = re.search(pattern, page_source or "")
            if token_match:
                break

    for pattern in fakeid_patterns:
        fakeid_match = re.search(pattern, current_url)
        if fakeid_match:
            break

    if not fakeid_match:
        for pattern in fakeid_patterns:
            fakeid_match = re.search(pattern, page_source or "")
            if fakeid_match:
                break
    return (
        token_match.group(1) if token_match else "",
        fakeid_match.group(1) if fakeid_match else "",
    )


# ---------------------------------------------------------------------------
# Chrome 浏览器初始化
# ---------------------------------------------------------------------------

def _configure_chromium_options(opts, config: dict):
    opts.add_argument("--start-maximized")
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_argument("--no-first-run")
    opts.add_argument("--no-default-browser-check")
    opts.add_argument("--disable-notifications")
    opts.add_argument("--disable-popup-blocking")
    if os.name == "nt":
        opts.add_argument(
            "user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        )
    else:
        opts.add_argument(
            "user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        )
    # 排除自动化检测特征
    opts.add_experimental_option("excludeSwitches", ["enable-automation"])
    opts.add_experimental_option("useAutomationExtension", False)

    # 用户数据目录（如果指定，可复用浏览器会话）
    user_data_dir = config.get("user_data_dir", "")
    if user_data_dir:
        opts.add_argument(f"--user-data-dir={user_data_dir}")

    # 是否无头（首次登录建议 false，因为需要扫码）
    if config.get("headless", False):
        opts.add_argument("--headless=new")

    return opts


def _build_chrome_options(config: dict) -> Options:
    return _configure_chromium_options(Options(), config)


def _build_edge_options(config: dict) -> EdgeOptions:
    return _configure_chromium_options(EdgeOptions(), config)


def browser_candidate_names(platform_name: str | None = None) -> tuple[str, ...]:
    """Return visible browser fallbacks in launch order."""
    platform_name = platform_name or os.name
    return ("Chrome", "Microsoft Edge") if platform_name == "nt" else ("Chrome",)


def _resolve_driver_path(browser: str, browser_cfg: dict) -> str:
    """Return a local driver executable path from env/config if available."""
    if browser == "Chrome":
        cfg_key = "chromedriver_path"
        env_key = "WECHAT_CHROMEDRIVER_PATH"
        candidate_bins = ("chromedriver", "chromedriver.exe")
    else:
        cfg_key = "edgedriver_path"
        env_key = "WECHAT_EDGEDRIVER_PATH"
        candidate_bins = ("msedgedriver", "msedgedriver.exe")

    configured = browser_cfg.get(cfg_key, "") or os.environ.get(env_key, "")
    configured = str(configured).strip()
    if configured:
        candidate = os.path.expanduser(os.path.expandvars(configured))
        if os.path.isfile(candidate):
            return candidate

    which_bin = shutil.which(candidate_bins[0]) or shutil.which(candidate_bins[1])
    return which_bin or ""


def _resolve_browser_binary(browser: str) -> str:
    """Return an installed browser binary path on Windows when available."""
    if os.name != "nt":
        return ""

    if browser == "Chrome":
        return (
            os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe")
            if os.path.exists(os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"))
            else (
                os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe")
                if os.path.exists(os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"))
                else ""
            )
        )

    return (
        os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe")
        if os.path.exists(os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"))
        else (
            os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe")
            if os.path.exists(os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"))
            else ""
        )
    )


def _focus_login_window(driver) -> None:
    """Keep the Selenium window on 微信公众平台登录页 and close obvious junk tabs."""
    try:
        handles = list(driver.window_handles)
    except Exception:
        return

    if not handles:
        return

    for handle in handles:
        try:
            driver.switch_to.window(handle)
            url = (driver.current_url or "").lower()
            if "mp.weixin.qq.com" in url:
                return
        except Exception:
            continue

    for handle in list(handles):
        try:
            driver.switch_to.window(handle)
            url = (driver.current_url or "").lower()
            if url.startswith(("data:", "about:blank", "chrome://")) and len(handles) > 1:
                try:
                    driver.close()
                except Exception:
                    pass
        except Exception:
            pass

    if driver.window_handles:
        try:
            driver.switch_to.window(driver.window_handles[0])
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Core: 登录并获取 Cookie
# ---------------------------------------------------------------------------

def login_and_get_cookies(config: dict) -> Optional[dict]:
    """
    登录公众号后台，返回 Cookie 字典。
    - 优先尝试从缓存加载已保存的 Cookie
    - 缓存失效则打开浏览器引导用户扫码
    - 扫码成功后将 Cookie 序列化到本地
    """
    # 1) 尝试加载缓存 Cookie
    cached = _load_cached_cookies()
    if cached:
        print("[登录] 发现缓存的 Cookie，尝试复用…")
        if _validate_cookies(cached):
            print("[登录] Cookie 有效，跳过扫码步骤")
            return cached
        else:
            print("[登录] Cookie 已过期，需要重新登录")

    # 2) 启动浏览器，引导扫码
    print("\n" + "=" * 60)
    print("  请在弹出的浏览器窗口中用管理员微信扫码登录")
    print("  扫码完成后页面会自动跳转，请等待加载完成")
    print("=" * 60 + "\n")

    driver = _start_browser(config)
    try:
        driver.get(WECHAT_MP_URL)
        _focus_login_window(driver)
        print("[登录] 扫码页已打开，等待管理员扫码")
        wait = WebDriverWait(driver, 120)  # 最长 2 分钟等待登录

        # 等待登录成功的标志：页面标题包含「首页」或「公众号」
        try:
            wait.until(
                lambda d: "首页" in d.title or "公众号" in d.title
                or "cgi-bin/home" in d.current_url
            )
        except Exception:
            print("[登录] 扫码等待超时，请重新开始归档")
            return None

        time.sleep(2)
        cookies = driver.get_cookies()
        cookie_dict = {c["name"]: c["value"] for c in cookies}

        # token/fakeid are commonly present in the management page rather than
        # browser cookies. Capture them before closing this first login window,
        # so the caller does not need to launch a second interactive browser.
        token, fakeid = extract_backend_identifiers(
            driver.current_url, driver.page_source
        )
        if token:
            cookie_dict["token"] = token
        if fakeid:
            cookie_dict["fakeid"] = fakeid

        # 3) 保存 Cookie
        _save_cookies(cookies)
        if token and fakeid:
            inject_token_to_cache(token, fakeid)
        print(f"[登录] 登录成功，共获取 {len(cookies)} 个 Cookie")
        return cookie_dict

    except Exception as e:
        print(f"[登录] 登录失败: {e}")
        return None
    finally:
        driver.quit()


def login_and_get_driver(config: dict):
    """
    登录并返回已登录状态的 WebDriver 实例（用于后续 API 调用）。
    流程与 login_and_get_cookies 类似，但不退出浏览器。
    """
    # 先尝试 Cookie 注入
    cached = _load_cached_cookies()
    if cached:
        driver = _start_browser(config)
        driver.get(WECHAT_MP_URL)
        _focus_login_window(driver)
        for cookie_data in _load_cached_cookies_raw():
            try:
                driver.add_cookie(cookie_data)
            except Exception:
                pass
        driver.get(WECHAT_MP_URL)
        time.sleep(3)
        if "cgi-bin/home" in driver.current_url or "首页" in driver.title:
            print("[登录] Cookie 注入成功，无需扫码")
            return driver

        # Cookie 无效，需要扫码
        driver.quit()

    # 启动新浏览器引导扫码
    print("\n" + "=" * 60)
    print("  请在弹出的浏览器窗口中用管理员微信扫码登录")
    print("  扫码完成后页面会自动跳转")
    print("=" * 60 + "\n")

    driver = _start_browser(config)
    driver.get(WECHAT_MP_URL)
    _focus_login_window(driver)
    print("[登录] 扫码页已打开，等待管理员扫码")
    try:
        WebDriverWait(driver, 120).until(
            lambda d: "cgi-bin/home" in d.current_url or "首页" in d.title
        )
        time.sleep(2)
    except Exception:
        driver.quit()
        raise RuntimeError("扫码等待超时，请重新开始归档")

    # 保存 Cookie
    cookies = driver.get_cookies()
    _save_cookies(cookies)
    return driver


# ---------------------------------------------------------------------------
# Cookie 管理
# ---------------------------------------------------------------------------

def _load_cached_cookies() -> Optional[dict]:
    """加载缓存的 Cookie 为字典"""
    if not os.path.exists(COOKIE_CACHE_FILE):
        return None
    try:
        with open(COOKIE_CACHE_FILE, "rb") as f:
            cookies_list = pickle.load(f)
        return {c["name"]: c["value"] for c in cookies_list}
    except (EOFError, pickle.UnpicklingError, IOError):
        return None


def _load_cached_cookies_raw() -> list:
    """加载缓存的 Cookie 原始列表（含 domain 等字段，用于 Selenium 注入）"""
    if not os.path.exists(COOKIE_CACHE_FILE):
        return []
    try:
        with open(COOKIE_CACHE_FILE, "rb") as f:
            return pickle.load(f)
    except (EOFError, pickle.UnpicklingError, IOError):
        return []


def _save_cookies(cookies_list: list):
    """序列化 Cookie 到本地缓存"""
    os.makedirs(COOKIE_CACHE_DIR, exist_ok=True)
    with open(COOKIE_CACHE_FILE, "wb") as f:
        pickle.dump(cookies_list, f)
    print(f"[登录] Cookie 已缓存至 {COOKIE_CACHE_FILE}")


def _validate_cookies(cookie_dict: dict) -> bool:
    """简单校验 Cookie 有效性（检查关键字段是否存在）"""
    required = ["token", "fakeid"]
    return all(k in cookie_dict for k in required)


def clear_cookie_cache():
    """清除缓存的 Cookie，强制重新登录"""
    if os.path.exists(COOKIE_CACHE_FILE):
        os.remove(COOKIE_CACHE_FILE)
        print("[登录] Cookie 缓存已清除")


def extract_token_and_fakeid(cookie_dict: dict) -> tuple:
    """从 Cookie 中提取 token 和 fakeid"""
    token = cookie_dict.get("token", "")
    fakeid = cookie_dict.get("fakeid", "")
    return token, fakeid


def inject_token_to_cache(token: str, fakeid: str):
    """将 token/fakeid 写入缓存的 Cookie 文件。
    这些值在第一次扫码登录后从页面 URL 提取，写回缓存后下次无需再弹浏览器。
    """
    if not os.path.exists(COOKIE_CACHE_FILE):
        return
    try:
        with open(COOKIE_CACHE_FILE, "rb") as f:
            cookies_list = pickle.load(f)
    except Exception:
        return

    # 移除旧值（如果有）
    cookies_list = [c for c in cookies_list if c["name"] not in ("token", "fakeid")]

    # 添加新值
    for name, value in [("token", token), ("fakeid", fakeid)]:
        cookies_list.append({
            "name": name,
            "value": value,
            "domain": ".mp.weixin.qq.com",
            "path": "/",
        })

    with open(COOKIE_CACHE_FILE, "wb") as f:
        pickle.dump(cookies_list, f)
    print(f"[登录] token/fakeid 已注入 Cookie 缓存")


# ---------------------------------------------------------------------------
# 浏览器启动（支持 webdriver-manager 自动下载 + 指定路径兜底）
# ---------------------------------------------------------------------------

def _start_browser(config: dict):
    browser_cfg = config.get("browser", {})
    attempts = [("Chrome", lambda: _start_chrome(config, _build_chrome_options(browser_cfg)))]
    if os.name == "nt":
        attempts.append(("Microsoft Edge", lambda: _start_edge(config, _build_edge_options(browser_cfg))))

    driver = None
    failures = []
    for name, launch in attempts:
        print(f"[登录] 正在启动{name}…")
        try:
            driver = launch()
            print(f"[登录] {name}已启动，正在加载扫码页")
            break
        except (Exception, SystemExit) as exc:
            failures.append(f"{name}: {type(exc).__name__}: {exc}")
            if name == "Chrome" and os.name == "nt":
                print("[登录] Chrome启动失败，自动尝试Microsoft Edge…")

    if driver is None:
        detail = "；".join(failures) or "没有可用浏览器"
        print(f"[登录] 浏览器启动失败：{detail}")
        raise RuntimeError("无法启动Chrome或Microsoft Edge，请确认浏览器已安装并允许程序启动")

    driver.set_page_load_timeout(
        config.get("browser", {}).get("page_load_timeout", 30)
    )
    driver.implicitly_wait(config.get("browser", {}).get("implicit_wait", 10))

    # 注入反检测脚本
    try:
        driver.execute_cdp_cmd(
            "Page.addScriptToEvaluateOnNewDocument",
            {
                "source": """
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => undefined
                });
                """
            },
        )
    except Exception:
        pass  # CDP 注入失败不影响核心功能

    return driver


def _start_chrome(config: dict, opts: Options):
    browser_cfg = config.get("browser", {})
    driver_path = _resolve_driver_path("Chrome", browser_cfg)
    if driver_path:
        return webdriver.Chrome(service=Service(executable_path=driver_path), options=opts)
    try:
        return webdriver.Chrome(options=opts)
    except Exception:
        if os.name == "nt":
            return _start_chrome_with_fallback(config, opts)
        return _start_chrome_with_fallback(config, opts)


def _start_edge(config: dict, opts: EdgeOptions):
    browser_cfg = config.get("browser", {})
    browser_binary = _resolve_browser_binary("Microsoft Edge")
    if browser_binary:
        opts.binary_location = browser_binary
    driver_path = _resolve_driver_path("Microsoft Edge", browser_cfg)
    if driver_path:
        from selenium.webdriver.edge.service import Service as EdgeService

        return webdriver.Edge(service=EdgeService(executable_path=driver_path), options=opts)
    try:
        return webdriver.Edge(options=opts)
    except Exception:
        return _start_edge_with_fallback(config, opts)


def _start_chrome_with_fallback(config: dict, opts) -> webdriver.Chrome:
    """尝试多种方式获取 ChromeDriver"""
    browser_cfg = config.get("browser", {})
    driver_path = _resolve_driver_path("Chrome", browser_cfg)
    try:
        from selenium.webdriver.chrome.service import Service

        service = Service(executable_path=driver_path) if driver_path else None
        if service:
            return webdriver.Chrome(service=service, options=opts)
        from webdriver_manager.chrome import ChromeDriverManager
        from selenium.webdriver.chrome.service import Service

        print("[启动] 正在通过 webdriver-manager 自动下载 ChromeDriver…")
        driver_path = ChromeDriverManager().install()
        service = Service(executable_path=driver_path)
        return webdriver.Chrome(service=service, options=opts)
    except Exception as e:
        print(f"[启动] webdriver-manager 也失败了: {e}")

    raise RuntimeError("无法自动获取ChromeDriver")


def _start_edge_with_fallback(config: dict, opts) -> webdriver.Edge:
    """尝试多种方式获取 EdgeDriver"""
    browser_cfg = config.get("browser", {})
    driver_path = _resolve_driver_path("Microsoft Edge", browser_cfg)
    if driver_path:
        from selenium.webdriver.edge.service import Service as EdgeService

        return webdriver.Edge(service=EdgeService(executable_path=driver_path), options=opts)
    try:
        from selenium.webdriver.edge.service import Service as EdgeService

        if os.name == "nt":
            return webdriver.Edge(options=opts)
        return webdriver.Edge(options=opts)
    except Exception as edge_exc:
        print(f"[启动] 原生 EdgeDriver 启动失败: {edge_exc}")
    try:
        from webdriver_manager.microsoft import EdgeChromiumDriverManager
        from selenium.webdriver.edge.service import Service as EdgeService

        print("[启动] 正在通过 webdriver-manager 自动下载 EdgeDriver…")
        driver_path = EdgeChromiumDriverManager().install()
        service = EdgeService(executable_path=driver_path)
        return webdriver.Edge(service=service, options=opts)
    except Exception as e:
        print(f"[启动] webdriver-manager Edge 获取失败: {e}")

    raise RuntimeError("无法自动获取EdgeDriver")
