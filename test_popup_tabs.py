"""Headless test: load popup.html with stubbed chrome.* APIs, click each tab,
verify the right panel shows. Catches the 'click does nothing' class of bug."""

from playwright.sync_api import sync_playwright
from pathlib import Path

HERE = Path(__file__).parent
POPUP_DIR = HERE / "extension"

# Stubs injected before any popup script runs. Mocks the chrome.* extension API
# surface that popup.js touches, plus the SUBSPECIALTY config that config.js sets.
PRELOAD = """
window.__consoleLog = [];
const _origLog = console.log;
console.log = (...args) => { window.__consoleLog.push(args.map(String).join(' ')); _origLog.apply(console, args); };

window.chrome = {
  tabs: {
    query: async () => [{ id: 1, url: 'https://pacs.renoortho.com/' }],
    // Real Chrome calls the callback (3rd arg) with the response. The stub had
    // returned a Promise but never invoked the callback, which is what sendToTab
    // actually awaits — that hung init forever. Match real semantics here.
    // Intentionally broken stub: never invokes the callback. This simulates the
    // real-world condition the user hit (content script wedged / not loaded).
    // With the timeout fix in popup.js, init must still complete.
    sendMessage: () => new Promise(() => {}),
    create: (opts) => { window.__lastTabCreated = opts; },
    update: () => Promise.resolve(),
    get: async (id) => ({ id, url: 'https://pacs.renoortho.com/' }),
  },
  runtime: {
    sendMessage: async (msg) => { window.__lastRuntimeMessage = msg; return { ok: true }; },
    onMessage: { addListener: () => {} },
    lastError: null,
  },
  storage: {
    local: {
      get: async () => ({}),
      set: async () => {},
    },
  },
};
window.SUBSPECIALTY = {
  name: 'Spine',
  defaultServerUrl: 'http://localhost:8888',
  regionCheckboxes: [
    { id: 'filterLumbar', label: 'Lumbar', regions: ['lumbar'] },
    { id: 'filterCervical', label: 'Cervical', regions: ['cervical'] },
    { id: 'filterThoracic', label: 'Thoracic', regions: ['thoracic'] },
  ],
  modalityCodes: { xr: 'XR', ct: 'CT', mr: 'MR' },
  hideModalityFilters: false,
  viewerParams: '',
};
window.__errors = [];
window.addEventListener('error', e => window.__errors.push({ msg: e.message, src: e.filename, line: e.lineno }));
window.addEventListener('unhandledrejection', e => window.__errors.push({ msg: 'unhandled rejection: ' + e.reason }));
"""


def is_visible(page, sel):
    return page.evaluate(f"""() => {{
      const el = document.querySelector('{sel}');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    }}""")


