// background.js — Service worker for PACS Preloader extension
// Handles the preload loop so it survives the popup being closed.

let isPreloading = false;
let pacsTabId = null;
let scheduledPatients = [];
const refreshesInProgress = new Set();
// Tracks patients whose pre-visit auto-refresh has already been queued this session
const visitAutoQueued = new Set();

chrome.runtime.onInstalled.addListener(() => {
  console.log('[PACS Preloader] Extension installed');
  chrome.alarms.create('pollRefreshes', { periodInMinutes: 10 / 60 }); // every 10s
  chrome.alarms.create('checkVisitTimes', { periodInMinutes: 1 });    // every 1 min
  chrome.alarms.create('pollPreloads', { periodInMinutes: 30 / 60 }); // every 30s
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'pollRefreshes') pollPendingRefreshes();
  if (alarm.name === 'checkVisitTimes') checkVisitTimes().catch(console.error);
  if (alarm.name === 'pollPreloads') pollPendingPreloads().catch(console.error);
});

// ── Message listener (from popup) ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'startPreload') {
    runPreload(msg).catch(console.error);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.action === 'getStatus') {
    sendResponse({ isPreloading, patientCount: scheduledPatients.length });
    return true;
  }
});

// Send a message to the popup; silently ignore if popup is closed.
function postToPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}


// ── Preload loop ──
async function runPreload({ patients, serverUrl, clinicDate, filters, tabId, tabConcurrency = 1 }) {
  if (isPreloading) return;
  isPreloading = true;
  pacsTabId = tabId;
  scheduledPatients = patients;

  const n = Math.min(Math.max(1, tabConcurrency), 4);
  postToPopup({ action: 'preloadLog', text: `Starting preload: ${patients.length} patient(s)${clinicDate ? ' — clinic ' + clinicDate : ''}${n > 1 ? ` · ${n} parallel tabs` : ''}`, cls: 'info' });

  const { tabIds, openedByUs } = await openPacsTabs(n, tabId);
  pacsTabId = tabIds[0]; // keep primary tab for auto-refresh recovery
  console.log(`[Preload] tabs: ${tabIds.join(', ')} | opened by us: ${openedByUs.join(', ') || 'none'}`);

  // Distribute patients round-robin across tabs
  const queues = tabIds.map(() => []);
  patients.forEach((pt, i) => queues[i % tabIds.length].push({ pt, globalIndex: i }));

  let completedCount = 0;
  let totalImages = 0;

  await Promise.all(tabIds.map((tid, wi) =>
    (async () => {
      for (const { pt, globalIndex } of queues[wi]) {
        postToPopup({ action: 'preloadProgress', current: completedCount, total: patients.length, label: `Searching: ${pt.name}` });
        postToPopup({ action: 'preloadLog', text: `\n[${globalIndex + 1}/${patients.length}] ${pt.name} (DOB: ${pt.dob}) [tab ${tid}]`, cls: 'info' });
        console.log(`[Preload] tab ${tid} worker ${wi} → patient ${globalIndex + 1}/${patients.length}: ${pt.name}`);
        try {
          totalImages += await preloadPatient(pt, serverUrl, clinicDate, filters, tid);
        } catch (err) {
          postToPopup({ action: 'preloadLog', text: `  ✗ Error: ${err.message}`, cls: 'error' });
        }
        if (pt.visitTime) await setPatientClinicTime(pt, serverUrl);
        completedCount++;
        await sleep(300);
      }
    })()
  ));

  // Close any tabs we opened (leave pre-existing PACS tabs alone)
  for (const tid of openedByUs) {
    console.log(`[Preload] closing tab ${tid}`);
    chrome.tabs.remove(tid).catch(() => {});
  }

  postToPopup({ action: 'preloadProgress', current: patients.length, total: patients.length, label: 'Done!' });
  postToPopup({ action: 'preloadLog', text: `\n✓ Preload complete! ${totalImages} total image(s) saved.`, cls: 'success' });
  postToPopup({ action: 'preloadDone' });
  isPreloading = false;
}


