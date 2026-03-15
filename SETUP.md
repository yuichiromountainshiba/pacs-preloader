# PACS Clinic Preloader -- Setup Guide

## Requirements

- Windows 10 or 11
- Google Chrome
- Python 3.11+
- Tesseract OCR
- Epic Hyperspace (for schedule capture)

---

## One-Time Setup

### 1. Install Python 3.11

Download from https://www.python.org/downloads/

> **Important:** During install, check **"Add Python to PATH"** before clicking Install Now.

### 2. Install Tesseract OCR

Download the installer from https://github.com/UB-Mannheim/tesseract/wiki

Install to the default path or `%LOCALAPPDATA%\Programs\Tesseract-OCR\`.

### 3. Get the code

```
git clone https://github.com/yuichiromountainshiba/pacs-preloader.git
cd pacs-preloader
```

Or download the ZIP from GitHub and extract it.

### 4. Install Python dependencies

```bash
# Server
pip install fastapi uvicorn python-multipart pytesseract pillow pdfplumber pymupdf

# Automation
pip install pyautogui opencv-python mss pillow requests keyring websocket-client pytesseract
```

### 5. Load the Chrome extension

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top right)
3. Click **Load unpacked**
4. Select the `extension` folder inside the project

### 6. Store credentials

```bash
cd automation
python epic_capture.py --setup-credentials
```

This prompts for your Epic and PACS login credentials and stores them
securely in Windows Credential Manager (never in files or code).

### 7. Record Epic UI templates

```bash
python epic_capture.py --record
```

Follow the prompts to select each Epic UI element (username field,
schedule sidebar item, table corners, etc.). These screenshots are
used by pyautogui to navigate Epic.

### 8. Set up email summaries (optional)

```bash
python nightly_loader.py --setup-email
```

Requires a Gmail app password (Google Account > Security > App passwords).

### 9. Install scheduled tasks

```bash
install_task.bat
```

No admin needed. Creates two tasks:
- **9:00 PM Mon-Fri:** Nightly schedule capture + import
- **7:00 AM Tue-Sat:** Email summary of overnight run

To remove: `install_task.bat /remove`

---

## Daily Use

### Automatic (recommended)

After setup, everything runs automatically via Task Scheduler:
- Server starts at 9 PM and stays running overnight
- Chrome opens, logs into PACS, extension preloads X-rays
- Summary email arrives at 7 AM

### Manual

```bash
# Start the server
python backend/server.py

# Run a dry-run test
cd automation
python epic_capture.py --dry-run

# Full nightly run
python nightly_loader.py

# Stop the server
python nightly_loader.py --stop-server
# or double-click killserver.bat
```

### Viewer on iPad

1. On the laptop, run `ipconfig` and find the IP (e.g. `192.168.x.x`)
2. On the iPad, open `http://192.168.x.x:8888/viewer`
3. In the extension popup, update **Local server** to `http://192.168.x.x:8888`

---

## Updating

```
git pull
```

No need to reinstall dependencies unless told otherwise.
