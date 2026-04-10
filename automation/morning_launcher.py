"""
Morning Launcher
================
Runs via Windows Task Scheduler at 8:25 AM each weekday.
Opens Epic Hyperspace, dev.mirahealth.care, and pacs.renoortho.com
in the default browser, and ensures the PACS backend servers are running.

Usage:
    python morning_launcher.py              # launch everything
    python morning_launcher.py --no-epic    # skip Epic, just browser + servers
    python morning_launcher.py --dry-run    # print what would happen
"""

import argparse
import logging
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

import requests

# ── Paths ──
SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent
LOG_DIR = SCRIPT_DIR / "logs"

# Servers to start
SERVERS = [
    {
        "name": "spine",
        "url": "http://localhost:8888",
        "script": Path(r"C:\Users\dsing\pacs-preloader\backend\server.py"),
        "cwd": Path(r"C:\Users\dsing\pacs-preloader"),
    },
    {
        "name": "hipknee",
        "url": "http://localhost:8889",
        "script": Path(r"C:\Users\dsing\pacs-preloader-hipknee\backend\server.py"),
        "cwd": Path(r"C:\Users\dsing\pacs-preloader-hipknee"),
    },
]

# URLs to open in the browser
BROWSER_URLS = [
    "https://dev.mirahealth.care",
    "https://pacs.renoortho.com",
    "https://outlook.com",
]

# Epic Hyperspace launch
EPIC_PATHS = [
    r"C:\Program Files\Epic\Hyperspace.exe",
    r"C:\Program Files (x86)\Epic\Hyperspace.exe",
    r"C:\Epic\Hyperspace.exe",
]

SERVER_STARTUP_TIMEOUT = 15  # seconds

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("morning_launcher")


# ─────────────────────────────────────────────
#  Server management
# ─────────────────────────────────────────────

def server_is_running(url):
    try:
        return requests.get(f"{url}/api/health", timeout=3).ok
    except Exception:
        return False


def start_server(server):
    """Start a PACS backend server if not already running."""
    name = server["name"]
    url = server["url"]
    script = server["script"]
    cwd = server["cwd"]

    if server_is_running(url):
        log.info(f"  {name} server already running at {url}")
        return True

    if not script.exists():
        log.warning(f"  {name} server script not found: {script}")
        return False

    log.info(f"  Starting {name} server: {script}")
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    server_log = open(LOG_DIR / f"server_{name}_{datetime.now().strftime('%Y%m%d')}.log", "a")
    subprocess.Popen(
        [sys.executable, str(script)],
        cwd=str(cwd),
        stdout=server_log,
        stderr=subprocess.STDOUT,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
    )
    for i in range(SERVER_STARTUP_TIMEOUT * 2):
        time.sleep(0.5)
        if server_is_running(url):
            log.info(f"  {name} server is up (took {(i+1)*0.5:.0f}s)")
            return True
    log.error(f"  {name} server not responding after {SERVER_STARTUP_TIMEOUT}s")
    return False


# ─────────────────────────────────────────────
#  Epic launcher
# ─────────────────────────────────────────────

def find_epic():
    """Find the Epic Hyperspace executable."""
    for path in EPIC_PATHS:
        if Path(path).exists():
            return path
    # Try searching common locations
    for drive in ["C:", "D:"]:
        for root, dirs, files in os.walk(f"{drive}\\Program Files"):
            for f in files:
                if f.lower() == "hyperspace.exe":
                    return os.path.join(root, f)
            break  # only top level
    return None


def launch_epic(dry_run=False):
    """Launch Epic Hyperspace if not already running."""
    # Check if already running
    try:
        result = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq Hyperspace.exe"],
            capture_output=True, text=True, timeout=10,
        )
        if "Hyperspace.exe" in result.stdout:
            log.info("  Epic Hyperspace is already running")
            return True
    except Exception:
        pass

    epic_path = find_epic()
    if not epic_path:
        log.warning("  Epic Hyperspace not found — skipping")
        return False

    if dry_run:
        log.info(f"  [dry-run] Would launch: {epic_path}")
        return True

    log.info(f"  Launching Epic: {epic_path}")
    try:
        subprocess.Popen(
            [epic_path],
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
        return True
    except Exception as e:
        log.error(f"  Failed to launch Epic: {e}")
        return False


# ─────────────────────────────────────────────
#  Browser launcher
# ─────────────────────────────────────────────

def open_urls(urls, dry_run=False):
    """Open URLs in the default browser."""
    import webbrowser
    for url in urls:
        if dry_run:
            log.info(f"  [dry-run] Would open: {url}")
        else:
            log.info(f"  Opening: {url}")
            webbrowser.open(url)
            time.sleep(1)  # brief pause between tabs


# ─────────────────────────────────────────────
#  Main
# ─────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Morning launcher — Epic + browsers + PACS servers")
    parser.add_argument("--no-epic", action="store_true",
                        help="Skip launching Epic Hyperspace")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print what would happen without doing anything")
    args = parser.parse_args()

    # File logging
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    fh = logging.FileHandler(LOG_DIR / f"morning_{datetime.now().strftime('%Y%m%d')}.log")
    fh.setFormatter(logging.Formatter("%(asctime)s  %(levelname)s  %(message)s", datefmt="%H:%M:%S"))
    log.addHandler(fh)

    log.info(f"=== Morning Launcher — {datetime.now().strftime('%Y-%m-%d %H:%M')} ===")

    # 1. Start PACS servers
    log.info("Starting PACS servers...")
    for server in SERVERS:
        if args.dry_run:
            log.info(f"  [dry-run] Would start {server['name']} at {server['url']}")
        else:
            start_server(server)

    # 2. Launch Epic
    if not args.no_epic:
        log.info("Launching Epic Hyperspace...")
        launch_epic(dry_run=args.dry_run)
    else:
        log.info("Skipping Epic (--no-epic)")

    # 3. Open browser tabs
    log.info("Opening browser tabs...")
    open_urls(BROWSER_URLS, dry_run=args.dry_run)

    log.info("=== Morning Launcher complete ===")


if __name__ == "__main__":
    main()