// ── Open / reuse PACS tabs for parallel preload ──
async function openPacsTabs(n, seedTabId) {
  const allTabs = await chrome.tabs.query({}).catch(() => []);
  const pacsTabs = allTabs.filter(t => t.url && t.url.includes('pacs.renoortho.com'));

  // Seed tab (user's active tab) goes first, then any other existing PACS tabs
  const ordered = seedTabId
    ? [pacsTabs.find(t => t.id === seedTabId), ...pacsTabs.filter(t => t.id !== seedTabId)].filter(Boolean)
    : pacsTabs;

  const tabIds = ordered.slice(0, n).map(t => t.id);
  const openedByUs = [];

  while (tabIds.length < n) {
    const tab = await chrome.tabs.create({ url: 'https://pacs.renoortho.com/InteleBrowser/app', active: false });
    tabIds.push(tab.id);
    openedByUs.push(tab.id);
    await waitForTabLoad(tab.id);
    await sleep(1000); // settle time for PACS app JS to initialise
  }

  // Inject content script into all tabs (no-op if already injected)
  for (const tid of tabIds) {
    await chrome.scripting.executeScript({ target: { tabId: tid }, files: ['content.js'] }).catch(() => {});
    await sleep(150);
  }

  return { tabIds, openedByUs };
}

async function waitForTabLoad(tabId, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || tab.status === 'complete') return;
    await sleep(500);
  }
}


// ── Per-patient preload ──
async function preloadPatient(pt, serverUrl, clinicDate, filters, tabId) {
  const result = await sendToContentScriptTab(tabId || pacsTabId, 'searchPatient', {
    name: pt.name,
    dob: pt.dob,
    filters,
  });

  if (result.error) {
    postToPopup({ action: 'preloadLog', text: `  ✗ Search error: ${result.error}`, cls: 'error' });
    await registerPatientPlaceholder(pt, serverUrl, clinicDate);
    return 0;
  }
  if (!result.studies || result.studies.length === 0) {
    postToPopup({ action: 'preloadLog', text: `  ✗ No studies found — adding to viewer for manual refresh`, cls: 'error' });
    await registerPatientPlaceholder(pt, serverUrl, clinicDate);
    return 0;
  }

  postToPopup({ action: 'preloadLog', text: `  Found ${result.studies.length} study(ies)`, cls: 'success' });
  let count = 0;

  // Log all studies upfront before parallel execution
  for (const study of result.studies) {
    if (!study.series || study.series.length === 0) {
      postToPopup({ action: 'preloadLog', text: `  ${study.description || 'Unknown study'} — no series`, cls: 'error' });
    } else {
      postToPopup({ action: 'preloadLog', text: `  ${study.description || 'Unknown study'}`, cls: 'info' });
    }
  }

  const eligibleStudies = result.studies.filter(s => s.series && s.series.length > 0);
  const sentResults = await Promise.all(
    eligibleStudies.map(study =>
      sendToContentScriptTab(tabId || pacsTabId, 'batchPreloadStudy', {
        studyUid:         study.studyUid,
        series:           study.series,
        patient:          { name: pt.name, dob: pt.dob, provider: pt.provider || '' },
        studyDescription: study.description || '',
        studyDate:        study.studyDate || '',
        modality:         study.modality || '',
        serverUrl,
        clinicDate,
      }).catch(e => ({ error: e.message, count: 0 }))
    )
  );

  for (const [i, sent] of sentResults.entries()) {
    const study = eligibleStudies[i];
    if (sent.error) {
      postToPopup({ action: 'preloadLog', text: `    ✗ ${study.description}: ${sent.error}`, cls: 'error' });
      continue;
    }
    if (sent.studyDate) postToPopup({ action: 'preloadLog', text: `    Study date: ${sent.studyDate}`, cls: 'info' });
    postToPopup({ action: 'preloadLog', text: `    ✓ ${sent.count} image(s) from ${study.series.length} series (${study.description})`, cls: 'success' });
    count += sent.count || 0;
  }

  await fetch(`${serverUrl}/api/flush-index`, { method: 'POST' }).catch(() => {});
  return count;
}

async function registerPatientPlaceholder(pt, serverUrl, clinicDate) {
  try {
    const form = new FormData();
    form.append('patient_name', pt.name);
    form.append('patient_dob', pt.dob);
    form.append('clinic_date', clinicDate);
    form.append('clinic_time', pt.visitTime || '');
    form.append('provider', pt.provider || '');
    await fetch(`${serverUrl}/api/patients/register`, { method: 'POST', body: form });
  } catch (e) { /* non-critical */ }
}

