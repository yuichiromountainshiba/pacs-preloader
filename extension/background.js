// background.js — Service worker for PACS Preloader extension
// Handles the preload loop so it survives the popup being closed.

let isPreloading = false;
let pacsTabId = null;
let scheduledPatients = [];
const refreshesInProgress = new Set();
// Tracks patients whose pre-visit auto-refresh has already been queued this session
const visitAutoQueued = new Set();

// ── Debug logging helper ──
const _debugQueue = [];
let _debugFlushTimer = null;

function debugLog(source, level, category, message, details = {}) {
  console.log(`[DEBUG:${source}] ${message}`, details);
  _debugQueue.push({ source, level, category, message, details, ts: new Date().toISOString() });
  if (!_debugFlushTimer) {
    _debugFlushTimer = setTimeout(flushDebugLog, 300);
  }
}

async function flushDebugLog() {
  _debugFlushTimer = null;
  if (_debugQueue.length === 0) return;
  const batch = _debugQueue.splice(0);
  try {
    const saved = await chrome.storage.local.get(['serverUrl']);
    const serverUrl = (saved.serverUrl || 'http://localhost:8888').replace(/\/$/, '');
    await fetch(`${serverUrl}/api/debug-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });
  } catch (e) { /* debug logging is best-effort */ }
}

// ── PACS tab ownership ──
// Each extension variant (spine/hipknee) claims its own PACS tab(s) so they
// don't fight over the same search box when running in parallel.
const EXT_ID = chrome.runtime.id;  // unique per extension install

async function claimPacsTab(tabId) {
  const saved = await chrome.storage.local.get(['ownedPacsTabs']) || {};
  const owned = saved.ownedPacsTabs || [];
  if (!owned.includes(tabId)) owned.push(tabId);
  await chrome.storage.local.set({ ownedPacsTabs: owned });
}

async function getOwnedTabIds() {
  const saved = await chrome.storage.local.get(['ownedPacsTabs']);
  return saved.ownedPacsTabs || [];
}

/**
 * Recover a PACS tab that belongs to THIS extension.
 * If this extension previously claimed a tab and it's still open, use it.
 * If another extension owns all existing PACS tabs, open a new one.
 */
async function recoverOwnPacsTab() {
  const allTabs = await chrome.tabs.query({}).catch(() => []);
  const pacsTabs = allTabs.filter(t => t.url && t.url.includes('pacs.renoortho.com'));
  if (!pacsTabs.length) return null;

  // Check which tabs we previously claimed
  const ownedIds = await getOwnedTabIds();
  const ownedAlive = pacsTabs.filter(t => ownedIds.includes(t.id));

  if (ownedAlive.length > 0) {
    const tid = ownedAlive[0].id;
    debugLog('refresh', 'info', 'refresh', `Using owned PACS tab ${tid}`, { subspecialty: typeof SUBSPECIALTY !== 'undefined' ? SUBSPECIALTY.id : 'unknown' });
    return tid;
  }

  // No owned tabs alive — open a new dedicated tab for this extension
  debugLog('refresh', 'info', 'refresh', 'No owned PACS tab found — opening dedicated tab', {
    subspecialty: typeof SUBSPECIALTY !== 'undefined' ? SUBSPECIALTY.id : 'unknown',
    existing_pacs_tabs: pacsTabs.map(t => t.id),
  });
  const tab = await chrome.tabs.create({ url: 'https://pacs.renoortho.com/InteleBrowser/app', active: false });
  await waitForTabLoad(tab.id);
  await sleep(1000);
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['config.js'] }).catch(() => {});
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {});
  await claimPacsTab(tab.id);
  return tab.id;
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('[PACS Preloader] Extension installed — v2.1.0-debug');
  // Clear stale tab ownership on install/update
  chrome.storage.local.set({ ownedPacsTabs: [] });
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
  // Claim all tabs for this extension so refreshes don't collide with other variants
  for (const tid of tabIds) await claimPacsTab(tid);
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

  // Inject content scripts into all tabs (no-op if already injected)
  // config.js must come before content.js so SUBSPECIALTY is defined
  for (const tid of tabIds) {
    await chrome.scripting.executeScript({ target: { tabId: tid }, files: ['config.js'] }).catch(() => {});
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
async function preloadPatient(pt, serverUrl, clinicDate, filters, tabId, { todayOnly = false } = {}) {
  // Always register first so the patient appears in the viewer with the correct
  // clinic_date immediately, regardless of whether image uploads succeed later.
  await registerPatientPlaceholder(pt, serverUrl, clinicDate);

  debugLog('preload', 'start', 'search', `Searching PACS for ${pt.name}`, {
    dob: pt.dob,
    todayOnly,
    filters_modalities: filters?.modalities,
    filters_regions: filters?.regions,
  });

  const result = await sendToContentScriptTab(tabId || pacsTabId, 'searchPatient', {
    name: pt.name,
    dob: pt.dob,
    filters,
    todayOnly,
  });

  if (result.error) {
    debugLog('preload', 'error', 'search', `Search error: ${pt.name}`, { error: result.error });
    postToPopup({ action: 'preloadLog', text: `  ✗ Search error: ${result.error}`, cls: 'error' });
    return 0;
  }
  if (!result.studies || result.studies.length === 0) {
    debugLog('preload', 'warn', 'search', `No studies found: ${pt.name}`);
    postToPopup({ action: 'preloadLog', text: `  ✗ No studies found — adding to viewer for manual refresh`, cls: 'error' });
    return 0;
  }

  debugLog('preload', 'pass', 'search', `Found ${result.studies.length} study(ies) for ${pt.name}`, {
    studies: result.studies.map(s => ({
      desc: s.description,
      modality: s.modality,
      date: s.studyDate,
      dob: s.patientDob,
      series_count: s.series?.length || 0,
    })),
  });

  postToPopup({ action: 'preloadLog', text: `  Found ${result.studies.length} study(ies)`, cls: 'success' });
  let count = 0;

  // Log all studies upfront before parallel execution
  for (const study of result.studies) {
    if (!study.series || study.series.length === 0) {
      debugLog('preload', 'warn', 'mri-detect', `Study "${study.description}" has NO series — possible MRI misclassification`, {
        modality_field: study.modality,
        description: study.description,
        is_mri_by_mod: /^(MR|MRI)$/i.test(study.modality),
        is_mri_by_desc: /^(MR|MRI)[\s\-]/i.test(study.description),
      });
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
        location:         study.location || '',
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

  // Recover pacsTabId if service worker restarted (in-memory state lost)
  if (!pacsTabId) {
    pacsTabId = await recoverOwnPacsTab();
    if (!pacsTabId) return;
  }

  try {
    const saved = await chrome.storage.local.get(['serverUrl', 'clinicDate']);
    const serverUrl = (saved.serverUrl || 'http://localhost:8888').replace(/\/$/, '');
    const clinicDate = saved.clinicDate || '';
    const baseFilters = await getFiltersFromStorage();

    const resp = await fetch(`${serverUrl}/api/pending_refreshes`);
    if (!resp.ok) return;
    const data = await resp.json();
    const pendingKeys = Object.keys(data.pending || {});
    if (pendingKeys.length === 0) return;

    debugLog('refresh', 'info', 'refresh', `Found ${pendingKeys.length} pending refresh(es)`, { keys: pendingKeys });

    for (const [key, meta] of Object.entries(data.pending || {})) {
      if (refreshesInProgress.has(key)) continue;

      // Determine refresh type — supports both old (string timestamp) and new (object) format
      const refreshType = (typeof meta === 'object' && meta.type) ? meta.type : 'auto';
      const isFull = refreshType === 'full';

      // Build filters based on refresh type
      //   full:  all modalities, all dates, region filters from popup
      //   auto:  XR only, today only, region filters from popup
      const filters = isFull
        ? { ...baseFilters, modalities: ['xr', 'ct', 'mr'] }
        : { ...baseFilters, modalities: ['xr'] };
      const todayOnly = !isFull;

      // ── Name resolution: always check server first for viewer edits ──
      let patient = null;
      let nameSource = '';
      const memoryPatient = scheduledPatients.find(p => buildPatientKey(p) === key);

      debugLog('refresh', 'info', 'refresh', `Resolving name for "${key}" — checking server for latest (viewer may have edited it)`, {
        in_memory_name: memoryPatient?.name || '(not in memory)',
        refresh_type: refreshType,
      });

      try {
        const pr = await fetch(`${serverUrl}/api/patients/${encodeURIComponent(key)}`);
        if (pr.ok) {
          const pd = await pr.json();
          patient = { name: pd.name, dob: pd.dob, provider: pd.provider || '', clinic_date: pd.clinic_date || '' };
          nameSource = 'server (latest from viewer)';

          if (memoryPatient && memoryPatient.name !== pd.name) {
            debugLog('refresh', 'warn', 'refresh', `Name was edited in viewer`, {
              original_name: memoryPatient.name,
              updated_name: pd.name,
              using: 'updated name from server',
            });
          }
        }
      } catch (e) { /* fall through to in-memory */ }

      // Fall back to in-memory list only if server lookup failed
      if (!patient && memoryPatient) {
        patient = memoryPatient;
        nameSource = 'in-memory (server unreachable)';
        debugLog('refresh', 'warn', 'refresh', `Server unreachable — using in-memory name`, {
          name: patient.name,
          warning: 'If name was edited in viewer, this may be stale',
        });
      }
      if (!patient) {
        debugLog('refresh', 'error', 'refresh', `Patient not found for key "${key}"`, {
          checked_server: true,
          checked_memory: true,
        });
        continue;
      }

      refreshesInProgress.add(key);
      const typeLabel = isFull ? 'FULL (all images, any date)' : 'AUTO (today XR only)';
      debugLog('refresh', 'start', 'refresh', `${typeLabel} refresh for "${patient.name}"`, {
        name_source: nameSource,
        search_name: patient.name,
        dob: patient.dob,
        refresh_type: refreshType,
        todayOnly,
        modalities: filters.modalities,
        regions: filters.regions,
      });
      postToPopup({ action: 'preloadLog', text: `${isFull ? 'Full' : 'Auto'}-refreshing: ${patient.name}`, cls: 'info' });

      try {
        const ptClinicDate = clinicDate || patient.clinic_date || '';
        await preloadPatient(patient, serverUrl, ptClinicDate, filters, undefined, { todayOnly });
        await fetch(`${serverUrl}/api/pending_refreshes/${encodeURIComponent(key)}`, { method: 'DELETE' });
        debugLog('refresh', 'pass', 'refresh', `${typeLabel} refresh complete: ${patient.name}`);
      } catch (e) {
        debugLog('refresh', 'error', 'refresh', `Refresh error: ${patient.name}`, { error: e.message });
        postToPopup({ action: 'preloadLog', text: `  ✗ Refresh error: ${e.message}`, cls: 'error' });
      }
      refreshesInProgress.delete(key);
    }
  } catch (e) { debugLog('refresh', 'error', 'refresh', 'Poll outer error', { error: e.message }); }
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
      // Must inject config.js first so SUBSPECIALTY is defined when content.js loads
      await chrome.scripting.executeScript({ target: { tabId }, files: ['config.js'] }).catch(() => {});
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
    pacsTabId = await recoverOwnPacsTab();
    if (!pacsTabId) return;
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
