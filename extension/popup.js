// popup.js — PACS Clinic Preloader extension popup logic

const $ = (sel) => document.querySelector(sel);

// Surface any uncaught error / rejection in the popup itself so we don't have
// to ask the user to open DevTools to debug a silently-broken init.
function showPopupErr(text) {
  try {
    const el = document.getElementById('errBanner');
    if (!el) return;
    el.style.display = 'block';
    el.textContent = (el.textContent ? el.textContent + '\n' : '') + text;
  } catch {}
}
window.addEventListener('error', e =>
  showPopupErr('JS error: ' + e.message + ' (' + (e.filename || '?') + ':' + (e.lineno || '?') + ')'));
window.addEventListener('unhandledrejection', e =>
  showPopupErr('Unhandled rejection: ' + (e.reason && (e.reason.stack || e.reason.message || e.reason) || e.reason)));

let pacsTabId = null;
let isPreloading = false;
let ocrDropActive = false;

let ocrParsedPatients = [];
let ocrProviders = [];
const ocrSelectedProviders = new Set();

// Which import tab is active — drives where Ctrl+V dispatches the pasted image.
let activeImportTab = 'ocr';   // 'ocr' | 'pendingEpic' | 'pendingEmail'

// Last parsed rows per pending tab — captured by the render fn so the Load button can post them.
let pendingEpicRows = [];
let pendingEmailRows = [];

const FILTER_KEYS = SUBSPECIALTY.regionCheckboxes.map(cb => cb.id);
const STORAGE_KEYS = ['schedule', 'serverUrl', 'clinicDate', ...FILTER_KEYS];

// ── Init ──
document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && tab.url.includes('pacs.renoortho.com')) {
    pacsTabId = tab.id;
    $('#pacsStatus').className = 'status-bar connected';
    $('#pacsStatusText').textContent = 'Connected to InteleBrowser';
    $('#preloadBtn').disabled = false;

    // Timeout the ping. If the content script is wedged or hasn't loaded yet,
    // chrome.tabs.sendMessage's callback may never fire — and a bare await
    // would hang the rest of init, leaving every button below unresponsive.
    try {
      const ping = await Promise.race([
        sendToTab(pacsTabId, 'ping', {}),
        new Promise((_, reject) => setTimeout(() => reject(new Error('ping timeout')), 1500)),
      ]);
      if (ping.hasSession) {
        $('#pacsStatusText').textContent = `Connected — session active (${ping.session.UserName || 'unknown user'})`;
      } else {
        $('#pacsStatusText').textContent = 'Connected — session params not found (search may still work)';
      }
    } catch (e) {
      $('#pacsStatusText').textContent = 'Connected — content script not responding (reload PACS page)';
    }
  }

  // Set title and build filter UI from config
  document.getElementById('appTitle').textContent = SUBSPECIALTY.name !== 'Spine'
    ? `PACS Preloader — ${SUBSPECIALTY.name}`
    : 'PACS Clinic Preloader';
  buildFilterUI();

  // Load saved settings
  const saved = await chrome.storage.local.get(STORAGE_KEYS);
  if (saved.schedule)   $('#schedule').value = saved.schedule;
  if (saved.serverUrl)  $('#serverUrl').value = saved.serverUrl;
  else                  $('#serverUrl').value = SUBSPECIALTY.defaultServerUrl;
  if (saved.clinicDate) $('#clinicDate').value = saved.clinicDate;
  if (!saved.serverUrl) chrome.storage.local.set({ serverUrl: $('#serverUrl').value });
  for (const id of FILTER_KEYS) {
    if (saved[id] != null) $(`#${id}`).checked = saved[id];
  }

  // Persist settings on change
  $('#schedule').addEventListener('input',  () => chrome.storage.local.set({ schedule: $('#schedule').value }));
  $('#serverUrl').addEventListener('change', () => chrome.storage.local.set({ serverUrl: $('#serverUrl').value }));
  $('#clinicDate').addEventListener('change', () => chrome.storage.local.set({ clinicDate: $('#clinicDate').value }));
  for (const id of FILTER_KEYS) {
    $(`#${id}`).addEventListener('change', () => {
      chrome.storage.local.set({ [id]: $(`#${id}`).checked });
      chrome.storage.local.set({ lastFilters: getFilterOptions() });
    });
  }

  $('#preloadBtn').addEventListener('click', startPreload);
  $('#clearBtn').addEventListener('click', clearCache);
  $('#viewerBtn').addEventListener('click', openViewer);

  // Check if background is already preloading (popup may have been reopened mid-run).
  // Timeout-guarded — the background service worker can be sleeping and the
  // sendMessage Promise sometimes never resolves, which would hang the rest of init.
  try {
    const status = await Promise.race([
      chrome.runtime.sendMessage({ action: 'getStatus' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('getStatus timeout')), 1500)),
    ]);
    if (status?.isPreloading) {
      isPreloading = true;
      $('#preloadBtn').disabled = true;
      $('#preloadBtn').textContent = 'Preloading...';
      $('#progress').style.display = 'block';
      $('#log').style.display = 'block';
      log('Preload running in background — open viewer anytime', 'info');
    }
  } catch (e) { /* background not ready yet / timed out — non-fatal */ }

  // Listen for progress updates from background
  chrome.runtime.onMessage.addListener(handleBackgroundMessage);

  // Each init in its own try so one broken init doesn't cascade and disable
  // the others' click handlers. Show any failure in the on-screen err banner.
  try { initOcr(); }          catch (e) { showPopupErr('initOcr failed: ' + e.message); }
  try { initPendingEpic(); }  catch (e) { showPopupErr('initPendingEpic failed: ' + e.message); }
  try { initPendingEmail(); } catch (e) { showPopupErr('initPendingEmail failed: ' + e.message); }
});

