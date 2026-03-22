"""
Epic Hyperspace Schedule Capture
================================
Automates: kill Chrome → open PACS in Chrome (with extension) → login via
CDP JavaScript injection → launch Epic → login → dismiss context screen →
select schedule in My Schedule sidebar → type target date → capture clinic
list → screenshot → scroll & capture all rows → OCR → import patients →
extension auto-preloads from PACS overnight.

PACS login uses Chrome DevTools Protocol (CDP) — launches Chrome with
--remote-debugging-port, connects via WebSocket, injects JS to fill the
login form and click submit. No Selenium needed for login.
Epic login uses pyautogui (native Windows app — not a web page).

Designed to run as a nightly Windows Task Scheduler job (9 PM Mon-Fri),
or manually.  Handles the full chain from PACS browser login to patient
import.

Setup:
    pip install pyautogui opencv-python mss pillow requests keyring websocket-client

Usage:
    # Store Epic AND PACS login credentials (one-time):
    python epic_capture.py --setup-credentials

    # Record reference images of Epic UI elements:
    python epic_capture.py --record

    # Capture tomorrow's schedule and import:
    python epic_capture.py

    # Capture a specific date:
    python epic_capture.py --date 2026-03-16

    # Screenshot only, no OCR/import:
    python epic_capture.py --dry-run

    # Skip Epic navigation — just OCR the most recent screenshot:
    python epic_capture.py --ocr-only

    # Use a custom config file:
    python epic_capture.py --config /path/to/config.json

    # Inspect PACS login page to verify CSS selectors:
    python epic_capture.py --inspect-pacs

Templates (saved in ./templates/):
    username_field.png      — Epic login username text field
    password_field.png      — Epic login password text field
    context_screen.png      — Context screen (optional)
    my_schedule_item.png    — Schedule to click in "My Schedule" sidebar
    schedule_title.png      — "Schedule" title (date field clicked below this)
    epic_window.png         — Epic titlebar or logo for finding the window
    table_top_left.png      — Top-left corner of patient list table
    table_top_right.png     — Top-right corner of patient list table
    scroll_end.png          — (optional) visual marker for end of patient list
"""

import argparse
import ctypes
import getpass
import io
import json
import logging
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

import cv2
import mss
import numpy as np
import pyautogui
import requests
from PIL import Image
try:
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options
    from selenium.webdriver.chrome.service import Service
    from selenium.webdriver.common.by import By
    from webdriver_manager.chrome import ChromeDriverManager
    HAS_SELENIUM = True
except ImportError:
    HAS_SELENIUM = False

import keyring

# ── Config ──
CONFIG_PATH = Path(__file__).parent / "config.json"
SERVER_URL = os.environ.get("PACS_SERVER", "http://localhost:8888")
TEMPLATE_DIR = Path(__file__).parent / "templates"
SCREENSHOT_DIR = Path(__file__).parent / "screenshots"
LOG_DIR = Path(__file__).parent / "logs"
CONFIDENCE_THRESHOLD = 0.75   # cv2 template match threshold
CLICK_DELAY = 0.3             # seconds between UI actions
SCHEDULE_LOAD_WAIT = 2.0      # seconds to wait after navigation
SCROLL_PAUSE = 0.8            # seconds to wait after scrolling
MAX_SCROLLS = 20              # safety limit on scroll iterations

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("epic_capture")

pyautogui.FAILSAFE = True     # move mouse to corner to abort
pyautogui.PAUSE = 0.15        # small pause between pyautogui calls


# ─────────────────────────────────────────────
#  Config & credentials
# ─────────────────────────────────────────────

_DEFAULT_CONFIG = {
    "epic": {
        "exe_path": r"C:\Program Files (x86)\Epic\Hyperdrive\VersionIndependent\Hyperspace.exe",
        "exe_args": ["--", "Id=750", "Env=prd", "tz=America/Los_Angeles"],
        "credential_service": "pacs-preloader-epic",
        "launch_timeout": 30,
        "login_timeout": 20,
        "context_screen_wait": 2,
        "post_login_settle": 2.5,
    },
    "pacs": {
        "url": "https://pacs.renoortho.com/InteleBrowser/app",
        "credential_service": "pacs-preloader-pacs",
        "login_timeout": 15,
        "page_load_wait": 2,
        "username_selector": "#username",
        "password_selector": "#password",
    },
}


def load_config(config_path=None):
    """Load config.json, merging with defaults for any missing keys."""
    path = Path(config_path) if config_path else CONFIG_PATH
    config = {}
    if path.exists():
        with open(path) as f:
            config = json.load(f)
        log.info(f"Loaded config from {path}")
    else:
        log.info(f"No config file at {path} — using defaults")

    # Merge defaults
    merged = {}
    for section, defaults in _DEFAULT_CONFIG.items():
        merged[section] = dict(defaults)
        if section in config:
            merged[section].update(config[section])
    return merged


def _store_credentials(label, service_name):
    """Prompt for username/password and store in Windows Credential Manager."""
    print(f"\n=== {label} Credential Setup (service: {service_name}) ===")
    username = input(f"{label} username: ").strip()
    if not username:
        print("Aborted — no username entered.")
        return
    password = getpass.getpass(f"{label} password: ")
    if not password:
        print("Aborted — no password entered.")
        return

    keyring.set_password(service_name, "__username__", username)
    keyring.set_password(service_name, username, password)
    print(f"Credentials stored in Windows Credential Manager (service: {service_name})")

    # Verify retrieval
    stored_user = keyring.get_password(service_name, "__username__")
    stored_pass = keyring.get_password(service_name, stored_user)
    if stored_user == username and stored_pass == password:
        print("Verification: OK — credentials retrieved successfully")
    else:
        print("WARNING: Verification failed — credentials may not have stored correctly")

    # Clear password from memory
    del password, stored_pass