def main():
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context()
        ctx.add_init_script(PRELOAD)
        page = ctx.new_page()
        page.on("console", lambda msg: print(f"  [console.{msg.type}] {msg.text}"))
        page.on("pageerror", lambda err: print(f"  [pageerror] {err}"))

        # file:// URL into the popup
        url = (POPUP_DIR / "popup.html").as_uri()
        page.goto(url)
        page.wait_for_load_state("domcontentloaded")
        page.wait_for_timeout(300)  # let async DOMContentLoaded handler finish

        errs = page.evaluate("() => window.__errors")
        if errs:
            print("UNCAUGHT ERRORS DURING INIT:")
            for e in errs:
                print("  ", e)
            results.append(("init", "FAIL", f"errors during init: {errs}"))
        else:
            results.append(("init", "OK", "no errors"))

        # Verify all three tab buttons exist
        for tab_id in ["tabOcr", "tabPendingEpic", "tabPendingEmail"]:
            exists = page.evaluate(f"() => !!document.getElementById('{tab_id}')")
            results.append((f"button #{tab_id} exists", "OK" if exists else "FAIL", ""))

        # Diagnostic: what listeners are attached, what does switchImportTab do directly
        diag = page.evaluate("""() => {
          const has = (id) => {
            const el = document.getElementById(id);
            // Can't introspect listeners directly; instead trigger and check effect
            return { id, exists: !!el,
                     inlineDisplay: el ? el.style.display : null,
                     computedDisplay: el ? getComputedStyle(el).display : null,
                     classes: el ? el.className : null };
          };
          const result = {
            switchImportTabExists: typeof switchImportTab === 'function',
            initialState: {
              tabOcr: has('tabOcr'),
              tabPendingEpic: has('tabPendingEpic'),
              tabPendingEmail: has('tabPendingEmail'),
              ocrPanel: has('ocrPanel'),
              pendingEpicPanel: has('pendingEpicPanel'),
              pendingEmailPanel: has('pendingEmailPanel'),
            },
          };
          // Try calling switchImportTab directly
          try {
            switchImportTab('pendingEpic');
            result.afterDirectCall = {
              ocrPanel: has('ocrPanel'),
              pendingEpicPanel: has('pendingEpicPanel'),
              pendingEmailPanel: has('pendingEmailPanel'),
              tabPendingEpicActive: document.getElementById('tabPendingEpic').classList.contains('active'),
            };
          } catch (e) {
            result.directCallError = String(e);
          }
          return result;
        }""")
        print("\nDIAGNOSTICS:")
        import json
        print(json.dumps(diag, indent=2))

        # Reset to OCR for the rest of the test
        page.evaluate("switchImportTab('ocr')")

        # Diagnose: check whether initPendingEpic and initPendingEmail are even
        # defined and whether they wired up listeners
        ad = page.evaluate("""() => {
          // Track whether each init function is defined and what wiring happened
          const out = {
            initOcrType: typeof initOcr,
            initPendingEpicType: typeof initPendingEpic,
            initPendingEmailType: typeof initPendingEmail,
            switchImportTabType: typeof switchImportTab,
          };
          // Try calling initPendingEpic again - does it throw?
          try {
            initPendingEpic();
            out.initPendingEpicReran = 'ok';
          } catch (e) {
            out.initPendingEpicReran = 'error: ' + e.message + ' at ' + e.stack;
          }
          try {
            initPendingEmail();
            out.initPendingEmailReran = 'ok';
          } catch (e) {
            out.initPendingEmailReran = 'error: ' + e.message + ' at ' + e.stack;
          }
          // Now test click again
          window.__switchCalls = [];
          const orig = window.switchImportTab;
          window.switchImportTab = function(tab) { window.__switchCalls.push(tab); return orig(tab); };
          document.getElementById('tabPendingEpic').click();
          out.switchCalls = window.__switchCalls;
          return out;
        }""")
        import json
        print("\nINIT DIAG:")
        print(json.dumps(ad, indent=2))

        # Click each tab and verify the corresponding panel becomes visible
        cases = [
            ("tabOcr", "ocrPanel", ["pendingEpicPanel", "pendingEmailPanel"]),
            ("tabPendingEpic", "pendingEpicPanel", ["ocrPanel", "pendingEmailPanel"]),
            ("tabPendingEmail", "pendingEmailPanel", ["ocrPanel", "pendingEpicPanel"]),
        ]
        for tab_id, expect_visible, expect_hidden in cases:
            page.click(f"#{tab_id}")
            page.wait_for_timeout(50)
            vis = is_visible(page, f"#{expect_visible}")
            results.append((f"click {tab_id} -> #{expect_visible} visible", "OK" if vis else "FAIL", str(vis)))
            for hid in expect_hidden:
                vh = is_visible(page, f"#{hid}")
                results.append((f"click {tab_id} -> #{hid} hidden", "OK" if vh is False else "FAIL", str(vh)))
            # active class
            active = page.evaluate(f"() => document.getElementById('{tab_id}').classList.contains('active')")
            results.append((f"click {tab_id} -> button.active", "OK" if active else "FAIL", str(active)))

        # Verify Load buttons exist on the pending tabs (separate concern but cheap to check)
        for btn_id in ["pendingEpicLoadBtn", "pendingEmailLoadBtn", "pendingEpicClearBtn", "pendingEmailClearBtn"]:
            exists = page.evaluate(f"() => !!document.getElementById('{btn_id}')")
            results.append((f"#{btn_id} exists", "OK" if exists else "FAIL", ""))

        browser.close()

    print("\n=== RESULTS ===")
    fails = 0
    for name, status, detail in results:
        marker = "[OK]" if status == "OK" else "[FAIL]"
        print(f"{marker} {name}" + (f"  ({detail})" if detail and status == "FAIL" else ""))
        if status == "FAIL":
            fails += 1
    print(f"\n{len(results) - fails}/{len(results)} passed")
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    import sys
    sys.exit(main())
