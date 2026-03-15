# PACS Preloader — Technical Briefing

## What this is
Chrome extension + FastAPI server that preloads spine X-ray images from Intelerad InteleBrowser PACS for fast iPad viewing during orthopedic spine clinic.

## Architecture
- Chrome extension (content script runs inside authenticated InteleBrowser page)
- Content script makes GWT-RPC calls and fetches JPEG images using browser's session
- Images are POSTed to a local FastAPI server (port 8888)
- iPad-friendly viewer served at http://localhost:8888/viewer

## PACS System
- Intelerad InteleBrowser at https://pacs.renoortho.com/InteleBrowser/app
- No admin API access — everything is reverse-engineered from the web UI

## Authentication
Session is extracted from hidden inputs on the main page:
- `<input id="username">` → UserName (e.g. "jsmith")
- `<input id="sessionId">` → SID (32-char hex token)
- `<input id="xmppDomain">` → NOT the SessionHost for image requests

CRITICAL: The real SessionHost for ViewPatInfo/JpegServlet is `rdsrnorocstd1.rdsrnoroc`, 
which is different from xmppDomain (`RDSROC`). The code auto-discovers this from the first 
ViewPatInfo response and caches it in `window.__pacsSessionHost`.

Cookies (including httpOnly JSESSIONID) are sent automatically via `credentials: 'include'`.

## GWT-RPC Search Endpoint

**URL:** `POST /InteleBrowser/gwt/gwtInteleBrowser/patientSearchService`
- NOTE: lowercase 'p' and 's' — case sensitive!

**Headers:**
```
Content-Type: text/x-gwt-rpc; charset=utf-8
X-GWT-Module-Base: https://pacs.renoortho.com/InteleBrowser/gwt/gwtInteleBrowser/
X-GWT-Permutation: <32-char hex from .cache.js filename>
```

**Method:** `executeSearch` (not searchPatients or getStaticData)

**GWT Hash:** `1A63E8AED192E6C86BFBF55C94BF69AD` (version-specific, may change on update)

**Payload structure:** Pipe-delimited GWT-RPC format with 25 string table entries:
- String 13 = patient name search term (lowercase, "last, first" format)
- Search uses `patientName` field with `BEGINS` operator
- No DOB in search — DOB filtering is done client-side after results return
- Middle initials must be stripped before searching (PACS stores "LAST, FIRST" only)
- Date range is encoded as GWT date tokens (base-64 of millisecond timestamp)

**Response format:** `//OK[...numeric_data...,["string_table_array"],0,7]`
- String table is a JSON array embedded near the end of the response
- Contains DICOM UIDs, patient names, study descriptions, series descriptions
- GWT uses `\x3D` style hex escapes that must be converted to `\u003D` for JSON.parse
- String table parser must properly handle quoted strings containing brackets/escapes

**Key string table content patterns:**
- DICOM UIDs: `1.2.840.113...` (20+ chars, dots and digits)
- Study descriptions: start with modality prefix like `XR `, `MR-`, `CT `, `DX-`
- Patient names: `LASTNAME, FIRSTNAME` format (all caps)
- DOBs: 8-digit strings like `19601213` (YYYYMMDD)
- Series descriptions: `AP`, `LATERAL`, `SAG T2`, etc.

**Study/series structure in string table:**
- Series descriptions + UIDs appear BEFORE their parent study description + UID
- Study description is followed within ~3 positions by its study UID
- Patient name and DOB appear before the study's series data

## Image Retrieval Endpoint

**URL:** `POST /InteleBrowser/InteleBrowser.ViewPatInfo`

**Required form fields:**
- UserName, SID, SessionHost (the REAL one: rdsrnorocstd1.rdsrnoroc)
- Action=inlinejpg
- study=<StudyUID>
- series=<SeriesUID> (REQUIRED — sending null returns empty shell)
- maxImagesPerPage0=999 (prevents pagination cutoff at 20)
- curpos0=1