async function setPatientClinicTime(pt, serverUrl) {
  try {
    const form = new FormData();
    form.append('patient_name', pt.name);
    form.append('patient_dob', pt.dob);
    form.append('clinic_time', pt.visitTime || '');
    await fetch(`${serverUrl}/api/patients/register`, { method: 'POST', body: form });
  } catch (e) { /* non-critical */ }
}


// ── Pending Refresh Poll ──
async function pollPendingRefreshes() {
  if (isPreloading) return;
  console.log('[Refresh] poll fired — pacsTabId:', pacsTabId);

  // Recover pacsTabId if service worker restarted (in-memory state lost)
  if (!pacsTabId) {
    const allTabs = await chrome.tabs.query({}).catch(() => []);
    console.log('[Refresh] all tabs:', allTabs.map(t => t.id + ' ' + t.url));
    const pacsTabs = allTabs.filter(t => t.url && t.url.includes('pacs.renoortho.com'));
    console.log('[Refresh] PACS tabs found:', pacsTabs.length);
    if (!pacsTabs.length) { console.log('[Refresh] no PACS tab — aborting'); return; }
    pacsTabId = pacsTabs[0].id;
    console.log('[Refresh] recovered pacsTabId:', pacsTabId);
  }

  try {
    const saved = await chrome.storage.local.get(['serverUrl', 'clinicDate']);
    const serverUrl = (saved.serverUrl || 'http://localhost:8888').replace(/\/$/, '');
    console.log('[Refresh] serverUrl:', serverUrl);
    const clinicDate = saved.clinicDate || '';
    // Refreshes only fetch new X-rays — fast targeted lookup
    const baseFilters = await getFiltersFromStorage();
    const filters = { ...baseFilters, modalities: ['xr'] };

    const resp = await fetch(`${serverUrl}/api/pending_refreshes`);
    if (!resp.ok) { console.log('[Refresh] pending_refreshes returned', resp.status); return; }
    const data = await resp.json();
    const pendingKeys = Object.keys(data.pending || {});
    console.log('[Refresh] pending keys:', pendingKeys);

    for (const [key] of Object.entries(data.pending || {})) {
      if (refreshesInProgress.has(key)) { console.log('[Refresh] already in progress:', key); continue; }

      // Try in-memory list first; fall back to server lookup (handles service worker restart)
      let patient = scheduledPatients.find(p => buildPatientKey(p) === key);
      if (!patient) {
        console.log('[Refresh] patient not in memory — fetching from server:', key);
        try {
          const pr = await fetch(`${serverUrl}/api/patients/${encodeURIComponent(key)}`);
          console.log('[Refresh] patient fetch status:', pr.status);
          if (!pr.ok) continue;
          const pd = await pr.json();
          patient = { name: pd.name, dob: pd.dob, provider: pd.provider || '', clinic_date: pd.clinic_date || '' };
          console.log('[Refresh] patient from server:', patient.name);
        } catch (e) { console.log('[Refresh] patient fetch error:', e.message); continue; }
      }

      refreshesInProgress.add(key);
      postToPopup({ action: 'preloadLog', text: `Auto-refreshing: ${patient.name}`, cls: 'info' });
      console.log('[Refresh] starting preloadPatient for', patient.name);
      try {
        const ptClinicDate = clinicDate || patient.clinic_date || '';
        await preloadPatient(patient, serverUrl, ptClinicDate, filters);
        await fetch(`${serverUrl}/api/pending_refreshes/${encodeURIComponent(key)}`, { method: 'DELETE' });
        console.log('[Refresh] done + cleared pending for', patient.name);
      } catch (e) {
        console.log('[Refresh] preloadPatient error:', e.message);
        postToPopup({ action: 'preloadLog', text: `  ✗ Refresh error: ${e.message}`, cls: 'error' });
      }
      refreshesInProgress.delete(key);
    }
  } catch (e) { console.log('[Refresh] outer error:', e.message); }
}

async function getFiltersFromStorage() {
  const saved = await chrome.storage.local.get(['lastFilters']);
  return saved.lastFilters || { regions: null, modalities: ['xr', 'ct', 'mr'] };
}


// ── Helpers ──
function buildPatientKey(pt) {
  const combined = `${pt.name}_${pt.dob}`;
  return combined.replace(/[^\w\s\-.]/g, '').replace(/\s+/g, '_').slice(0, 100);
}

async function sendToContentScript(action, data) {
  return sendToContentScriptTab(pacsTabId, action, data);
}