function handleBackgroundMessage(msg) {
  if (msg.action === 'preloadLog')      { log(msg.text, msg.cls); }
  if (msg.action === 'preloadProgress') { updateProgress(msg.current, msg.total, msg.label); }
  if (msg.action === 'preloadDone') {
    isPreloading = false;
    $('#preloadBtn').textContent = 'Preload Images';
    $('#preloadBtn').disabled = !pacsTabId;
  }
}


// ── Schedule Parsing ──
function parseSchedule(text) {
  const patients = [];
  const lines = text.trim().split('\n').filter(l => l.trim());

  for (const line of lines) {
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;

    // Extract provider annotation: "Name  DOB  # Provider Name"
    let provider = '';
    const provMatch = trimmed.match(/\s{2,}#\s+(.+)$/);
    if (provMatch) {
      provider = provMatch[1].trim();
      trimmed = trimmed.slice(0, provMatch.index).trim();
    }

    // Extract visit time if present (H:MM AM/PM at start of line)
    let visitTime = '';
    const timeMatch = trimmed.match(/^(\d{1,2}:\d{2}\s*[AP]M)\s+/i);
    if (timeMatch) {
      visitTime = timeMatch[1].replace(/(\d{1,2})(\d{2})([AP]M)/i, '$1:$2 $3').trim();
      trimmed = trimmed.slice(timeMatch[0].length);
    }

    const dobMatch = trimmed.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s*$/);
    if (!dobMatch) {
      log(`⚠ Skipping (no DOB): ${trimmed}`, 'error');
      continue;
    }

    const dob = dobMatch[1];
    const name = trimmed.slice(0, dobMatch.index).trim().replace(/[,\t]+$/, '').trim();
    if (!name) { log(`⚠ Skipping (no name): ${trimmed}`, 'error'); continue; }

    patients.push({ name, dob, provider, visitTime });
  }

  return patients;
}


// ── Preload — delegates to background service worker ──
async function startPreload() {
  if (isPreloading || !pacsTabId) return;

  const patients = parseSchedule($('#schedule').value);
  if (patients.length === 0) {
    log('No valid patients in schedule', 'error');
    return;
  }

  const serverUrl  = $('#serverUrl').value.replace(/\/$/, '');
  const clinicDate = $('#clinicDate').value;

  try {
    const resp = await fetch(`${serverUrl}/api/health`);
    if (!resp.ok) throw new Error();
    log('✓ Local server running', 'success');
  } catch (e) {
    log('✗ Local server not running! Start: python server.py', 'error');
    return;
  }

  isPreloading = true;
  $('#preloadBtn').disabled = true;
  $('#preloadBtn').textContent = 'Preloading...';
  $('#progress').style.display = 'block';
  $('#log').style.display = 'block';

  // Hand off to background — preload continues even if popup is closed
  chrome.runtime.sendMessage({
    action:          'startPreload',
    patients,
    serverUrl,
    clinicDate,
    filters:         getFilterOptions(),
    tabId:           pacsTabId,
    tabConcurrency:  3,
  });
}