def setup_credentials(config):
    """Interactive: prompt for Epic and PACS credentials."""
    _store_credentials("Epic", config["epic"]["credential_service"])
    _store_credentials("PACS InteleBrowser", config["pacs"]["credential_service"])


# ─────────────────────────────────────────────
#  Epic launch, login, and navigation
# ─────────────────────────────────────────────

def _get_foreground_hwnd():
    """Get the handle and title of the current foreground window."""
    hwnd = ctypes.windll.user32.GetForegroundWindow()
    length = ctypes.windll.user32.GetWindowTextLengthW(hwnd)
    if length > 0:
        buf = ctypes.create_unicode_buffer(length + 1)
        ctypes.windll.user32.GetWindowTextW(hwnd, buf, length + 1)
        return hwnd, buf.value
    return hwnd, ""


def launch_epic(config):
    """Launch Epic Hyperspace if not already running. Returns (hwnd, title).

    Detection priority:
      1. Process-name match (find_epic_window)
      2. Template match (epic_window.png visible on screen) + foreground hwnd
    """
    epic_cfg = config["epic"]

    # Check if already running by process name
    windows = find_epic_window()
    if windows:
        hwnd, title = windows[0]
        log.info(f"Epic already running (process match): '{title}'")
        focus_window(hwnd)
        return hwnd, title

    # Check if already visible via template (process name may differ)
    if find_on_screen("epic_window.png"):
        hwnd, title = _get_foreground_hwnd()
        log.info(f"Epic already visible (template match): '{title}'")
        return hwnd, title

    exe_path = epic_cfg["exe_path"]
    exe_args = epic_cfg["exe_args"]
    timeout = epic_cfg["launch_timeout"]

    log.info(f"Launching Epic: {exe_path}")
    subprocess.Popen([exe_path] + exe_args)

    # Poll for the Epic window — try process match first, then template match
    elapsed = 0
    poll_interval = 2
    while elapsed < timeout:
        time.sleep(poll_interval)
        elapsed += poll_interval

        # Try process-name detection
        windows = find_epic_window()
        if windows:
            hwnd, title = windows[0]
            log.info(f"Epic window appeared after {elapsed}s (process match): '{title}'")
            focus_window(hwnd)
            return hwnd, title

        # Try template detection
        if find_on_screen("epic_window.png"):
            hwnd, title = _get_foreground_hwnd()
            log.info(f"Epic window appeared after {elapsed}s (template match): '{title}'")
            return hwnd, title

    raise RuntimeError(f"Epic window did not appear within {timeout}s")


def login_epic(hwnd, config):
    """Log in to Epic using credentials from Windows Credential Manager."""
    epic_cfg = config["epic"]
    service = epic_cfg["credential_service"]
    timeout = epic_cfg["login_timeout"]

    # Retrieve credentials
    username = keyring.get_password(service, "__username__")
    if not username:
        raise RuntimeError(
            f"No credentials found in keyring service '{service}'. "
            "Run with --setup-credentials first."
        )
    password = keyring.get_password(service, username)
    if not password:
        raise RuntimeError(f"Password not found for user '{username}' in keyring service '{service}'")

    try:
        focus_window(hwnd)
        time.sleep(0.5)

        # Type username
        screen = grab_screen()
        if not click_template("username_field.png", screen=screen):
            raise RuntimeError("Could not find username field on screen")
        pyautogui.typewrite(username, interval=0.05)

        # Type password
        screen = grab_screen()
        if not click_template("password_field.png", screen=screen):
            raise RuntimeError("Could not find password field on screen")
        pyautogui.typewrite(password, interval=0.05)

        # Press Enter to submit login
        pyautogui.press("enter")
        log.info("Pressed Enter to submit login")

        # Wait for login to complete (username field disappears)
        elapsed = 0
        poll_interval = 2
        while elapsed < timeout:
            time.sleep(poll_interval)
            elapsed += poll_interval
            if not find_on_screen("username_field.png"):
                log.info(f"Login completed after {elapsed}s")
                return
        raise RuntimeError(f"Login did not complete within {timeout}s")
    finally:
        # Clear password from memory
        del password


def handle_context_screen(config):
    """Dismiss the Epic context screen by pressing Enter."""
    epic_cfg = config["epic"]
    wait = epic_cfg["context_screen_wait"]
    settle = epic_cfg["post_login_settle"]

    log.info(f"Waiting {wait}s for context screen...")
    time.sleep(wait)
    pyautogui.press("enter")
    log.info(f"Pressed Enter on context screen — waiting {settle}s for schedule to load")
    time.sleep(settle)


# ─────────────────────────────────────────────
#  PACS browser automation (Selenium)
# ─────────────────────────────────────────────

def minimize_window(hwnd):
    """Minimize a window."""
    SW_MINIMIZE = 6
    ctypes.windll.user32.ShowWindow(hwnd, SW_MINIMIZE)
    time.sleep(0.3)


CHROME_DEBUG_PORT = 9224


def _find_chrome_exe():
    """Locate Chrome executable on Windows."""
    for candidate in [
        Path(os.environ.get("PROGRAMFILES", "")) / "Google" / "Chrome" / "Application" / "chrome.exe",
        Path(os.environ.get("PROGRAMFILES(X86)", "")) / "Google" / "Chrome" / "Application" / "chrome.exe",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Google" / "Chrome" / "Application" / "chrome.exe",
    ]:
        if candidate.exists():
            return str(candidate)
    return "chrome"  # hope it's on PATH


def _cdp_send(ws, method, params=None, msg_id=1):
    """Send a CDP command over WebSocket and return the result."""
    import websocket as ws_mod  # websocket-client
    msg = json.dumps({"id": msg_id, "method": method, "params": params or {}})
    ws.send(msg)
    while True:
        reply = json.loads(ws.recv())
        if reply.get("id") == msg_id:
            return reply


def _cdp_eval(ws, expression, msg_id=1):
    """Evaluate JavaScript in the page via CDP and return the result value."""
    reply = _cdp_send(ws, "Runtime.evaluate", {
        "expression": expression,
        "returnByValue": True,
    }, msg_id=msg_id)
    result = reply.get("result", {}).get("result", {})
    return result.get("value")


