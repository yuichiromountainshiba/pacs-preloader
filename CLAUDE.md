# CLAUDE.md

Project-specific instructions for Claude Code. See `README.md` for user-facing setup and `BRIEFING.md` for the full technical deep-dive on PACS internals.

## What this project is

Chrome extension + local FastAPI server that preloads Intelerad InteleBrowser PACS images for fast iPad viewing during spine clinic. Runs fully on the clinician's local machine; no data leaves. The extension drives the InteleBrowser UI directly from a content script using the user's authenticated session.

Key docs (read these before making non-trivial changes):
- `README.md` — setup, usage, troubleshooting
- `BRIEFING.md` — session/SessionHost handling, DOM-driven search flow, JpegServlet URL structure, nightly automation flow
- `SYNC.md` — **critical** rules for syncing code between the spine and hipknee variant repos

## Variant architecture (important)

This repo is one of two sibling variants (spine / hipknee). `extension/config.js` defines `SUBSPECIALTY` (port, region keywords, checkboxes, viewer params) and is the ONLY file that differs. All other code reads from `SUBSPECIALTY.*`.

**Never hardcode** `localhost:8888`, region names (`lumbar`, `cervical`, `hip`, `knee`), or modality lists in shared code — always reference `SUBSPECIALTY.*`. `background.js` has a throw-guard at the top to catch config misloads; don't remove it. See `SYNC.md` for the full sync checklist and the 2026-04-10 regression that motivated these rules.

## Working norms

- **Don't auto-commit.** After making changes, stop and let the user test in Chrome / on the iPad before committing. The user tests manually — type-checking and server startup are not proof the feature works.
- For extension changes, the user must reload the unpacked extension at `chrome://extensions` to pick them up. Mention this when relevant.
- Debug logging lives in `extension/content-debug.js` and there is a debug dashboard — prefer adding to existing debug infrastructure over ad-hoc `console.log`.
- The PACS session is fragile: DOM selectors and session fields can change when InteleBrowser updates. If a flow breaks, suspect version drift before assuming a code regression.

## Gotchas worth remembering

- Real `SessionHost` (`rdsrnorocstd1.rdsrnoroc`) ≠ `xmppDomain`. Auto-discovered from first ViewPatInfo response, cached in `window.__pacsSessionHost`.
- `ViewPatInfo` without a `series` UID returns an empty shell — always pass series.
- `maxImagesPerPage0=999` is required or the response paginates at 20.
- Middle initials in patient names must be stripped before search (PACS stores `LAST, FIRST` only).
- DOB is filtered **client-side** after search results return.
- Auto-refresh during clinic is **XR-only and today-only** by design (speed). Don't broaden it without asking.
- Chrome must not be running before `nightly_loader.py` starts — it kills existing Chrome so `--remote-debugging-port` takes effect.

## Shell

Use Unix shell syntax (bash via Git Bash on Windows). Use `/dev/null`, forward slashes. For `.bat` scripts in `automation/`, invoke via `cmd //c` if needed from bash.