// ── Clear Cache ──
async function clearCache() {
  const serverUrl = $('#serverUrl').value.replace(/\/$/, '');
  $('#log').style.display = 'block';
  try {
    const resp = await fetch(`${serverUrl}/api/clear`, { method: 'DELETE' });
    if (resp.ok) {
      log('✓ Cached data cleared', 'success');
    } else {
      log(`✗ Clear failed (${resp.status})`, 'error');
    }
  } catch (e) {
    log('✗ Server not running', 'error');
  }
}


// ── Helpers ──
function buildFilterUI() {
  const section = document.getElementById('filterSection');
  let html = SUBSPECIALTY.regionCheckboxes.map(cb =>
    `<label class="checkbox-label"><input type="checkbox" id="${cb.id}" checked> ${escHtml(cb.label)}</label>`
  ).join('');
  if (!SUBSPECIALTY.hideModalityFilters) {
    html += `<div class="filter-divider"></div>
      <label class="checkbox-label"><input type="checkbox" id="filterXR" checked> XR</label>
      <label class="checkbox-label"><input type="checkbox" id="filterCT" checked> CT</label>
      <label class="checkbox-label"><input type="checkbox" id="filterMR" checked> MRI</label>`;
  }
  section.innerHTML = html;
}

function getFilterOptions() {
  const regions = SUBSPECIALTY.regionCheckboxes
    .filter(cb => document.getElementById(cb.id)?.checked)
    .flatMap(cb => cb.regions);

  const modalities = SUBSPECIALTY.hideModalityFilters
    ? Object.keys(SUBSPECIALTY.modalityCodes)
    : ['xr', 'ct', 'mr'].filter(m => {
        if (m === 'xr') return $('#filterXR')?.checked;
        if (m === 'ct') return $('#filterCT')?.checked;
        if (m === 'mr') return $('#filterMR')?.checked;
      });

  return { regions: regions.length > 0 ? regions : null, modalities: modalities.length > 0 ? modalities : null };
}

