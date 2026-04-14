// error-reporter.js — captures uncaught errors from sibling content scripts
// (config.js, content.js) and forwards them to the server debug log so a
// SyntaxError at parse time is visible without opening the browser console.
//
// MUST run FIRST in the content_scripts array (before config.js / content.js)
// and at document_start so its handlers are installed before later scripts
// are compiled.

(() => {
  if (globalThis.__pacsErrorReporterInstalled) return;
  globalThis.__pacsErrorReporterInstalled = true;

  // Server URL: prefer SUBSPECIALTY.defaultServerUrl if config.js already
  // loaded; otherwise fall back to the spine default. The variant-specific
  // value is picked up on the next error if config loads in between.
  const getServerUrl = () => {
    try {
      if (globalThis.SUBSPECIALTY && globalThis.SUBSPECIALTY.defaultServerUrl) {
        return globalThis.SUBSPECIALTY.defaultServerUrl.replace(/\/$/, '');
      }
    } catch {}
    return 'http://localhost:8888';
  };

  const post = (evt) => {
    try {
      fetch(`${getServerUrl()}/api/debug-log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(evt),
        keepalive: true,
      }).catch(() => {});
    } catch {}
  };

  const report = (kind, details) => {
    post({
      source: 'content-error',
      level: 'error',
      category: 'uncaught',
      message: `${kind}: ${details.message || '(no message)'}`,
      details: {
        ...details,
        url: location.href,
        frame: window === window.top ? 'top' : 'iframe',
      },
      ts: new Date().toISOString(),
    });
    try { console.error('[PACS error-reporter]', kind, details); } catch {}
  };

  window.addEventListener('error', (e) => {
    report('Uncaught', {
      message: e.message,
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
      stack: e.error && e.error.stack ? String(e.error.stack).slice(0, 2000) : null,
    });
  }, true);

  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    report('UnhandledRejection', {
      message: reason && reason.message ? reason.message : String(reason).slice(0, 500),
      stack: reason && reason.stack ? String(reason.stack).slice(0, 2000) : null,
    });
  }, true);

  console.log('[PACS error-reporter] installed');
})();