async function sendToContentScriptTab(tabId, action, data) {
  try {
    return await _sendTabMessage(tabId, action, data);
  } catch (e) {
    if (e.message.includes('Receiving end does not exist')) {
      console.log('[Preload] content script missing — injecting into tab', tabId);
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      await sleep(400);
      return await _sendTabMessage(tabId, action, data);
    }
    throw e;
  }
}

function _sendTabMessage(tabId, action, data) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { action, ...data }, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response || {});
      }
    });
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}


// ── Pending Preloads (from nightly loader / schedule import) ──
// Polls for patients imported via /api/schedule/import and runs them through
// the same full preload path as clicking "Preload Images" in the popup.
async function pollPendingPreloads() {
  if (isPreloading) return;

  // Need a PACS tab to search
  if (!pacsTabId) {
    const allTabs = await chrome.tabs.query({}).catch(() => []);
    const pacsTabs = allTabs.filter(t => t.url && t.url.includes('pacs.renoortho.com'));
    if (!pacsTabs.length) return;
    pacsTabId = pacsTabs[0].id;
  }

  try {
    const saved = await chrome.storage.local.get(['serverUrl']);
    const serverUrl = (saved.serverUrl || 'http://localhost:8888').replace(/\/$/, '');

    const resp = await fetch(`${serverUrl}/api/pending_preloads`);
    if (!resp.ok) return;
    const data = await resp.json();

    if (!data.patients || data.patients.length === 0) return;

    console.log(`[Preload] Found ${data.patients.length} pending patient(s) from schedule import`);

    // Use full filters from storage — same as popup checkbox state
    const filters = await getFiltersFromStorage();
    const clinicDate = data.clinic_date || '';

    // Clear the queue immediately so we don't re-trigger on next poll
    await fetch(`${serverUrl}/api/pending_preloads`, { method: 'DELETE' }).catch(() => {});

    // Run through the exact same path as clicking "Preload Images"
    await runPreload({
      patients: data.patients,
      serverUrl,
      clinicDate,
      filters,
      tabId: pacsTabId,
    });
  } catch (e) {
    console.log('[Preload] poll error:', e.message);
  }
}


// ── Pre-visit Auto-refresh ──
// Queues a refresh for any patient whose clinic visit is within the next 5 minutes.
async function checkVisitTimes() {
  const saved = await chrome.storage.local.get(['serverUrl']);
  const serverUrl = (saved.serverUrl || 'http://localhost:8888').replace(/\/$/, '');

  let data;
  try {
    const resp = await fetch(`${serverUrl}/api/patients`);
    if (!resp.ok) return;
    data = await resp.json();
  } catch (e) { return; }

  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  for (const p of (data.patients || [])) {
    if (!p.clinic_time || visitAutoQueued.has(p.key)) continue;

    // Only auto-refresh for patients scheduled TODAY
    if (!p.clinic_date || normalizeToIso(p.clinic_date) !== todayStr) continue;

    const visitDate = parseClinicTime(p.clinic_time);
    if (!visitDate) continue;

    const diffMs = visitDate - now;
    // Queue if visit is 0–6 minutes away (catches the 1-min poll window before the 5-min mark)
    if (diffMs >= 0 && diffMs <= 6 * 60 * 1000) {
      visitAutoQueued.add(p.key);
      console.log(`[VisitTime] Auto-refresh for ${p.name} — visit at ${p.clinic_time}`);
      postToPopup({ action: 'preloadLog', text: `Auto-refresh: ${p.name} visits at ${p.clinic_time}`, cls: 'info' });
      try {
        await fetch(`${serverUrl}/api/patients/${encodeURIComponent(p.key)}/request-refresh`, { method: 'POST' });
      } catch (e) { console.error('[VisitTime] queue error:', e.message); }
    }
  }
}

/**
 * Normalize a date string (YYYY-MM-DD or MM/DD/YYYY) to YYYY-MM-DD for comparison.
 */
function normalizeToIso(dateStr) {
  if (!dateStr) return '';
  // Already ISO: 2026-03-14
  const iso = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return dateStr;
  // US format: 3/14/2026 or 03/14/2026
  const us = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return `${us[3]}-${us[1].padStart(2,'0')}-${us[2].padStart(2,'0')}`;
  return dateStr;
}

function parseClinicTime(timeStr) {
  const m = timeStr.match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ampm = m[3].toUpperCase();
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  const d = new Date();
  d.setHours(h, min, 0, 0);
  return d;
}