function sendToTab(tabId, action, data) {
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

function updateProgress(current, total, label) {
  $('#progressLabel').textContent = label;
  $('#progressCount').textContent = `${current} / ${total}`;
  $('#progressFill').style.width = `${(current / total) * 100}%`;
}

function log(msg, cls = 'info') {
  const el = $('#log');
  el.innerHTML += `<div class="${cls}">${msg}</div>`;
  el.scrollTop = el.scrollHeight;
}

function openViewer() {
  const params = (typeof SUBSPECIALTY !== 'undefined' && SUBSPECIALTY.viewerParams) ? SUBSPECIALTY.viewerParams : '';
  chrome.tabs.create({ url: `${$('#serverUrl').value.replace(/\/$/, '')}/viewer${params}` });
}


// ── Schedule OCR ──
function initOcr() {
  const drop = document.getElementById('ocrDrop');

  drop.addEventListener('click', () => { drop.focus(); drop.classList.add('active'); });
  drop.addEventListener('blur',  () => drop.classList.remove('active'));

  document.getElementById('ocrApplyBtn').addEventListener('click', applyOcrResult);
  document.getElementById('ocrClearBtn').addEventListener('click', clearOcr);
  document.getElementById('ocrProviderDropdownBtn').addEventListener('click', toggleOcrProviderDropdown);

  // Event delegation for OCR provider dropdown (CSP-safe)
  const dd = document.getElementById('ocrProviderDropdown');
  dd.addEventListener('click', e => {
    const a = e.target.closest('[data-ocr-select-all]');
    if (a) setAllOcrProviders(a.dataset.ocrSelectAll === 'true');
  });
  dd.addEventListener('change', e => {
    const cb = e.target.closest('input[type=checkbox]');
    if (cb) toggleOcrProvider(cb.value, cb.checked);
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#ocrProviderFilterRow'))
      document.getElementById('ocrProviderDropdown').style.display = 'none';
  });

  document.addEventListener('paste', handleImagePaste);
}

// Single paste handler for all three import tabs — dispatches by activeImportTab.
function handleImagePaste(e) {
  const items = [...(e.clipboardData?.items || [])];
  const imageItem = items.find(item => item.type.startsWith('image/'));
  if (!imageItem) return;
  if (document.activeElement?.id === 'schedule') return;

  e.preventDefault();
  const blob = imageItem.getAsFile();

  if (activeImportTab === 'ocr')          handleClinicOcrPaste(blob);
  else if (activeImportTab === 'pendingEpic')  handlePendingEpicPaste(blob);
  else if (activeImportTab === 'pendingEmail') handlePendingEmailPaste(blob);
}

function handleClinicOcrPaste(blob) {
  const url = URL.createObjectURL(blob);
  document.getElementById('ocrImg').src = url;
  document.getElementById('ocrPreview').style.display = 'flex';
  document.getElementById('ocrDrop').style.display = 'none';
  document.getElementById('ocrStatus').textContent = 'Running OCR…';
  document.getElementById('ocrResult').value = '';
  runOcr(blob);
}

async function runOcr(blob) {
  const serverUrl = $('#serverUrl').value.replace(/\/$/, '');
  const statusEl = document.getElementById('ocrStatus');
  try {
    const form = new FormData();
    form.append('image', blob, 'schedule.png');
    const resp = await fetch(`${serverUrl}/api/ocr`, { method: 'POST', body: form });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: resp.statusText }));
      statusEl.textContent = `OCR error: ${err.detail}`;
      return;
    }
    const data = await resp.json();
    document.getElementById('ocrRaw').value = data.text || '';

    if (data.patients && data.patients.length > 0) {
      ocrParsedPatients = data.patients;
      ocrProviders = data.providers || [];
      ocrSelectedProviders.clear();
      ocrProviders.forEach(p => ocrSelectedProviders.add(p));

      if (ocrProviders.length > 1) {
        buildOcrProviderDropdown();
        document.getElementById('ocrProviderFilterRow').style.display = '';
      } else {
        document.getElementById('ocrProviderFilterRow').style.display = 'none';
      }

      updateOcrTextarea();
      const found = ocrParsedPatients.length;
      const provStr = ocrProviders.length > 1 ? ` · ${ocrProviders.length} providers` : '';
      statusEl.textContent = `Found ${found} patient(s)${provStr} — edit if needed, then Apply`;
    } else {
      // Fallback: client-side parse (no structured patients from server)
      ocrParsedPatients = []; ocrProviders = []; ocrSelectedProviders.clear();
      document.getElementById('ocrProviderFilterRow').style.display = 'none';
      const parsed = parseOcrToSchedule(data.text || '');
      document.getElementById('ocrResult').value = parsed;
      const found = parsed.split('\n').filter(Boolean).length;
      statusEl.textContent = parsed
        ? `Found ${found} patient(s) (${data.dates_found ?? '?'} dates detected) — edit if needed, then Apply`
        : 'No patients detected — expand "Raw OCR text" below to diagnose';
    }
  } catch (e) {
    statusEl.textContent = `Server error: ${e.message}`;
  }
}

function parseOcrToSchedule(text) {
  const results = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    const dateMatch = line.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2}|\d{4})\b/);
    if (!dateMatch) continue;

    let [, m, d, y] = dateMatch;
    if (y.length === 2) y = parseInt(y) > 30 ? `19${y}` : `20${y}`;
    const dob = `${m}/${d}/${y}`;

    const beforeDate = line.slice(0, dateMatch.index);
    const name = beforeDate
      .replace(/^\d+:\d+\s*(AM|PM)?\s*/i, '')
      .replace(/\b\d{5,}\b/g, '')
      .replace(/[\t|]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (name.length > 2) results.push(`${name}  ${dob}`);
  }
  return results.join('\n');
}

function applyOcrResult() {
  const text = document.getElementById('ocrResult').value.trim();
  if (!text) return;
  const current = $('#schedule').value.trim();
  $('#schedule').value = current ? `${current}\n${text}` : text;
  chrome.storage.local.set({ schedule: $('#schedule').value });
  clearOcr();
  $('#schedule').focus();
}

function clearOcr() {
  ocrParsedPatients = []; ocrProviders = []; ocrSelectedProviders.clear();
  document.getElementById('ocrPreview').style.display = 'none';
  document.getElementById('ocrDrop').style.display = 'block';
  document.getElementById('ocrResult').value = '';
  document.getElementById('ocrRaw').value = '';
  document.getElementById('ocrStatus').textContent = '';
  document.getElementById('ocrImg').src = '';
  document.getElementById('ocrProviderFilterRow').style.display = 'none';
}


