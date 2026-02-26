# PACS Clinic Preloader — Setup Guide

## Requirements

- Windows 10 or 11
- Google Chrome
- The PACS tab open at pacs.renoortho.com

---

## One-Time Setup

### 1. Install Python 3.11
Download from https://www.python.org/downloads/

> **Important:** During install, check **"Add Python to PATH"** before clicking Install Now.

### 2. Install Tesseract OCR (for schedule screenshot parsing)
Download the installer from https://github.com/UB-Mannheim/tesseract/wiki

Run it and accept the default install path (`C:\Program Files\Tesseract-OCR\`).

### 3. Get the code
```
git clone https://github.com/yuichiromountainshiba/pacs-preloader.git
cd pacs-preloader
```

Or download the ZIP from GitHub and extract it somewhere convenient (e.g. `C:\pacs-preloader`).

### 4. Install Python dependencies
Open a terminal in the project folder and run:
```
pip install fastapi uvicorn python-multipart pytesseract pillow
```

### 5. Load the Chrome extension
1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top right)
3. Click **Load unpacked**
4. Select the `extension` folder inside the project

---

## Daily Use

### Start the server
Open a terminal in the project folder and run:
```
python backend/server.py
```

Leave this terminal window open while you use the tool.

### Open the extension
Click the extension icon in Chrome while on the PACS tab.

### Open the viewer on iPad
The viewer runs at `http://localhost:8888/viewer` on the same machine.

To access it from an iPad over hotspot:
1. On the laptop, run `ipconfig` in a terminal and find the IP address under the active network adapter (e.g. `192.168.x.x`)
2. On the iPad, open `http://192.168.x.x:8888/viewer`
3. In the extension popup, update the **Local server** field to `http://192.168.x.x:8888`

---

## Updating

To pull the latest version:
```
git pull
```

No need to reinstall dependencies unless told otherwise.
