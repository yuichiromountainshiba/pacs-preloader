// background.js — Service worker for PACS Preloader extension
// Handles the preload loop so it survives the popup being closed.

let isPreloading = false;
let pacsTabId = null;
let scheduledPatients = [];
const refreshesInProgress = new Set();
let refreshPollRunning = false;
let pacsLoginNotified = false;  // only notify once per session about login
// Tracks which auto-refresh passes have fired per patient: key → Set of pass names
const visitAutoQueued = new Map();

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

  // No owned tabs alive — try to find an existing logged-in PACS tab first
  for (const t of pacsTabs) {
    try {
      const ping = await withTimeout(_sendTabMessage(t.id, 'ping', {}), 3000, 'ping timeout');
      if (ping && ping.hasSession) {
        debugLog('refresh', 'info', 'refresh', `Reclaimed existing logged-in PACS tab ${t.id}`, {
          subspecialty: typeof SUBSPECIALTY !== 'undefined' ? SUBSPECIALTY.id : 'unknown',
        });
        await claimPacsTab(t.id);
        return t.id;
      }
    } catch { /* tab unresponsive or no content script */ }
  }

  // No logged-in tabs found — open a new dedicated tab
  debugLog('refresh', 'info', 'refresh', 'No owned or logged-in PACS tab found — opening dedicated tab', {
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

function ensureAlarms() {
  chrome.alarms.create('pollRefreshes', { periodInMinutes: 0.5 });    // every 30s (MV3 min)
  chrome.alarms.create('checkVisitTimes', { periodInMinutes: 1 });    // every 1 min
  chrome.alarms.create('pollPreloads', { periodInMinutes: 0.5 });     // every 30s
  console.log('[PACS Preloader] Alarms created/refreshed');
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('[PACS Preloader] Extension installed — v2.1.0-debug');
  chrome.storage.local.set({ ownedPacsTabs: [] });
  ensureAlarms();
});

// Also create alarms on browser startup (onInstalled doesn't fire on restart)
chrome.runtime.onStartup.addListener(() => {
  console.log('[PACS Preloader] Browser started — ensuring alarms');
  ensureAlarms();
});

// Safety net: if service worker wakes for any reason, verify alarms exist
chrome.alarms.getAll(alarms => {
  const names = alarms.map(a => a.name);
  if (!names.includes('checkVisitTimes') || !names.includes('pollRefreshes')) {
    console.log('[PACS Preloader] Missing alarms detected — recreating');
    ensureAlarms();
  }
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
  const runStart = Date.now();
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
        // Activate the tab so Chrome doesn't throttle content script timers
        try { await chrome.tabs.update(tid, { active: true }); } catch {}
        postToPopup({ action: 'preloadProgress', current: completedCount, total: patients.length, label: `Searching: ${pt.name}` });
        postToPopup({ action: 'preloadLog', text: `\n[${globalIndex + 1}/${patients.length}] ${pt.name} (DOB: ${pt.dob}) [tab ${tid}]`, cls: 'info' });
        console.log(`[Preload] tab ${tid} worker ${wi} → patient ${globalIndex + 1}/${patients.length}: ${pt.name}`);
        try {
          totalImages += await withTimeout(
            preloadPatient(pt, serverUrl, clinicDate, filters, tid),
            300000, // 5 min max per patient
            `Preload timed out for ${pt.name}`,
          );
        } catch (err) {
          postToPopup({ action: 'preloadLog', text: `  ✗ Error: ${err.message}`, cls: 'error' });
          debugLog('preload', 'error', 'timeout', `Nightly preload failed: ${pt.name}`, { error: err.message });
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

  const elapsed = Date.now() - runStart;
  const mins = Math.floor(elapsed / 60000);
  const secs = Math.floor((elapsed % 60000) / 1000);
  const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  debugLog('preload', 'pass', 'summary', `Preload complete: ${totalImages} image(s) in ${timeStr}`, {
    elapsed_ms: elapsed,
    total_images: totalImages,
    total_patients: patients.length,
    tabs_used: n,
  });

  postToPopup({ action: 'preloadProgress', current: patients.length, total: patients.length, label: 'Done!' });
  postToPopup({ action: 'preloadLog', text: `\n✓ Preload complete! ${totalImages} total image(s) saved in ${timeStr} (${patients.length} patients, ${n} tabs).`, cls: 'success' });
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
async function preloadPatient(pt, serverUrl, clinicDate, filters, tabId, { todayOnly = false, patientKey = '' } = {}) {
  // Always register first so the patient appears in the viewer with the correct
  // clinic_date immediately, regardless of whether image uploads succeed later.
  await registerPatientPlaceholder(pt, serverUrl, clinicDate, patientKey);

  debugLog('preload', 'start', 'search', `Searching PACS for ${pt.name}`, {
    patient_key: patientKey || undefined,
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
    debugLog('preload', 'error', 'search', `Search error: ${pt.name}`, { patient_key: patientKey || undefined, error: result.error });
    postToPopup({ action: 'preloadLog', text: `  ✗ Search error: ${result.error}`, cls: 'error' });
    if (patientKey) await updateRefreshStatus(serverUrl, patientKey, 'error', result.error);
    return 0;
  }
  if (!result.studies || result.studies.length === 0) {
    debugLog('preload', 'warn', 'search', `No studies found: ${pt.name}`, { patient_key: patientKey || undefined });
    postToPopup({ action: 'preloadLog', text: `  ✗ No studies found — adding to viewer for manual refresh`, cls: 'error' });
    if (patientKey) await updateRefreshStatus(serverUrl, patientKey, 'no_results', 'No studies found in PACS');
    return 0;
  }

  debugLog('preload', 'pass', 'search', `Found ${result.studies.length} study(ies) for ${pt.name}`, {
    patient_key: patientKey || undefined,
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
        patient_key: patientKey || undefined,
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
  if (patientKey) await updateRefreshStatus(serverUrl, patientKey, 'downloading', `${eligibleStudies.length} study(ies) found — downloading images`);
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
        patientKey,
      }).catch(e => ({ error: e.message, count: 0 }))
    )
  );

  const studyResults = [];
  for (const [i, sent] of sentResults.entries()) {
    const study = eligibleStudies[i];
    if (sent.error) {
      postToPopup({ action: 'preloadLog', text: `    ✗ ${study.description}: ${sent.error}`, cls: 'error' });
      studyResults.push({ desc: study.description, modality: study.modality, date: study.studyDate, error: sent.error, images: 0 });
      continue;
    }
    if (sent.studyDate) postToPopup({ action: 'preloadLog', text: `    Study date: ${sent.studyDate}`, cls: 'info' });
    postToPopup({ action: 'preloadLog', text: `    ✓ ${sent.count} image(s) from ${study.series.length} series (${study.description})`, cls: 'success' });
    studyResults.push({ desc: study.description, modality: study.modality, date: study.studyDate, series: study.series.length, images: sent.count || 0 });
    count += sent.count || 0;
  }

  // Audit trail: post summary to server for per-patient log
  const auditEntry = {
    at: new Date().toISOString(),
    todayOnly,
    filters: { modalities: filters?.modalities, regions: filters?.regions },
    studies_found: result.studies.length,
    studies_downloaded: eligibleStudies.length,
    total_images: count,
    study_results: studyResults,
    skipped_studies: result.studies
      .filter(s => !s.series || s.series.length === 0)
      .map(s => ({ desc: s.description, modality: s.modality, date: s.studyDate, reason: 'no series (possible MRI misclassification)' })),
  };
  const auditKey = patientKey || `${pt.name}_${pt.dob}`.replace(/[^a-zA-Z0-9_\-]/g, '_');
  fetch(`${serverUrl}/api/patients/${encodeURIComponent(auditKey)}/audit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(auditEntry),
  }).catch(() => {});

  await fetch(`${serverUrl}/api/flush-index`, { method: 'POST' }).catch(() => {});
  return count;
}

async function registerPatientPlaceholder(pt, serverUrl, clinicDate, patientKey = '') {
  try {
    const form = new FormData();
    form.append('patient_name', pt.name);
    form.append('patient_dob', pt.dob);
    form.append('clinic_date', clinicDate);
    form.append('clinic_time', pt.visitTime || '');
    form.append('provider', pt.provider || '');
    if (patientKey) form.append('patient_key', patientKey);
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
  // Allow refreshes even while a bulk preload is running — they use the same
  // PACS tab but are serialised via refreshesInProgress so they won't collide.
  // Only skip if another refresh poll is already mid-flight.
  if (refreshPollRunning) return;
  refreshPollRunning = true;

  try {
    // Recover pacsTabId if service worker restarted (in-memory state lost)
    if (!pacsTabId) {
      pacsTabId = await recoverOwnPacsTab();
      if (!pacsTabId) return;
    }

    const saved = await chrome.storage.local.get(['serverUrl', 'clinicDate']);
    const serverUrl = (saved.serverUrl || 'http://localhost:8888').replace(/\/$/, '');
    const clinicDate = saved.clinicDate || '';
    const baseFilters = await getFiltersFromStorage();

    const resp = await fetch(`${serverUrl}/api/pending_refreshes`);
    if (!resp.ok) return;
    const data = await resp.json();
    const pendingKeys = Object.keys(data.pending || {});
    if (pendingKeys.length === 0) return;

    debugLog('refresh', 'info', 'refresh', `Found ${pendingKeys.length} pending refresh(es)`, {
      keys: pendingKeys,
      types: Object.fromEntries(Object.entries(data.pending || {}).map(([k, v]) => [k, typeof v === 'object' ? v.type : 'legacy'])),
    });

    // ── Check PACS login before attempting any refreshes ──
    let pacsLoggedIn = false;
    try {
      const ping = await withTimeout(
        _sendTabMessage(pacsTabId, 'ping', {}),
        5000, 'ping timeout',
      );
      pacsLoggedIn = !!(ping && ping.hasSession);
    } catch { /* tab dead or unresponsive */ }

    if (!pacsLoggedIn) {
      debugLog('refresh', 'warn', 'refresh', 'PACS not logged in — skipping refreshes, will retry next poll', {
        pending_count: pendingKeys.length,
      });
      if (!pacsLoginNotified) {
        pacsLoginNotified = true;
        chrome.notifications.create('pacs-login', {
          type: 'basic',
          iconUrl: 'icon128.png',
          title: 'PACS Not Logged In',
          message: `${pendingKeys.length} refresh(es) waiting — log into PACS to process them`,
          priority: 2,
        });
      }

      // Don't expire anything while logged out — wait for login so the main loop
      // can handle expiry correctly (distinguishing auto vs manual refreshes).
      return;
    }
    // PACS is logged in — clear the notification flag so we re-notify if it logs out again
    pacsLoginNotified = false;

    for (const [key, meta] of Object.entries(data.pending || {})) {
      if (refreshesInProgress.has(key)) continue;

      // Determine refresh type — supports both old (string timestamp) and new (object) format
      const refreshType = (typeof meta === 'object' && meta.type) ? meta.type : 'auto';
      const isFull = refreshType === 'full';
      const isManualToday = refreshType === 'today';

      // Only expire auto-queued refreshes (not manual "today" or "full" from viewer)
      if (!isFull && !isManualToday && (await isAppointmentPast(key, serverUrl))) {
        debugLog('refresh', 'info', 'refresh', `Auto-refresh expired (appointment passed): ${key}`);
        await fetch(`${serverUrl}/api/pending_refreshes/${encodeURIComponent(key)}`, { method: 'DELETE' }).catch(() => {});
        continue;
      }

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
          patient = { name: pd.name, dob: pd.dob, provider: pd.provider || '', clinic_date: pd.clinic_date || '', clinic_time: pd.clinic_time || '' };
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
        // Clear the stuck pending entry so the spinner stops
        await fetch(`${serverUrl}/api/pending_refreshes/${encodeURIComponent(key)}`, { method: 'DELETE' }).catch(() => {});
        continue;
      }

      refreshesInProgress.add(key);
      // Activate the PACS tab so Chrome doesn't throttle content script timers
      try { await chrome.tabs.update(pacsTabId, { active: true }); } catch {}
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
      await updateRefreshStatus(serverUrl, key, 'searching', `Searching PACS for ${patient.name}`);

      try {
        const ptClinicDate = clinicDate || patient.clinic_date || '';
        // Wrap preloadPatient in a timeout so a hung content script can't block forever
        await withTimeout(
          preloadPatient(patient, serverUrl, ptClinicDate, filters, undefined, { todayOnly, patientKey: key }),
          90000, // 90s max per patient refresh
          `Refresh timed out for ${patient.name}`,
        );
        debugLog('refresh', 'pass', 'refresh', `${typeLabel} refresh complete: ${patient.name}`);
      } catch (e) {
        debugLog('refresh', 'error', 'refresh', `Refresh error: ${patient.name}`, { error: e.message });
        postToPopup({ action: 'preloadLog', text: `  ✗ Refresh error: ${e.message}`, cls: 'error' });
      }
      // Always clear server pending + local tracking so spinner stops
      await fetch(`${serverUrl}/api/pending_refreshes/${encodeURIComponent(key)}`, { method: 'DELETE' }).catch(() => {});
      refreshesInProgress.delete(key);
    }
  } catch (e) { debugLog('refresh', 'error', 'refresh', 'Poll outer error', { error: e.message }); }
  finally { refreshPollRunning = false; }
}

async function getFiltersFromStorage() {
  const saved = await chrome.storage.local.get(['lastFilters']);
  const filters = saved.lastFilters || { modalities: ['xr', 'ct', 'mr'] };
  // Always enforce region filters — never allow null/empty
  if (!filters.regions || filters.regions.length === 0) {
    filters.regions = ['lumbar', 'cervical', 'thoracic'];
  }
  return filters;
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
  debugLog('background', 'info', 'tab-message', `Sending "${action}" to tab ${tabId}`, {
    tab_id: tabId,
    action,
    patient_name: data?.name || data?.patient?.name || undefined,
  });
  try {
    const result = await _sendTabMessage(tabId, action, data);
    debugLog('background', 'pass', 'tab-message', `Tab ${tabId} responded to "${action}"`, {
      tab_id: tabId,
      action,
      has_error: !!result?.error,
      study_count: result?.studies?.length,
    });
    return result;
  } catch (e) {
    if (e.message.includes('Receiving end does not exist')) {
      debugLog('background', 'warn', 'tab-message', `Content script missing in tab ${tabId} — re-injecting`, { tab_id: tabId });
      // Must inject config.js first so SUBSPECIALTY is defined when content.js loads
      await chrome.scripting.executeScript({ target: { tabId }, files: ['config.js'] }).catch(() => {});
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      await sleep(400);
      return await _sendTabMessage(tabId, action, data);
    }
    debugLog('background', 'error', 'tab-message', `Tab ${tabId} message failed: ${e.message}`, { tab_id: tabId, action });
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

function updateRefreshStatus(serverUrl, key, status, detail) {
  return fetch(`${serverUrl}/api/pending_refreshes/${encodeURIComponent(key)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, detail }),
  }).catch(() => {});
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      val => { clearTimeout(timer); resolve(val); },
      err => { clearTimeout(timer); reject(err); },
    );
  });
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

    // Nightly/schedule preloads always use all modalities to ensure MRIs aren't missed
    const baseFilters = await getFiltersFromStorage();
    const filters = { ...baseFilters, modalities: ['xr', 'ct', 'mr'] };
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
      tabConcurrency: 3,
    });
  } catch (e) {
    console.log('[Preload] poll error:', e.message);
  }
}


