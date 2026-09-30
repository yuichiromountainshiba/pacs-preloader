"""
Epic Hyperspace Schedule Capture
================================
Automates: find Epic window → navigate to schedule → screenshot → OCR → preload.

Setup:
    pip install pyautogui opencv-python mss pillow requests

Usage:
    # First run — record reference images of your Epic UI elements:
    python epic_capture.py --record

    # Normal run — capture today's schedule and send to OCR:
    python epic_capture.py

    # Dry run — screenshot only, no OCR:
    python epic_capture.py --dry-run

Templates (saved in ./templates/):
    epic_window.png     — Epic titlebar or logo for finding the window
    schedule_tab.png    — "Schedule" or "My Schedule" tab/button
    schedule_area.png   — (optional) crop region marker for the schedule grid
"""

import argparse
import ctypes
import io
import json
import logging
import os
import sys
import time
from datetime import datetime
from pathlib import Path

import cv2
import mss
import numpy as np
import pyautogui
import requests
from PIL import Image

# ── Config ──
SERVER_URL = os.environ.get("PACS_SERVER", "http://localhost:8888")
TEMPLATE_DIR = Path(__file__).parent / "templates"
SCREENSHOT_DIR = Path(__file__).parent / "screenshots"
CONFIDENCE_THRESHOLD = 0.75   # cv2 template match threshold
CLICK_DELAY = 0.5             # seconds between actions
SCHEDULE_LOAD_WAIT = 2.0      # seconds to wait after clicking schedule tab

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("epic_capture")

pyautogui.FAILSAFE = True     # move mouse to corner to abort
pyautogui.PAUSE = 0.3         # small pause between pyautogui calls


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


# ─────────────────────────────────────────────
#  Window management (Windows API)
# ─────────────────────────────────────────────

def find_epic_window():
    """Find the Epic Hyperspace window by title substring."""
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
                # Epic Hyperspace window titles usually contain "Epic" or "Hyperspace"
                if any(kw in title.lower() for kw in ("epic", "hyperspace", "hyperdriv")):
                    results.append((hwnd, title))
        return True

    EnumWindows(callback, 0)
    return results


def focus_window(hwnd):
    """Bring a window to foreground."""
    SW_RESTORE = 9
    ctypes.windll.user32.ShowWindow(hwnd, SW_RESTORE)
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
        ("epic_window.png",    "Epic titlebar/logo (to identify the window)"),
        ("schedule_tab.png",   "Schedule tab or button"),
        ("schedule_area.png",  "Top-left corner of the schedule grid area (optional crop marker)"),
    ]

    print("\n=== Template Recording Mode ===")
    print("For each template, position your screen so the element is visible,")
    print("then drag to select the region.\n")

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
            print(f"  ✓ Saved {out_path} ({w}×{h})")
        else:
            print(f"  ⊘ Skipped {filename}")

    print("\nDone! Templates saved to:", TEMPLATE_DIR)


# ─────────────────────────────────────────────
#  Schedule capture pipeline
# ─────────────────────────────────────────────

