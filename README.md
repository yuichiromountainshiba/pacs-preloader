# PACS Clinic Preloader

A Chrome extension + local server that preloads patient X-rays from InteleBrowser for fast iPad viewing during clinic.

## Architecture

```
┌─────────────────────────────────────────────┐
│  Chrome Browser (logged into InteleBrowser) │
│  ┌────────────────────────────────────────┐ │
│  │  Extension (popup + content script)    │ │
│  │  - Runs inside authenticated session   │ │
│  │  - Searches patients via GWT-RPC       │ │
│  │  - Fetches images via JpegServlet      │ │
│  │  - Sends images to local server        │ │
│  └──────────────────┬─────────────────────┘ │
└─────────────────────┼───────────────────────┘
                      │ POST /api/images
                      ▼
┌─────────────────────────────────────────────┐
│  Local FastAPI Server (port 8888)           │
│  - Receives & stores images as JPEGs       │
│  - Organizes by patient / study            │
│  - Serves iPad-friendly swipe viewer       │
│  - Data stored in ./pacs_data/             │
└─────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────┐
│  iPad / Browser Viewer                      │
│  - http://<your-machine-ip>:8888/viewer     │
│  - Swipe between images                    │
│  - Tap patient list to switch              │
└─────────────────────────────────────────────┘
```

## Setup

### 1. Install Python dependencies

```bash
cd backend
pip install fastapi uvicorn python-multipart
```

### 2. Start the local server

```bash
cd backend
python server.py
```

You should see:
```
🏥 PACS Preloader Server
────────────────────────
Viewer:  http://localhost:8888/viewer
API:     http://localhost:8888/api/health
```

### 3. Install the Chrome extension

1. Open Chrome → `chrome://extensions/`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder
5. You should see "PACS Clinic Preloader" in your extensions

### 4. Create extension icons

The extension needs icon files. Create simple placeholder icons:
- `extension/icon48.png` (48x48)
- `extension/icon128.png` (128x128)

Or just use any small PNG and rename it.

## Credential Setup

Both Epic and PACS credentials are stored in Windows Credential Manager
(DPAPI-encrypted, never in files):

```bash
cd automation
python epic_capture.py --setup-credentials
```

This prompts for your Epic username/password and your PACS InteleBrowser
username/password. To update, re-run the command — it overwrites existing entries.

The nightly automation uses these credentials to:
1. Open Chrome and log into PACS InteleBrowser automatically
2. Launch and log into Epic Hyperspace automatically

If your PACS URL differs from `pacs.renoortho.com`, update:
- `automation/config.json` → `pacs.url`
- `extension/manifest.json` → `host_permissions` and `content_scripts.matches`
- `extension/popup.js` → the URL check in the init function
- `extension/background.js` → the `pacs.renoortho.com` check in tab detection

## Usage

### Manual Preloading

1. **Open InteleBrowser** in Chrome and **log in normally**
2. Click the **PACS Preloader** extension icon (puzzle piece → pin it)
3. Paste your clinic schedule — one patient per line:
   ```
   Smith, John  01/15/1965
   Doe, Jane  03/22/1980
   ```
4. Click **Preload Images**
5. The extension searches each patient and caches their images locally

### Nightly Automation (Unattended)

```bash
# One-time setup
cd automation
python epic_capture.py --setup-credentials   # store Epic AND PACS credentials
python epic_capture.py --record              # record UI templates (Epic elements only)

# Test
python nightly_loader.py --dry-run           # parse only, verify OCR output
python nightly_loader.py                     # full run: Selenium PACS login → Epic → OCR → import → preload
```

**Nightly flow (fully automated):**
1. **9 PM Mon-Fri:** Task Scheduler runs `run_nightly.bat` → starts server → opens Chrome with extension → logs into PACS via CDP JavaScript → launches Epic → logs in via pyautogui → captures next day's schedule → OCR → imports patients → extension auto-preloads overnight
2. **7 AM Tue-Sat:** `send_summary.bat` emails HIPAA-safe summary (initials only)
3. **During clinic:** Extension auto-refreshes XRs 1-5 minutes before each appointment

Schedule via Windows Task Scheduler (no admin needed):
```bash
cd automation
install_task.bat          # creates both 9PM + 7AM tasks
install_task.bat /remove  # remove both tasks
```

### Viewing on iPad

1. Make sure your iPad is on the **same network** as the computer running the server
2. Find your computer's local IP (e.g., `192.168.1.100`)
3. Open Safari on iPad: `http://192.168.1.100:8888/viewer`
4. Tap a patient → swipe through their images

## ⚠️ IMPORTANT: Customization Required

### GWT-RPC Payload

The content script (`extension/content.js`) contains a **template** for the GWT-RPC patient search payload. You **must** customize this for your specific InteleBrowser version:

1. Open InteleBrowser in Chrome
2. Open DevTools (F12) → Network tab
3. Search for a patient manually
4. Find the POST request to `PatientSearchService`
5. Copy the request payload
6. Update `buildGwtSearchPayload()` in `content.js` with the exact field structure

### Session Parameters

The content script tries to extract session parameters (SID, UserName, SessionHost) from the page. If these aren't found automatically, you may need to adjust `getSessionParams()` to look in the right places for your version.

### PACS URL

If your PACS isn't at `pacs.renoortho.com`, update:
- `extension/manifest.json` → `host_permissions` and `content_scripts.matches`
- `extension/popup.js` → the URL check in the init function

## Troubleshooting

**Extension says "Not on InteleBrowser page"**
- Make sure the InteleBrowser tab is active when you click the extension icon
- Check that the URL matches what's in `manifest.json`

**"Local server not running"**
- Start the server: `cd backend && python server.py`
- Check it's accessible: `curl http://localhost:8888/api/health`

**No images found for a patient**
- Check the extension's log output
- Open Chrome DevTools console on the InteleBrowser tab for detailed errors
- Verify the GWT-RPC payload is correctly formatted

**403 errors**
- This shouldn't happen since the content script uses the browser's authenticated session
- If it does, your session may have expired — log into InteleBrowser again

**iPad can't reach viewer**
- Ensure same network
- Check firewall isn't blocking port 8888
- Try: `python server.py` uses `0.0.0.0` which should accept connections from any device

## File Structure

```
pacs-preloader/
├── extension/
│   ├── manifest.json      # Chrome extension manifest v3
│   ├── popup.html         # Extension popup UI
│   ├── popup.js           # Schedule parsing & preload orchestration
│   ├── content.js         # Runs inside InteleBrowser (THE KEY FILE)
│   └── background.js      # Service worker (minimal)
├── backend/
│   └── server.py          # FastAPI server — image storage & viewer
├── viewer/
│   └── index.html         # iPad-friendly swipe viewer
└── README.md
```

## Security Notes

- All data stays on your local machine — nothing goes to the cloud
- No credentials are stored — the extension uses the browser's active session
- Images are saved as plain JPEGs in `./pacs_data/`
- The server binds to `0.0.0.0` (all interfaces) so your iPad can reach it — only expose on trusted networks
- Clear cached images when done: `curl -X DELETE http://localhost:8888/api/clear`