function buildOcrProviderDropdown() {
  const dd = document.getElementById('ocrProviderDropdown');
  dd.innerHTML = `<div class="provider-select-all">
    <a data-ocr-select-all="true">All</a> · <a data-ocr-select-all="false">None</a>
  </div>` + ocrProviders.map(p =>
    `<label class="provider-option">
      <input type="checkbox" value="${escHtml(p)}" ${ocrSelectedProviders.has(p) ? 'checked' : ''}>
      ${escHtml(p)}
    </label>`
  ).join('');
  updateOcrProviderBtn();
}

function toggleOcrProviderDropdown() {
  const dd = document.getElementById('ocrProviderDropdown');
  dd.style.display = dd.style.display === 'none' ? '' : 'none';
}

function toggleOcrProvider(name, checked) {
  if (checked) ocrSelectedProviders.add(name); else ocrSelectedProviders.delete(name);
  updateOcrProviderBtn();
  updateOcrTextarea();
}

function setAllOcrProviders(checked) {
  ocrProviders.forEach(p => checked ? ocrSelectedProviders.add(p) : ocrSelectedProviders.delete(p));
  document.querySelectorAll('#ocrProviderDropdown input[type=checkbox]')
    .forEach(cb => { cb.checked = checked; });
  updateOcrProviderBtn();
  updateOcrTextarea();
}

function updateOcrProviderBtn() {
  const n = ocrSelectedProviders.size, total = ocrProviders.length;
  document.getElementById('ocrProviderDropdownBtn').textContent =
    n === total ? `All providers (${total}) ▾` :
    n === 0    ? 'No providers selected ▾' :
                 `${n} of ${total} providers ▾`;
}

function updateOcrTextarea() {
  const filtered = ocrParsedPatients
    .filter(p => !p.provider || ocrSelectedProviders.has(p.provider))
    .map(p => {
      let line = '';
      if (p.time) line += `${p.time}  `;
      line += `${p.name}  ${p.dob}`;
      if (p.provider) line += `  # ${p.provider}`;
      return line;
    });
  document.getElementById('ocrResult').value = filtered.join('\n');
}


// ── Import tab switching ──

function switchImportTab(tab) {
  activeImportTab = tab;
  document.getElementById('ocrPanel').style.display          = tab === 'ocr'          ? '' : 'none';
  document.getElementById('pendingEpicPanel').style.display  = tab === 'pendingEpic'  ? '' : 'none';
  document.getElementById('pendingEmailPanel').style.display = tab === 'pendingEmail' ? '' : 'none';
  document.getElementById('tabOcr').classList.toggle('active',          tab === 'ocr');
  document.getElementById('tabPendingEpic').classList.toggle('active',  tab === 'pendingEpic');
  document.getElementById('tabPendingEmail').classList.toggle('active', tab === 'pendingEmail');
}


// ── Pending Reads: Epic screenshot (preview only) ──

function initPendingEpic() {
  document.getElementById('tabOcr').addEventListener('click',          () => switchImportTab('ocr'));
  document.getElementById('tabPendingEpic').addEventListener('click',  () => switchImportTab('pendingEpic'));
  document.getElementById('tabPendingEmail').addEventListener('click', () => switchImportTab('pendingEmail'));

  const drop = document.getElementById('pendingEpicDrop');
  drop.addEventListener('click', () => { drop.focus(); drop.classList.add('active'); });
  drop.addEventListener('blur',  () => drop.classList.remove('active'));
  document.getElementById('pendingEpicClearBtn').addEventListener('click', clearPendingEpic);
  document.getElementById('pendingEpicLoadBtn').addEventListener('click',
    () => loadPendingToViewer(pendingEpicRows, 'epic', 'pendingEpic'));
}

function handlePendingEpicPaste(blob) {
  const url = URL.createObjectURL(blob);
  document.getElementById('pendingEpicImg').src = url;
  document.getElementById('pendingEpicPreview').style.display = 'flex';
  document.getElementById('pendingEpicDrop').style.display = 'none';
  document.getElementById('pendingEpicStatus').textContent = 'Running OCR…';
  document.getElementById('pendingEpicRows').innerHTML = '';
  runPendingOcr(blob, '/api/ocr/pending-reads', 'pendingEpic', renderPendingEpicRows);
}