def open_and_login_pacs(config):
    """Open the user's normal Chrome to PACS and log in via CDP JavaScript.

    Launches the user's real Chrome (with their profile and installed extensions)
    using --remote-debugging-port, then connects via Chrome DevTools Protocol
    to inject JavaScript that fills the login form and clicks submit.  No
    Selenium or chromedriver needed — just raw CDP over WebSocket.

    After login, the WebSocket disconnects and Chrome stays open normally
    with all extensions active.

    Requires no other Chrome windows to be open (otherwise the debug port
    flag is ignored because Chrome merges into the existing process).
    """
    import websocket as ws_mod  # websocket-client

    pacs_cfg = config["pacs"]
    pacs_url = pacs_cfg["url"]
    service_name = pacs_cfg["credential_service"]
    timeout = pacs_cfg["login_timeout"]
    page_load_wait = pacs_cfg["page_load_wait"]
    username_sel = pacs_cfg.get("username_selector", "#username")
    password_sel = pacs_cfg.get("password_selector", "#password")

    # Retrieve credentials
    username = keyring.get_password(service_name, "__username__")
    if not username:
        raise RuntimeError(
            f"No PACS credentials found in keyring service '{service_name}'. "
            "Run with --setup-credentials first."
        )
    password = keyring.get_password(service_name, username)
    if not password:
        raise RuntimeError(
            f"PACS password not found for user '{username}' in keyring service '{service_name}'"
        )

    try:
        # ── Kill any existing Chrome so debug port works ──
        import socket
        try:
            subprocess.run(
                ["taskkill", "/F", "/IM", "chrome.exe"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            log.info("Killed existing Chrome processes")
            time.sleep(2)  # wait for profile lock files to release
        except Exception:
            pass

        # ── Launch Chrome ──
        # Chrome requires --user-data-dir for remote debugging.
        # Use a dedicated profile and load our extension into it.
        debug_port_open = False
        chrome_exe = _find_chrome_exe()
        pacs_profile_dir = str((Path(__file__).parent / ".chrome-pacs-profile").resolve())
        extension_dir = str((Path(__file__).parent.parent / "extension").resolve())

        # Enable developer mode in profile so --load-extension works
        prefs_dir = Path(pacs_profile_dir) / "Default"
        prefs_dir.mkdir(parents=True, exist_ok=True)
        prefs_file = prefs_dir / "Preferences"
        try:
            if prefs_file.exists():
                prefs = json.loads(prefs_file.read_text(encoding="utf-8"))
            else:
                prefs = {}
            prefs.setdefault("extensions", {}).setdefault("ui", {})["developer_mode"] = True
            prefs_file.write_text(json.dumps(prefs, indent=2), encoding="utf-8")
        except Exception as e:
            log.warning(f"Could not set developer_mode in profile prefs: {e}")

        launch_args = [
            chrome_exe,
            f"--remote-debugging-port={CHROME_DEBUG_PORT}",
            f"--user-data-dir={pacs_profile_dir}",
            "--no-first-run",
            "--no-default-browser-check",
            "--remote-allow-origins=*",
            "--enable-extensions",
        ]
        if Path(extension_dir).exists():
            launch_args.append(f"--load-extension={extension_dir}")
            log.info(f"Loading extension from {extension_dir}")

        launch_args.append(pacs_url)
        log.info(f"Launching Chrome: {chrome_exe}")
        subprocess.Popen(launch_args)
        for _ in range(20):
            time.sleep(1)
            try:
                with socket.create_connection(("127.0.0.1", CHROME_DEBUG_PORT), timeout=1):
                    debug_port_open = True
                    break
            except (ConnectionRefusedError, OSError):
                pass
        if not debug_port_open:
            raise RuntimeError(
                f"Chrome debug port {CHROME_DEBUG_PORT} not available after 20s."
            )

        # ── Find the PACS tab via CDP ──
        time.sleep(page_load_wait)
        tabs = requests.get(f"http://127.0.0.1:{CHROME_DEBUG_PORT}/json", timeout=5).json()
        pacs_tab = None
        for tab in tabs:
            if tab.get("type") == "page" and pacs_url.split("/")[2] in tab.get("url", ""):
                pacs_tab = tab
                break
        if not pacs_tab:
            # Navigate the first tab to PACS
            if tabs:
                pacs_tab = tabs[0]
            else:
                raise RuntimeError("No Chrome tabs found via CDP")

        ws_url = pacs_tab.get("webSocketDebuggerUrl")
        if not ws_url:
            raise RuntimeError("Could not get WebSocket URL for PACS tab")

        log.info(f"Connecting to PACS tab via CDP: {pacs_tab.get('url', '?')}")
        ws = ws_mod.create_connection(ws_url)

        # Navigate to PACS if not already there
        if pacs_url.split("/")[2] not in pacs_tab.get("url", ""):
            log.info(f"Navigating to {pacs_url}")
            _cdp_send(ws, "Page.navigate", {"url": pacs_url})
            time.sleep(page_load_wait)

        # ── Wait for login form ──
        log.info("Waiting for login form...")
        form_found = False
        for _ in range(timeout):
            has_field = _cdp_eval(ws, f"!!document.querySelector('{username_sel}')")
            if has_field:
                form_found = True
                break
            time.sleep(1)

        if not form_found:
            log.info("Login fields not found — may already be logged in")
            ws.close()
            return None

        time.sleep(page_load_wait)

        # ── Fill login form via JavaScript ──
        # Use json.dumps to safely escape credentials for JS string literals
        js_user = json.dumps(username)
        js_pass = json.dumps(password)

        fill_js = f"""
        (function() {{
            var userEl = document.querySelector('{username_sel}');
            var passEl = document.querySelector('{password_sel}');
            if (!userEl || !passEl) return 'fields_not_found';

            // Use native setter to bypass Angular/React wrappers
            var nativeSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value'
            ).set;

            // Check autofill first
            var needUser = !userEl.value;
            var needPass = !passEl.value;

            if (needUser) {{
                nativeSetter.call(userEl, {js_user});
                userEl.dispatchEvent(new Event('input', {{bubbles: true}}));
                userEl.dispatchEvent(new Event('change', {{bubbles: true}}));
            }}
            if (needPass) {{
                nativeSetter.call(passEl, {js_pass});
                passEl.dispatchEvent(new Event('input', {{bubbles: true}}));
                passEl.dispatchEvent(new Event('change', {{bubbles: true}}));
            }}

            return 'filled';
        }})();
        """
        result = _cdp_eval(ws, fill_js, msg_id=2)
        if result == "fields_not_found":
            log.warning("Login fields not found in DOM — may already be logged in")
            ws.close()
            return None
        log.info(f"Login form filled: {result}")

        # Small delay for Angular to process the input events
        time.sleep(0.5)

        # ── Click submit button ──
        submit_js = """
        (function() {
            var selectors = ['button.sign-in-button', "input[type='submit']", "button[type='submit']"];
            for (var i = 0; i < selectors.length; i++) {
                var btn = document.querySelector(selectors[i]);
                if (btn && btn.offsetParent !== null) {
                    btn.click();
                    return 'clicked:' + selectors[i];
                }
            }
            // Fallback: submit the form directly
            var form = document.querySelector('form');
            if (form) { form.submit(); return 'form.submit'; }
            return 'no_button_found';
        })();
        """
        result = _cdp_eval(ws, submit_js, msg_id=3)
        log.info(f"Submit result: {result}")

        # ── Wait for login to complete ──
        for _ in range(timeout):
            time.sleep(1)
            still_visible = _cdp_eval(ws, f"!!document.querySelector('{username_sel}')", msg_id=4)
            if not still_visible:
                log.info("PACS login completed")
                break
        else:
            log.warning("PACS login may not have completed — proceeding anyway")

        ws.close()
        log.info("CDP disconnected — Chrome running with extensions")
        return None

    finally:
        del password


def select_my_schedule(epic_rect):
    """Click the correct schedule in the 'My Schedule' sidebar."""
    screen = grab_screen(epic_rect)
    match = find_on_screen("my_schedule_item.png", screen=screen)
    if match:
        x, y, w, h, _ = match
        cx = epic_rect["left"] + x + w // 2
        cy = epic_rect["top"] + y + h // 2
        pyautogui.click(cx, cy)
        log.info("Clicked schedule item in My Schedule sidebar")
        time.sleep(SCHEDULE_LOAD_WAIT)
        return True
    log.warning("my_schedule_item.png not found in sidebar — skipping")
    return False


# ─────────────────────────────────────────────
#  Screen capture helpers
# ─────────────────────────────────────────────

def grab_screen(region=None):
    """Capture screen (or region) → numpy BGR array for OpenCV."""
    with mss.mss() as sct:
        monitor = region or sct.monitors[1]  # primary monitor
        shot = sct.grab(monitor)
        img = np.array(shot)[:, :, :3]       # drop alpha
        return cv2.cvtColor(img, cv2.COLOR_RGB2BGR)


def grab_screen_pil(region=None):
    """Capture screen → PIL Image (for sending to OCR)."""
    with mss.mss() as sct:
        monitor = region or sct.monitors[1]
        shot = sct.grab(monitor)
        return Image.frombytes("RGB", shot.size, shot.rgb)


def find_on_screen(template_name, screen=None, threshold=None):
    """Find a template image on screen. Returns (x, y, w, h, confidence) or None."""
    tpl_path = TEMPLATE_DIR / template_name
    if not tpl_path.exists():
        log.warning(f"Template not found: {tpl_path}")
        return None

    tpl = cv2.imread(str(tpl_path))
    if tpl is None:
        log.warning(f"Failed to read template: {tpl_path}")
        return None

    if screen is None:
        screen = grab_screen()

    # Template must be smaller than the screen region
    if tpl.shape[0] > screen.shape[0] or tpl.shape[1] > screen.shape[1]:
        log.info(f"'{template_name}' is larger than search area — skipping")
        return None

    result = cv2.matchTemplate(screen, tpl, cv2.TM_CCOEFF_NORMED)
    _, max_val, _, max_loc = cv2.minMaxLoc(result)

    thresh = threshold or CONFIDENCE_THRESHOLD
    if max_val >= thresh:
        h, w = tpl.shape[:2]
        x, y = max_loc
        log.info(f"Found '{template_name}' at ({x},{y}) conf={max_val:.3f}")
        return (x, y, w, h, max_val)
    else:
        log.info(f"'{template_name}' not found (best={max_val:.3f} < {thresh:.2f})")
        return None


def click_template(template_name, screen=None, offset=(0, 0)):
    """Find template on screen and click its center. Returns True if clicked."""
    match = find_on_screen(template_name, screen=screen)
    if not match:
        return False
    x, y, w, h, _ = match
    cx = x + w // 2 + offset[0]
    cy = y + h // 2 + offset[1]
    pyautogui.click(cx, cy)
    time.sleep(CLICK_DELAY)
    return True


def screens_match(img_a, img_b, threshold=0.98):
    """Check if two screenshots are nearly identical (no new content after scroll)."""
    if img_a.shape != img_b.shape:
        return False
    diff = cv2.absdiff(img_a, img_b)
    similarity = 1.0 - (np.sum(diff) / (diff.size * 255.0))
    return similarity >= threshold


# ─────────────────────────────────────────────
#  Window management (Windows API)
# ─────────────────────────────────────────────

def _get_window_process_name(hwnd):
    """Get the executable name for a window's process."""
    import ctypes.wintypes
    pid = ctypes.wintypes.DWORD()
    ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
    if not handle:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(260)
        size = ctypes.wintypes.DWORD(260)
        if ctypes.windll.kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            return buf.value
        return ""
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)


def find_epic_window():
    """Find the Epic Hyperspace window by checking the process executable name.

    Checks for known Epic process names to avoid false positives from browser
    tabs or other windows with 'Epic' in the title.
    """
    EPIC_EXE_NAMES = ("hyperspace.exe", "epic.exe", "epiccare.exe", "hyperdrive.exe")

    import ctypes.wintypes
    EnumWindows = ctypes.windll.user32.EnumWindows
    GetWindowText = ctypes.windll.user32.GetWindowTextW
    GetWindowTextLength = ctypes.windll.user32.GetWindowTextLengthW
    IsWindowVisible = ctypes.windll.user32.IsWindowVisible

    results = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.wintypes.HWND, ctypes.wintypes.LPARAM)
    def callback(hwnd, _):
        if IsWindowVisible(hwnd):
            length = GetWindowTextLength(hwnd)
            if length > 0:
                buf = ctypes.create_unicode_buffer(length + 1)
                GetWindowText(hwnd, buf, length + 1)
                title = buf.value
                exe_path = _get_window_process_name(hwnd).lower()
                if any(name in exe_path for name in EPIC_EXE_NAMES):
                    results.append((hwnd, title))
        return True

    EnumWindows(callback, 0)
    return results