// ── Pre-visit Auto-refresh ──
// Queues a refresh at ~12 min and ~6 min before each patient's appointment.
const REFRESH_PASSES = [
  { name: 'early', minBefore: 13, maxBefore: 7 },  // fires ~12 min out (13–7 min window)
  { name: 'near',  minBefore: 7,  maxBefore: 0 },   // fires ~6 min out  (7–0 min window)
];

async function checkVisitTimes() {
  const saved = await chrome.storage.local.get(['serverUrl']);
  const serverUrl = (saved.serverUrl || 'http://localhost:8888').replace(/\/$/, '');

  let data;
  try {
    const resp = await fetch(`${serverUrl}/api/patients`);
    if (!resp.ok) { debugLog('visittime', 'error', 'visit-check', `Server returned ${resp.status}`); return; }
    data = await resp.json();
  } catch (e) { debugLog('visittime', 'error', 'visit-check', `Cannot reach server: ${e.message}`); return; }

  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const todayPatients = (data.patients || []).filter(p => p.clinic_time && p.clinic_date && normalizeToIso(p.clinic_date) === todayStr);

  let queued = 0;
  for (const p of todayPatients) {
    const visitDate = parseClinicTime(p.clinic_time);
    if (!visitDate) continue;

    const diffMs = visitDate - now;
    const diffMin = Math.round(diffMs / 60000);
    const firedPasses = visitAutoQueued.get(p.key) || new Set();

    for (const pass of REFRESH_PASSES) {
      if (firedPasses.has(pass.name)) continue;
      if (diffMs >= pass.maxBefore * 60000 && diffMs <= pass.minBefore * 60000) {
        firedPasses.add(pass.name);
        visitAutoQueued.set(p.key, firedPasses);
        queued++;
        debugLog('visittime', 'pass', 'auto-queue', `Auto-refresh [${pass.name}] queued: ${p.name} — visit in ${diffMin}min at ${p.clinic_time}`, { key: p.key, pass: pass.name });
        postToPopup({ action: 'preloadLog', text: `Auto-refresh (${pass.name}): ${p.name} visits at ${p.clinic_time}`, cls: 'info' });
        try {
          await fetch(`${serverUrl}/api/patients/${encodeURIComponent(p.key)}/request-refresh`, { method: 'POST' });
        } catch (e) { debugLog('visittime', 'error', 'auto-queue', `Queue error: ${e.message}`, { key: p.key }); }
      }
    }
  }

  const allFired = [...visitAutoQueued.values()].reduce((n, s) => n + s.size, 0);
  debugLog('visittime', 'info', 'visit-check', `Checked ${todayPatients.length} patients for today, ${queued} queued this cycle, ${allFired} total passes fired`, {
    next_upcoming: todayPatients
      .filter(p => {
        const fired = visitAutoQueued.get(p.key);
        return (!fired || fired.size < REFRESH_PASSES.length) && parseClinicTime(p.clinic_time) > now;
      })
      .slice(0, 3)
      .map(p => ({ name: p.name, time: p.clinic_time, mins_away: Math.round((parseClinicTime(p.clinic_time) - now) / 60000) })),
  });
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

/**
 * Check if a patient's appointment time has already passed.
 * Returns true if the appointment was today and the time is in the past.
 */
async function isAppointmentPast(patientKey, serverUrl) {
  try {
    const pr = await fetch(`${serverUrl}/api/patients/${encodeURIComponent(patientKey)}`);
    if (!pr.ok) return false;
    const pd = await pr.json();
    if (!pd.clinic_time) return false;
    const visitDate = parseClinicTime(pd.clinic_time);
    if (!visitDate) return false;
    return visitDate < new Date();
  } catch { return false; }
}