function renderPendingEpicRows(rows) {
  pendingEpicRows = rows;
  const container = document.getElementById('pendingEpicRows');
  if (!rows.length) {
    container.innerHTML =
      '<div class="ocr-status">No rows parsed — expand server response in DevTools to diagnose.</div>';
    return;
  }
  // Editable cells use contenteditable + data-row/data-field; a delegated
  // blur handler writes the new text back to pendingEpicRows[row][field]
  // so the next "Load to Pending Viewer" picks up the user's corrections.
  const ed = (i, field, value) =>
    `<td contenteditable="true" data-row="${i}" data-field="${field}">${escHtml(value)}</td>`;
  const html = `<div class="ocr-status" style="font-size:10px;color:#475569;margin:2px 0">click any cell to edit</div>
    <table class="pending-table"><thead><tr>
      <th>#</th><th>Name</th><th>DOB</th><th>Study</th><th>Date</th><th>Time</th><th>Flags</th>
    </tr></thead><tbody>` + rows.map((r, i) => `
      <tr class="${(r.flags || []).length ? 'flagged' : ''}">
        <td>${i + 1}</td>
        ${ed(i, 'name', r.name || '')}
        ${ed(i, 'dob', r.dob || '')}
        ${ed(i, 'study_description', r.study_description || '')}
        ${ed(i, 'study_date', r.study_date || '')}
        ${ed(i, 'study_time', r.study_time || '')}
        <td>${(r.flags || []).map(f => `<span class="pending-flag">${escHtml(f)}</span>`).join('')}</td>
      </tr>`).join('') + `</tbody></table>`;
  container.innerHTML = html;
  wirePendingEdits(container, pendingEpicRows);
}

function clearPendingEpic() {
  pendingEpicRows = [];
  document.getElementById('pendingEpicPreview').style.display = 'none';
  document.getElementById('pendingEpicDrop').style.display = 'block';
  document.getElementById('pendingEpicRows').innerHTML = '';
  document.getElementById('pendingEpicStatus').textContent = '';
  document.getElementById('pendingEpicImg').src = '';
}


// ── Pending Reads: Email reminder (preview only) ──

function initPendingEmail() {
  const drop = document.getElementById('pendingEmailDrop');
  drop.addEventListener('click', () => { drop.focus(); drop.classList.add('active'); });
  drop.addEventListener('blur',  () => drop.classList.remove('active'));
  document.getElementById('pendingEmailClearBtn').addEventListener('click', clearPendingEmail);
  document.getElementById('pendingEmailLoadBtn').addEventListener('click',
    () => loadPendingToViewer(pendingEmailRows, 'email', 'pendingEmail'));
}

function handlePendingEmailPaste(blob) {
  const url = URL.createObjectURL(blob);
  document.getElementById('pendingEmailImg').src = url;
  document.getElementById('pendingEmailPreview').style.display = 'flex';
  document.getElementById('pendingEmailDrop').style.display = 'none';
  document.getElementById('pendingEmailStatus').textContent = 'Running OCR…';
  document.getElementById('pendingEmailRows').innerHTML = '';
  runPendingOcr(blob, '/api/ocr/pending-reads-email', 'pendingEmail', renderPendingEmailRows);
}

function renderPendingEmailRows(rows) {
  pendingEmailRows = rows;
  const container = document.getElementById('pendingEmailRows');
  if (!rows.length) {
    container.innerHTML =
      '<div class="ocr-status">No rows parsed — expand server response in DevTools to diagnose.</div>';
    return;
  }
  const ed = (i, field, value) =>
    `<td contenteditable="true" data-row="${i}" data-field="${field}">${escHtml(value)}</td>`;
  const html = `<div class="ocr-status" style="font-size:10px;color:#475569;margin:2px 0">click any cell to edit</div>
    <table class="pending-table"><thead><tr>
      <th>#</th><th>Name</th><th>MRN</th><th>Appt date</th><th>Time</th><th>Procedure</th><th>Flags</th>
    </tr></thead><tbody>` + rows.map((r, i) => `
      <tr class="${(r.flags || []).length ? 'flagged' : ''}">
        <td>${i + 1}</td>
        ${ed(i, 'name', r.name || '')}
        ${ed(i, 'mrn', r.mrn || '')}
        ${ed(i, 'appt_date', r.appt_date || '')}
        ${ed(i, 'appt_time', r.appt_time || '')}
        ${ed(i, 'procedure', r.procedure || '')}
        <td>${(r.flags || []).map(f => `<span class="pending-flag">${escHtml(f)}</span>`).join('')}</td>
      </tr>`).join('') + `</tbody></table>`;
  container.innerHTML = html;
  wirePendingEdits(container, pendingEmailRows);
}