def focus_window(hwnd):
    """Bring a window to foreground and maximize it."""
    SW_MAXIMIZE = 3
    ctypes.windll.user32.ShowWindow(hwnd, SW_MAXIMIZE)
    ctypes.windll.user32.SetForegroundWindow(hwnd)
    time.sleep(0.5)


def get_window_rect(hwnd):
    """Get window position as mss-compatible dict."""
    import ctypes.wintypes
    rect = ctypes.wintypes.RECT()
    ctypes.windll.user32.GetWindowRect(hwnd, ctypes.byref(rect))
    return {
        "left": rect.left,
        "top": rect.top,
        "width": rect.right - rect.left,
        "height": rect.bottom - rect.top,
    }


# ─────────────────────────────────────────────
#  Template recording mode
# ─────────────────────────────────────────────

def record_templates():
    """Interactive mode: user selects regions to save as reference templates."""
    TEMPLATE_DIR.mkdir(exist_ok=True)

    templates_to_record = [
        ("username_field.png",    "Epic login — username text field"),
        ("password_field.png",    "Epic login — password text field"),
        ("context_screen.png",    "Epic context screen (optional — ESC to skip)"),
        ("my_schedule_item.png",  "Schedule to scrape in 'My Schedule' sidebar"),
        ("schedule_title.png",    "'Schedule' title text (date field is clicked below this)"),
        ("epic_window.png",       "Epic titlebar/logo (to identify the window)"),
        ("table_top_left.png",    "Top-left corner of patient list (e.g. 'Color' column header)"),
        ("table_top_right.png",   "Top-right corner of patient list (e.g. end of 'Provider' column)"),
        ("scroll_end.png",        "Bottom of patient list or empty row marker (optional — helps detect end of list)"),
    ]

    print("\n=== Template Recording Mode ===")
    print("For each template, position your screen so the element is visible,")
    print("then drag to select the region.  Press ESC or select empty region to skip.\n")

    for filename, description in templates_to_record:
        input(f"Press Enter when ready to capture: {description}")

        print("Taking screenshot... select the region in the popup window.")
        screen = grab_screen()
        display = screen.copy()

        roi = cv2.selectROI(f"Select: {description}", display, fromCenter=False, showCrosshair=True)
        cv2.destroyAllWindows()

        if roi[2] > 0 and roi[3] > 0:
            x, y, w, h = [int(v) for v in roi]
            crop = screen[y:y+h, x:x+w]
            out_path = TEMPLATE_DIR / filename
            cv2.imwrite(str(out_path), crop)
            print(f"  Saved {out_path} ({w}x{h})")
        else:
            print(f"  Skipped {filename}")

    print("\nDone! Templates saved to:", TEMPLATE_DIR)