def capture_schedule(dry_run=False):
    """Main capture flow: find Epic → navigate → screenshot → OCR."""
    SCREENSHOT_DIR.mkdir(exist_ok=True)

    # ── Step 1: Find and focus Epic ──
    log.info("Looking for Epic Hyperspace window...")
    windows = find_epic_window()
    if not windows:
        log.error("Epic window not found. Is Hyperspace open?")
        sys.exit(1)

    hwnd, title = windows[0]
    log.info(f"Found: '{title}'")
    focus_window(hwnd)
    epic_rect = get_window_rect(hwnd)
    time.sleep(0.5)

    # ── Step 2: Navigate to schedule ──
    log.info("Looking for schedule tab...")
    screen = grab_screen(epic_rect)

    if not click_template("schedule_tab.png", screen=screen):
        log.warning("Schedule tab not found via template — trying keyboard shortcut")
        # Epic common shortcuts: Alt+S for schedule in some configs
        # Adjust this to your Epic setup
        pyautogui.hotkey("alt", "s")
        time.sleep(SCHEDULE_LOAD_WAIT)
    else:
        time.sleep(SCHEDULE_LOAD_WAIT)

    # ── Step 3: Screenshot the schedule area ──
    log.info("Capturing schedule...")

    # Re-grab after navigation
    screen = grab_screen(epic_rect)

    # Try to find the schedule area marker for a tighter crop
    area_match = find_on_screen("schedule_area.png", screen=screen, threshold=0.65)
    if area_match:
        ax, ay, _, _, _ = area_match
        # Crop from the marker to the bottom-right of the Epic window
        crop_region = {
            "left": epic_rect["left"] + ax,
            "top": epic_rect["top"] + ay,
            "width": epic_rect["width"] - ax,
            "height": epic_rect["height"] - ay,
        }
        schedule_img = grab_screen_pil(crop_region)
        log.info(f"Cropped schedule from marker at ({ax},{ay})")
    else:
        # Fall back to full Epic window
        schedule_img = grab_screen_pil(epic_rect)
        log.info("Using full Epic window (no crop marker found)")

    # Save locally
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    save_path = SCREENSHOT_DIR / f"schedule_{timestamp}.png"
    schedule_img.save(str(save_path))
    log.info(f"Saved screenshot: {save_path}")

    if dry_run:
        log.info("Dry run — skipping OCR")
        return

    # ── Step 4: Send to OCR ──
    log.info(f"Sending to OCR at {SERVER_URL}/api/ocr ...")
    buf = io.BytesIO()
    schedule_img.save(buf, format="PNG")
    buf.seek(0)

    try:
        resp = requests.post(
            f"{SERVER_URL}/api/ocr",
            files={"image": ("schedule.png", buf, "image/png")},
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        log.error(f"OCR request failed: {e}")
        sys.exit(1)

    patients = data.get("patients", [])
    log.info(f"OCR found {len(patients)} patient(s), {data.get('dates_found', 0)} date(s)")

    if patients:
        print("\n── Parsed Schedule ──")
        for p in patients:
            t = p.get("time", "")
            prov = p.get("provider", "")
            print(f"  {t:>8s}  {p['name']:<30s}  {p['dob']}  {prov}")

    # ── Step 5: Trigger preload (optional — POST to extension or direct) ──
    # Save parsed schedule for the extension popup to pick up
    schedule_out = SCREENSHOT_DIR / "latest_schedule.json"
    with open(schedule_out, "w") as f:
        json.dump({
            "captured_at": datetime.now().isoformat(),
            "patients": patients,
            "providers": data.get("providers", []),
            "ocr_text": data.get("text", ""),
        }, f, indent=2)
    log.info(f"Schedule data saved to {schedule_out}")

    # Also push to server so extension can pick it up
    try:
        resp = requests.post(
            f"{SERVER_URL}/api/schedule/import",
            json={"patients": patients, "source": "epic_capture"},
            timeout=10,
        )
        if resp.ok:
            log.info("Schedule pushed to server for extension pickup")
    except Exception:
        log.info("Server import endpoint not available (optional)")

    return patients


# ─────────────────────────────────────────────
#  CLI
# ─────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Epic Hyperspace schedule capture → OCR → preload")
    parser.add_argument("--record", action="store_true", help="Record UI template images")
    parser.add_argument("--dry-run", action="store_true", help="Screenshot only, skip OCR")
    parser.add_argument("--server", default=None, help="PACS server URL (default: $PACS_SERVER or localhost:8888)")
    args = parser.parse_args()

    global SERVER_URL
    if args.server:
        SERVER_URL = args.server.rstrip("/")

    if args.record:
        record_templates()
    else:
        capture_schedule(dry_run=args.dry_run)


if __name__ == "__main__":
    main()