**Response:** HTML page containing `<img>` and `<a>` tags with JpegServlet URLs

**Image URLs look like:**
```
/JpegServlet/getJpeg?UserName=...&SID=...&SessionHost=...&sop=...&path=...dcm...&action=redirectjpeg&host=...
```

The `path` parameter is critical — it contains the full filesystem path to the DICOM file on the PACS server. Without it, the request fails.

## Current Filters
- Spine keywords: spine, lumbar, cervical, thoracic, sacral, L spine, C spine, etc.
- Modality: XR/CR/DX (X-rays), CT, MR (checkboxes in popup)
- Patient name matching + DOB filtering for multi-patient results

## Credential Setup

### Epic Hyperspace (Windows Credential Manager)

Epic login credentials are stored securely in Windows Credential Manager via
the `keyring` library — never in files, logs, or source code.

```bash
cd automation
python epic_capture.py --setup-credentials
```

This prompts for both Epic and PACS credentials and stores them in Windows
Credential Manager (DPAPI-encrypted, tied to your Windows user login).

- Epic credentials: service `pacs-preloader-epic`
- PACS credentials: service `pacs-preloader-pacs`

To verify stored credentials:
```bash
python -c "import keyring; print(keyring.get_password('pacs-preloader-epic', '__username__'))"
python -c "import keyring; print(keyring.get_password('pacs-preloader-pacs', '__username__'))"
```

To update credentials, re-run `--setup-credentials` — it overwrites existing entries.

### PACS InteleBrowser

The nightly automation opens Chrome with `--remote-debugging-port` and a
dedicated user profile (`automation/.chrome-pacs-profile/`), then connects
via Chrome DevTools Protocol (CDP) to inject JavaScript that fills the login
form and clicks the `button.sign-in-button` submit button. The extension is
loaded into this Chrome instance via `--load-extension`. After login, the CDP
WebSocket disconnects and Chrome stays open with the extension active for
overnight preloading.

Key details:
- No Selenium/chromedriver needed for login — uses CDP over WebSocket
  (`websocket-client` library) to execute JavaScript directly in the page
- Uses Angular-compatible value setting (native `HTMLInputElement.prototype.value`
  setter + `dispatchEvent`) so the framework picks up the credentials
- All existing Chrome processes are killed before launch to ensure the
  debug port flag takes effect
- Developer mode is pre-enabled in the profile's Preferences file so
  `--load-extension` works
- Login field CSS selectors (`#username`, `#password`) are configurable
  in `config.json`

The Chrome extension uses the browser's active authenticated session to search
PACS and fetch images — no additional PACS credentials are stored by the
extension itself.

If your PACS URL is different from `pacs.renoortho.com`, update:
- `extension/manifest.json` → `host_permissions` and `content_scripts.matches`
- `extension/popup.js` → the URL check in the init function
- `extension/background.js` → the `pacs.renoortho.com` check in
  `pollPendingRefreshes()` and `pollPendingPreloads()`

## Nightly Automation

### End-to-end flow