# ─────────────────────────────────────────────
#  Date navigation
# ─────────────────────────────────────────────

def next_weekday(from_date):
    """Return the next weekday (Mon-Fri) after from_date."""
    d = from_date + timedelta(days=1)
    while d.weekday() >= 5:  # 5=Sat, 6=Sun
        d += timedelta(days=1)
    return d


DATE_FIELD_Y_OFFSET = 36      # pixels below schedule_title center to reach date field


def navigate_to_date(target_date, epic_rect):
    """Type the target date into the date entry field (MM/DD/YYYY format).

    Finds the 'Schedule' title via template, clicks a fixed offset below it
    to hit the date field, selects all existing text, types the new date,
    and presses Enter to load the schedule for that date.

    Returns True if the date was typed successfully.
    """
    date_str = target_date.strftime("%m/%d/%Y")

    screen = grab_screen(epic_rect)
    match = find_on_screen("schedule_title.png", screen=screen)
    if not match:
        log.error("schedule_title.png not found on screen — cannot navigate to date")
        return False

    x, y, w, h, _ = match
    cx = epic_rect["left"] + x + w // 2
    cy = epic_rect["top"] + y + h // 2 + DATE_FIELD_Y_OFFSET

    # Triple-click to select all text in the date field
    pyautogui.click(cx, cy, clicks=3)
    log.info(f"Triple-clicked date field ({DATE_FIELD_Y_OFFSET}px below schedule title)")
    time.sleep(0.5)

    # Type the new date (replaces selected text)
    pyautogui.typewrite(date_str, interval=0.05)
    time.sleep(0.3)
    pyautogui.press("enter")
    log.info(f"Typed date {date_str} into date field")
    time.sleep(SCHEDULE_LOAD_WAIT)
    return True


# ─────────────────────────────────────────────
#  Schedule capture with scrolling
# ─────────────────────────────────────────────

SCROLLBAR_MARGIN = 20  # pixels to exclude from right edge to avoid scrollbar