// Delegated edit binding for pending preview tables. Writes blur-time text back
// to the underlying row array so the popup-resident state stays in sync with
// what the user sees.
function wirePendingEdits(container, rows) {
  container.addEventListener('blur', e => {
    const td = e.target.closest('td[contenteditable]');
    if (!td) return;
    const i = parseInt(td.dataset.row, 10);
    const field = td.dataset.field;
    if (isNaN(i) || !field || !rows[i]) return;
    rows[i][field] = td.textContent.trim();
  }, true);  // capture phase — blur doesn't bubble
  // Enter commits the edit (don't insert a newline in the cell)
  container.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.matches('td[contenteditable]')) {
      e.preventDefault();
      e.target.blur();
    }
  });
}

function clearPendingEmail() {
  pendingEmailRows = [];
  document.getElementById('pendingEmailPreview').style.display = 'none';
  document.getElementById('pendingEmailDrop').style.display = 'block';
  document.getElementById('pendingEmailRows').innerHTML = '';
  document.getElementById('pendingEmailStatus').textContent = '';
  document.getElementById('pendingEmailImg').src = '';
}


// Kick off real PACS search + preload for the parsed pending rows, then open
// the existing viewer in pending mode so the user can swipe through images
// as they arrive.
async function loadPendingToViewer(rows, sourceLabel, panelId) {
  const serverUrl = $('#serverUrl').value.replace(/\/$/, '');
  const statusEl = document.getElementById(panelId + 'Status');
  if (!rows || !rows.length) {
    statusEl.textContent = 'Nothing to load — paste a screenshot first.';
    return;
  }
  // Re-verify the cached pacsTabId is still alive (user may have closed PACS
  // since opening the popup). Fall back to any open pacs.renoortho.com tab.
  let livePacsTabId = null;
  if (pacsTabId) {
    try {
      const t = await chrome.tabs.get(pacsTabId);
      if (t && t.url && t.url.includes('pacs.renoortho.com')) livePacsTabId = pacsTabId;
    } catch (e) { /* tab gone */ }
  }
  if (!livePacsTabId) {
    const tabs = await chrome.tabs.query({ url: 'https://pacs.renoortho.com/*' });
    if (tabs && tabs.length) livePacsTabId = tabs[0].id;
  }
  if (!livePacsTabId) {
    statusEl.textContent = '✗ No PACS tab open — open InteleBrowser in another tab first.';
    return;
  }

  // Health-check the server up front so the user gets a useful error if it's not running.
  try {
    const resp = await fetch(`${serverUrl}/api/health`);
    if (!resp.ok) throw new Error();
  } catch (e) {
    statusEl.textContent = '✗ Local server not running — start: python backend/server.py';
    return;
  }

  const source = `pending_${sourceLabel}`;   // 'pending_epic' | 'pending_email'
  statusEl.textContent = `Queued ${rows.length} row(s) — preload running. Opening viewer (status shows there)…`;

  chrome.runtime.sendMessage({
    action:   'startPendingPreload',
    rows,
    source,
    serverUrl,
    tabId:    livePacsTabId,
  });
  chrome.tabs.create({ url: `${serverUrl}/viewer?mode=pending` });
}


// Shared OCR caller for both pending-reads endpoints.
async function runPendingOcr(blob, endpoint, panelId, renderRows) {
  const serverUrl = $('#serverUrl').value.replace(/\/$/, '');
  const statusEl = document.getElementById(panelId + 'Status');
  try {
    const form = new FormData();
    form.append('image', blob, 'pending.png');
    const resp = await fetch(`${serverUrl}${endpoint}`, { method: 'POST', body: form });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: resp.statusText }));
      statusEl.textContent = `OCR error: ${err.detail}`;
      return;
    }
    const data = await resp.json();
    const n = data.count || 0;
    const flagged = (data.rows || []).filter(r => (r.flags || []).length).length;
    statusEl.textContent = `Found ${n} row${n !== 1 ? 's' : ''}` +
      (flagged ? ` · ${flagged} flagged for review` : '') +
      (data.debug?.skipped ? ` · ${data.debug.skipped} skipped` : '');
    renderRows(data.rows || []);
  } catch (e) {
    statusEl.textContent = `Server error: ${e.message}`;
  }
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