```
EVENING 9:00 PM Mon-Fri (automated via Task Scheduler):
  run_nightly.bat → nightly_loader.py
    → Starts backend server (if not already running) — left running overnight
    → Kills any existing Chrome processes
    → Launches Chrome with --remote-debugging-port, --user-data-dir, --load-extension
    → Logs in to PACS via CDP JavaScript injection (no Selenium)
    → CDP disconnects — Chrome stays open with extension active
    → Launches Epic Hyperspace (if not already running)
    → Logs in to Epic using Windows Credential Manager credentials
    → Dismisses context screen (2s wait) → settles (2.5s)
    → Navigates to next weekday's schedule
    → Captures patient list screenshots (handles scrollbar for 30+ patients)
    → OCR via Tesseract → parses patients (name, DOB, clinic time, provider)
    → Imports to server via /api/schedule/import
    → Server queues patients in "pending_preloads"
    → Writes summary report to logs/summary_YYYYMMDD.txt
    → Extension auto-detects pending patients and runs full preload overnight

MORNING 7:00 AM Tue-Sat (automated via Task Scheduler):
  send_summary.bat → nightly_loader.py --send-email
    → Emails HIPAA-safe summary (initials only, no full names/DOB) via Gmail
    → Subject flags ERRORS if any occurred overnight

PRELOAD (automatic — runs as soon as PACS tab + pending patients detected):
  Extension background.js polls /api/pending_preloads every 30s
    → When patients found, runs full preload (same as clicking "Preload Images")
    → Searches PACS for each patient with full filters (spine + XR/CT/MRI)
    → Downloads and caches images to local server
    → Clears pending_preloads queue

DURING CLINIC (automatic):
  Extension checkVisitTimes() runs every 1 min
    → For patients with appointments in the next 5 minutes
    → Queues XR-only auto-refresh (fast targeted lookup for new X-rays)
```

### Schedule import sources (in priority order)

1. **Epic screen capture + Tesseract OCR** (current) — `automation/epic_capture.py`
   screenshots Epic Hyperspace schedule → OCR with Tesseract → imports patients
   with tomorrow's clinic date. Runs via Windows Task Scheduler nightly.
   Epic is launched and logged in automatically. Templates for UI navigation
   are recorded via `--record` mode.

2. **CSV export from IT** (future) — ask IT director for a nightly automated
   CSV export of the next day's clinic schedule (patient name, DOB, appointment
   time, provider). This would be the cleanest and most reliable input.
   Build a CSV parser in `nightly_loader.py` that reads from a drop folder
   or network share. The server's `/api/schedule/import` endpoint already
   accepts the structured data — just need the CSV→JSON adapter.

3. **PDF inbox fallback** — drop a schedule PDF into `automation/schedule_inbox/`
   and the nightly loader will attempt to parse it via the server's
   `/api/parse-pdf` endpoint.

### Setting up Task Scheduler

```bash
# One-time setup
cd automation
python epic_capture.py --setup-credentials   # store Epic + PACS login
python epic_capture.py --record              # record Epic UI templates
python nightly_loader.py --setup-email       # store Gmail app password for summaries

# Test the full chain
python epic_capture.py --dry-run             # test PACS login + Epic capture
python nightly_loader.py --dry-run           # full chain, parse only
python nightly_loader.py --send-email        # test summary email

# Install scheduled tasks (no admin needed)
install_task.bat                             # creates both 9PM + 7AM tasks
install_task.bat /remove                     # remove both tasks

# Utility
killserver.bat                               # stop background server
python nightly_loader.py --stop-server       # same, from command line
python epic_capture.py --inspect-pacs        # check PACS login CSS selectors
```

### Auto-refresh (day-of XR only)

The extension's `checkVisitTimes()` auto-refreshes X-rays 1–6 minutes before
each patient's appointment, but ONLY for patients whose `clinic_date` matches
today's date. This is intentionally XR-only for speed — it catches any new
X-rays taken just before the appointment.

## Known Issues / TODO
- Summary view: want all lumbar XRs in one row, MRI scroll stacks below
- MRI series scroll-through viewer
- Some patients not found if name format doesn't match PACS exactly
- Epic OCR accuracy depends on screen resolution and font size — may need
  template re-recording if Epic UI changes or moves to a different monitor
- PACS login field IDs: if they change, update `username_selector` /
  `password_selector` in `config.json` (use `--inspect-pacs` to check)
- PACS session may expire overnight — automation re-logs in each run
- Scrollbar handling: when >30 patients, scrollbar appears and may shift
  the right edge of the table. The capture region detection accounts for
  this with a 20px margin (`SCROLLBAR_MARGIN`) but templates may need
  re-recording if the Epic UI layout changes significantly
- Chrome must not be running when automation starts — `open_and_login_pacs()`
  kills all Chrome processes before launching with debug port