def get_schedule_region(epic_rect):
    """Determine the schedule grid region within the Epic window.

    Uses table_top_left.png and table_top_right.png corner templates to
    define the patient list boundaries. When a scrollbar is present
    (>~30 patients), the right-side template may not match — falls back
    to top-left only with a right margin to exclude the scrollbar.

    Returns an mss-compatible region dict.
    """
    screen = grab_screen(epic_rect)

    tl = find_on_screen("table_top_left.png", screen=screen, threshold=0.65)
    # Try right corner at lower threshold since scrollbar can shift it
    tr = find_on_screen("table_top_right.png", screen=screen, threshold=0.55)

    if tl and tr:
        tl_x, tl_y, _, _, _ = tl
        tr_x, tr_y, tr_w, _, _ = tr
        region = {
            "left": epic_rect["left"] + tl_x,
            "top": epic_rect["top"] + tl_y,
            "width": (tr_x + tr_w) - tl_x,
            "height": epic_rect["height"] - tl_y,
        }
        log.info(f"Schedule region: top-left=({tl_x},{tl_y}), top-right=({tr_x + tr_w},{tr_y})")
        return region

    if tl:
        # Only top-left found — use full window width minus scrollbar margin
        tl_x, tl_y, _, _, _ = tl
        region = {
            "left": epic_rect["left"] + tl_x,
            "top": epic_rect["top"] + tl_y,
            "width": epic_rect["width"] - tl_x - SCROLLBAR_MARGIN,
            "height": epic_rect["height"] - tl_y,
        }
        log.info(f"Schedule region: top-left at ({tl_x},{tl_y}), right edge minus scrollbar margin")
        return region

    # No templates found — use full window minus scrollbar margin
    log.info("No table corner templates found — using full Epic window (minus scrollbar)")
    return {
        "left": epic_rect["left"],
        "top": epic_rect["top"],
        "width": epic_rect["width"] - SCROLLBAR_MARGIN,
        "height": epic_rect["height"],
    }


def capture_with_scroll(schedule_region, epic_rect):
    """Capture the schedule area, scrolling down to get all patients.

    Returns a list of PIL Images (one per visible page).
    Stops when the screen doesn't change after a scroll, or when
    scroll_end.png is detected, or after MAX_SCROLLS.
    """
    screenshots = []
    prev_screen = None

    # Move mouse into the schedule area so scroll events target it
    cx = schedule_region["left"] + schedule_region["width"] // 2
    cy = schedule_region["top"] + schedule_region["height"] // 2
    pyautogui.moveTo(cx, cy)
    time.sleep(0.3)

    for i in range(MAX_SCROLLS + 1):
        # Capture current view
        current_cv = grab_screen(schedule_region)
        current_pil = grab_screen_pil(schedule_region)

        # Check if we've stopped scrolling (screen unchanged)
        if prev_screen is not None and screens_match(prev_screen, current_cv):
            log.info(f"Screen unchanged after scroll {i} — reached end of list")
            break

        screenshots.append(current_pil)
        log.info(f"Captured page {len(screenshots)}")

        # Check for scroll_end marker
        end_match = find_on_screen("scroll_end.png", screen=current_cv, threshold=0.70)
        if end_match:
            log.info("Found scroll_end marker — done capturing")
            break

        if i >= MAX_SCROLLS:
            log.warning(f"Hit MAX_SCROLLS ({MAX_SCROLLS}) — stopping")
            break

        prev_screen = current_cv.copy()

        # Scroll down
        pyautogui.scroll(-5)  # negative = scroll down
        time.sleep(SCROLL_PAUSE)

    log.info(f"Captured {len(screenshots)} page(s) total")
    return screenshots


# ─────────────────────────────────────────────
#  OCR via server
# ─────────────────────────────────────────────

def ocr_screenshot(pil_img):
    """Send a screenshot to the server's OCR endpoint. Returns parsed data."""
    buf = io.BytesIO()
    pil_img.save(buf, format="PNG")
    buf.seek(0)

    resp = requests.post(
        f"{SERVER_URL}/api/ocr",
        files={"image": ("schedule.png", buf, "image/png")},
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()


def ocr_local(pil_img):
    """Run Tesseract OCR locally as fallback if server is unavailable."""
    try:
        import pytesseract
        from PIL import ImageFilter, ImageOps
    except ImportError:
        log.error("pytesseract not installed — cannot OCR locally")
        return None

    # Find tesseract binary
    for candidate in [
        os.path.expandvars(r'%LOCALAPPDATA%\Programs\Tesseract-OCR\tesseract.exe'),
        r'C:\Program Files\Tesseract-OCR\tesseract.exe',
        r'C:\Program Files (x86)\Tesseract-OCR\tesseract.exe',
    ]:
        if Path(candidate).exists():
            pytesseract.pytesseract.tesseract_cmd = candidate
            break

    # Preprocess (same as server)
    img = pil_img.convert('L')
    w, h = img.size
    img = img.resize((w * 2, h * 2), Image.LANCZOS)
    img = ImageOps.autocontrast(img, cutoff=2)
    img = img.filter(ImageFilter.SHARPEN)

    import re
    date_re = re.compile(r'\b\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}\b')
    best_text, best_count = '', 0
    for psm in (6, 4, 3):
        t = pytesseract.image_to_string(img, config=f'--psm {psm} --oem 1')
        n = len(date_re.findall(t))
        if n > best_count:
            best_count, best_text = n, t

    # Use the server's line parser if available
    patients = []
    providers_seen = {}
    try:
        sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))
        from server import _parse_pdf_text_line
        for line in best_text.split('\n'):
            p = _parse_pdf_text_line(line.strip())
            if p:
                patients.append(p)
                if p.get('provider'):
                    providers_seen[p['provider']] = True
    except ImportError:
        log.warning("Could not import server parser — returning raw OCR text only")

    return {
        "text": best_text, "status": "ok", "dates_found": best_count,
        "patients": patients, "providers": list(providers_seen),
    }


