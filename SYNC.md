# Sync Guide — spine ↔ hipknee variants

Two repos share most code but diverge in variant-specific config and viewer UI. When syncing fixes from one to the other, use this guide.

## Rule: classify every file before syncing

### Shared — safe to copy verbatim
- `backend/server.py` — refresh endpoints, index logic, pending_refreshes
- `extension/content.js` — DOM search, click logic, series parsing
- `extension/popup.js` — popup behavior (reads from `SUBSPECIALTY`)
- `extension/popup.html` — structure
- `extension/content-debug.js`
- `extension/manifest.json` (usually)

### Variant — NEVER cross-copy
- `extension/config.js` — `SUBSPECIALTY` definition (port, regions, viewer params, checkboxes)
- `viewer/index.html` — layout, Cast/Snapshot/Compare buttons, hanging protocols
- `backend/pacs_data/` — runtime data, never committed anyway

### Diff-review required (mostly shared, has variant touchpoints)
- `extension/background.js` — service worker; reads `SUBSPECIALTY.*` in 4+ places. **Always diff before copying.** The top-of-file guard (`throw if SUBSPECIALTY undefined`) will catch silent misloads but won't catch hardcoded spine values replacing `SUBSPECIALTY.*` references.

## Pre-sync checklist

Before copying a shared file from spine → hipknee (or vice versa):

1. `git diff <source-repo>/<file> <target-repo>/<file>` — review every hunk.
2. Search the diff for: `localhost:888`, `lumbar`, `cervical`, `thoracic`, `hip`, `knee`, `SUBSPECIALTY`. Any literal port or region name in shared code is a red flag — should be `SUBSPECIALTY.*`.
3. Never remove `importScripts('config.js')` from `background.js`.
4. After sync, load the extension in Chrome and verify the popup shows the correct region checkboxes (spine: lumbar/cervical/thoracic; hipknee: hip/knee/alignment).

## Past regression log

- **2026-04-10 — `09d2a5b` (hipknee)**: "Sync all fixes from spine" replaced `SUBSPECIALTY.defaultServerUrl` with hardcoded `localhost:8888`, replaced `Object.keys(SUBSPECIALTY.regionKeywords)` with hardcoded spine regions, and removed `importScripts('config.js')`. Caught on 2026-04-12 when hipknee was still filtering for lumbar/cervical/thoracic and talking to port 8888 instead of 8889. Fix: restore `SUBSPECIALTY.*` references + add `typeof SUBSPECIALTY === 'undefined'` throw-guard at top of `background.js`.

## Pending sync — spine → hipknee

Changes landed on spine that haven't yet been ported. Remove entries here once the hipknee side has them.

- **2026-05-05 — Tab readiness check + `input not found` retry** (`extension/background.js`, `extension/content.js`).
  - `content.js`: new `probeSearchInput` message handler.
  - `background.js`: new `waitForSearchInputReady()` helper, called from `openPacsTabs` after content-script injection; one-shot retry path inside `preloadPatient` when search returns the GWT-iframe-not-ready error.
  - No `SUBSPECIALTY.*` touchpoints. Safe to diff-review and copy.

- **2026-05-05 — First-letter fallback search + visual indicator** (`extension/background.js`, `extension/content.js`, `backend/server.py`, `viewer/index.html`).
  - `content.js`: bug fix — middle-initial regex (`\s+[A-Za-z]\.?$`) now only runs in the no-comma branch, so `"Smith, T"` survives intact.
  - `background.js`: new `buildFallbackName()` helper; `preloadPatient` retries once with `Lastname, F` when the primary search returns 0 studies. `updateRefreshStatus()` gained an optional `attempts` arg passed through to the server.
  - `server.py`: `PATCH /api/pending_refreshes/{key}` accepts optional `attempts: [...]`; persisted into `last_refresh.attempts` on clear.
  - `viewer/index.html` (**variant — port manually, do NOT copy**): `formatRefreshStatusLabel` now takes the full `refreshInfo` object, both formatters render attempt-aware copy ("Trying alt: …", "Found via …", "tried: A + B"). `pendingRefreshStatus` map stores `attempts` from the server response.
  - No `SUBSPECIALTY.*` touchpoints in the shared files. The viewer changes are pure formatter logic — replicate the same edits against the hipknee viewer (its `formatRefreshStatusLabel` / `formatLastRefresh` definitions and the call site that passes `refreshInfo.status, refreshInfo.detail`).
