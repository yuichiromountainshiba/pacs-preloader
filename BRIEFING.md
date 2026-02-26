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
- `<input id="username">` → UserName (e.g. "dsing")
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

## Known Issues / TODO
- Summary view: want all lumbar XRs in one row, MRI scroll stacks below
- MRI series scroll-through viewer
- Epic schedule OCR integration
- Auto-refresh for patients getting X-rays 10 min before appointment
- Some patients not found if name format doesn't match PACS exactly