def server_is_running():
    """Check if the PACS server is responding."""
    try:
        return requests.get(f"{SERVER_URL}/api/health", timeout=3).ok
    except Exception:
        return False


# ─────────────────────────────────────────────
#  Main capture pipeline
# ─────────────────────────────────────────────

def capture_schedule(target_date, dry_run=False, config=None):
    """Full pipeline: launch Epic → login → navigate to date → screenshot → scroll → OCR → import."""
    if config is None:
        config = load_config()

    SCREENSHOT_DIR.mkdir(exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    clinic_date_str = target_date.strftime("%Y-%m-%d")

    # ── Step 0: Open Chrome to PACS, log in via CDP, then detach ──
    log.info("Opening PACS InteleBrowser in Chrome...")
    try:
        open_and_login_pacs(config)
    except Exception as e:
        log.error(f"PACS browser setup failed: {e}")
        if dry_run:
            log.error("Stopping (dry run)")
            return None
        log.info("Continuing with Epic capture despite PACS error")

    # ── Step 1: Launch Epic (or find existing window) ──
    log.info("Launching / finding Epic Hyperspace...")
    hwnd, title = launch_epic(config)
    log.info(f"Epic window: '{title}'")

    # ── Step 1b: Wait for splash screen to clear, then login if needed ──
    # Poll for the login screen (username_field) or the schedule view
    # (my_schedule_item / date_field) to confirm Epic is past the splash
    login_timeout = config["epic"]["login_timeout"]
    log.info("Waiting for Epic to finish loading...")
    epic_ready = False
    needs_login = False
    elapsed = 0
    poll_interval = 2
    while elapsed < login_timeout:
        time.sleep(poll_interval)
        elapsed += poll_interval
        screen = grab_screen()
        if find_on_screen("username_field.png", screen=screen):
            needs_login = True
            epic_ready = True
            break
        if find_on_screen("my_schedule_item.png", screen=screen) or \
           find_on_screen("schedule_title.png", screen=screen):
            epic_ready = True
            break

    if not epic_ready:
        log.warning(f"Epic did not get past splash screen within {login_timeout}s — proceeding anyway")

    if needs_login:
        log.info("Login screen detected — logging in...")
        login_epic(hwnd, config)
        handle_context_screen(config)
        # Re-acquire window handle (may change after login)
        windows = find_epic_window()
        if windows:
            hwnd, title = windows[0]
            focus_window(hwnd)
    else:
        log.info("Already logged in — skipping login")

    epic_rect = get_window_rect(hwnd)
    time.sleep(1.5)

    # ── Step 2: Select schedule in My Schedule sidebar ──
    select_my_schedule(epic_rect)

    # ── Step 3: Type target date into date field ──
    log.info(f"Navigating to {clinic_date_str}...")
    navigate_to_date(target_date, epic_rect)

    # ── Step 4: Determine schedule region and capture with scrolling ──
    schedule_region = get_schedule_region(epic_rect)
    screenshots = capture_with_scroll(schedule_region, epic_rect)

    if not screenshots:
        log.error("No screenshots captured")
        return None

    # Save all screenshots
    saved_paths = []
    for i, img in enumerate(screenshots):
        path = SCREENSHOT_DIR / f"schedule_{timestamp}_p{i+1}.png"
        img.save(str(path))
        saved_paths.append(path)
    log.info(f"Saved {len(saved_paths)} screenshot(s) to {SCREENSHOT_DIR}")

    if dry_run:
        log.info("Dry run — skipping OCR and import")
        return None

    # ── Step 5: OCR each screenshot ──
    log.info("Running OCR on captured screenshots...")
    all_patients = []
    all_providers = set()
    all_ocr_text = []
    use_server = server_is_running()

    for i, img in enumerate(screenshots):
        log.info(f"OCR page {i+1}/{len(screenshots)}...")
        try:
            if use_server:
                data = ocr_screenshot(img)
            else:
                data = ocr_local(img)
                if data is None:
                    continue
        except Exception as e:
            log.error(f"  OCR failed for page {i+1}: {e}")
            continue

        page_patients = data.get("patients", [])
        all_ocr_text.append(data.get("text", ""))
        log.info(f"  Page {i+1}: {len(page_patients)} patient(s), {data.get('dates_found', 0)} date(s)")

        for p in page_patients:
            all_providers.add(p.get("provider", ""))
            all_patients.append(p)

    # Deduplicate by name+dob
    seen = set()
    unique_patients = []
    for p in all_patients:
        key = (p.get("name", "").lower(), p.get("dob", ""))
        if key not in seen:
            seen.add(key)
            unique_patients.append(p)
        else:
            log.info(f"  Dedup: skipping duplicate {p.get('name')}")

    all_patients = unique_patients
    all_providers.discard("")
    log.info(f"OCR total: {len(all_patients)} unique patient(s), {len(all_providers)} provider(s)")

    if all_patients:
        print(f"\n-- Parsed Schedule for {clinic_date_str} --")
        for p in all_patients:
            t = p.get("time", "")
            prov = p.get("provider", "")
            print(f"  {t:>8s}  {p['name']:<30s}  {p['dob']}  {prov}")

    # Save schedule data
    schedule_out = SCREENSHOT_DIR / f"schedule_{timestamp}.json"
    with open(schedule_out, "w") as f:
        json.dump({
            "captured_at": datetime.now().isoformat(),
            "clinic_date": clinic_date_str,
            "patients": all_patients,
            "providers": list(all_providers),
            "ocr_text": "\n---PAGE---\n".join(all_ocr_text),
            "screenshot_count": len(screenshots),
        }, f, indent=2)
    log.info(f"Schedule data saved to {schedule_out}")

    # Also save as latest for nightly_loader pickup
    latest_out = SCREENSHOT_DIR / "latest_schedule.json"
    with open(latest_out, "w") as f:
        json.dump({
            "captured_at": datetime.now().isoformat(),
            "clinic_date": clinic_date_str,
            "patients": all_patients,
            "providers": list(all_providers),
        }, f, indent=2)

    # ── Step 6: Import to server ──
    if use_server:
        try:
            resp = requests.post(
                f"{SERVER_URL}/api/schedule/import",
                json={
                    "patients": all_patients,
                    "clinic_date": clinic_date_str,
                    "source": "epic_capture",
                },
                timeout=10,
            )
            if resp.ok:
                result = resp.json()
                log.info(f"Imported {result.get('registered', 0)} patient(s) to server for {clinic_date_str}")
            else:
                log.error(f"Server import failed: {resp.status_code}")
        except Exception as e:
            log.error(f"Server import error: {e}")
    else:
        log.info("Server not running — schedule saved to latest_schedule.json for later import")

    return all_patients


def ocr_only():
    """OCR the most recent screenshot(s) without recapturing from Epic."""
    SCREENSHOT_DIR.mkdir(exist_ok=True)

    # Find the most recent screenshot set
    pngs = sorted(SCREENSHOT_DIR.glob("schedule_*.png"), reverse=True)
    if not pngs:
        log.error(f"No screenshots found in {SCREENSHOT_DIR}")
        return None

    # Group by timestamp prefix (schedule_YYYYMMDD_HHMMSS_pN.png)
    latest_prefix = "_".join(pngs[0].stem.split("_")[:3])
    batch = [p for p in pngs if p.stem.startswith(latest_prefix)]
    batch.sort()  # ascending page order

    log.info(f"Re-OCR'ing {len(batch)} screenshot(s) from {latest_prefix}")

    use_server = server_is_running()
    all_patients = []
    for i, path in enumerate(batch):
        img = Image.open(str(path))
        log.info(f"OCR page {i+1}/{len(batch)}: {path.name}")
        try:
            if use_server:
                data = ocr_screenshot(img)
            else:
                data = ocr_local(img)
                if data is None:
                    continue
        except Exception as e:
            log.error(f"  OCR failed: {e}")
            continue

        page_patients = data.get("patients", [])
        log.info(f"  {len(page_patients)} patient(s)")
        all_patients.extend(page_patients)

    # Deduplicate
    seen = set()
    unique = []
    for p in all_patients:
        key = (p.get("name", "").lower(), p.get("dob", ""))
        if key not in seen:
            seen.add(key)
            unique.append(p)

    log.info(f"Total: {len(unique)} unique patient(s)")
    for p in unique:
        t = p.get("time", "")
        prov = p.get("provider", "")
        print(f"  {t:>8s}  {p['name']:<30s}  {p['dob']}  {prov}")

    return unique


# ─────────────────────────────────────────────
#  CLI
# ─────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Epic Hyperspace schedule capture -> OCR -> PACS preloader import"
    )
    parser.add_argument("--record", action="store_true",
                        help="Record UI template images for Epic navigation")
    parser.add_argument("--dry-run", action="store_true",
                        help="Screenshot only, skip OCR and import")
    parser.add_argument("--ocr-only", action="store_true",
                        help="Re-OCR the most recent screenshots without recapturing")
    parser.add_argument("--date", default=None,
                        help="Target clinic date (YYYY-MM-DD). Default: next weekday.")
    parser.add_argument("--server", default=None,
                        help="PACS server URL (default: $PACS_SERVER or localhost:8888)")
    parser.add_argument("--setup-credentials", action="store_true",
                        help="Store Epic and PACS login credentials in Windows Credential Manager and exit")
    parser.add_argument("--config", default=None,
                        help="Path to config.json (default: automation/config.json)")
    parser.add_argument("--inspect-pacs", action="store_true",
                        help="Open PACS login page in Chrome via Selenium and print page source for CSS selector inspection")
    args = parser.parse_args()

    global SERVER_URL
    if args.server:
        SERVER_URL = args.server.rstrip("/")

    # Load config early
    config = load_config(args.config)

    # Set up file logging
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    fh = logging.FileHandler(LOG_DIR / f"epic_capture_{datetime.now().strftime('%Y%m%d')}.log", encoding="utf-8")
    fh.setFormatter(logging.Formatter("%(asctime)s  %(message)s", datefmt="%H:%M:%S"))
    log.addHandler(fh)

    if args.setup_credentials:
        setup_credentials(config)
        return

    if args.inspect_pacs:
        if not HAS_SELENIUM:
            print("ERROR: --inspect-pacs requires selenium. Install with: pip install selenium webdriver-manager")
            return
        pacs_url = config["pacs"]["url"]
        print(f"\nOpening Chrome to {pacs_url} for inspection...")
        chrome_options = Options()
        driver = webdriver.Chrome(
            service=Service(ChromeDriverManager().install()),
            options=chrome_options,
        )
        driver.get(pacs_url)
        time.sleep(config["pacs"]["page_load_wait"])
        print("\n=== Page source (first 3000 chars) ===")
        print(driver.page_source[:3000])
        print("\n=== Input elements found ===")
        for el in driver.find_elements(By.TAG_NAME, "input"):
            el_id = el.get_attribute("id") or ""
            el_name = el.get_attribute("name") or ""
            el_type = el.get_attribute("type") or ""
            print(f"  <input id=\"{el_id}\" name=\"{el_name}\" type=\"{el_type}\">")
        print("\nLeaving Chrome open — inspect with F12 and close manually when done.")
        input("Press Enter to quit Chrome and exit...")
        driver.quit()
        return

    if args.record:
        record_templates()
        return

    if args.ocr_only:
        ocr_only()
        return

    # Determine target date
    if args.date:
        target_date = datetime.strptime(args.date, "%Y-%m-%d")
    else:
        target_date = next_weekday(datetime.now())

    log.info(f"Target clinic date: {target_date.strftime('%Y-%m-%d')}")
    capture_schedule(target_date, dry_run=args.dry_run, config=config)


if __name__ == "__main__":
    main()
