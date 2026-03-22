// popup.js — PACS Clinic Preloader extension popup logic

const $ = (sel) => document.querySelector(sel);

let pacsTabId = null;
let isPreloading = false;
let ocrDropActive = false;

let parsedPdfPatients = [];
let pdfProviders = [];
const selectedProviders = new Set();

let ocrParsedPatients = [];
let ocrProviders = [];
const ocrSelectedProviders = new Set();

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

    try {
      const ping = await sendToTab(pacsTabId, 'ping', {});
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

  // Check if background is already preloading (popup may have been reopened mid-run)
  try {
    const status = await chrome.runtime.sendMessage({ action: 'getStatus' });
    if (status?.isPreloading) {
      isPreloading = true;
      $('#preloadBtn').disabled = true;
      $('#preloadBtn').textContent = 'Preloading...';
      $('#progress').style.display = 'block';
      $('#log').style.display = 'block';
      log('Preload running in background — open viewer anytime', 'info');
    }
  } catch (e) { /* background not ready yet */ }

  // Listen for progress updates from background
  chrome.runtime.onMessage.addListener(handleBackgroundMessage);

  initOcr();
  initPdf();
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

  document.addEventListener('paste', handleOcrPaste);
}

function handleOcrPaste(e) {
  const items = [...(e.clipboardData?.items || [])];
  const imageItem = items.find(item => item.type.startsWith('image/'));
  if (!imageItem) return;
  if (document.activeElement?.id === 'schedule') return;

  e.preventDefault();
  const blob = imageItem.getAsFile();
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


// ── PDF Schedule Upload ──

function switchImportTab(tab) {
  document.getElementById('pdfPanel').style.display = tab === 'pdf' ? '' : 'none';
  document.getElementById('ocrPanel').style.display = tab === 'ocr' ? '' : 'none';
  document.getElementById('tabPdf').classList.toggle('active', tab === 'pdf');
  document.getElementById('tabOcr').classList.toggle('active', tab === 'ocr');
}

function initPdf() {
  document.getElementById('pdfFile').addEventListener('change', handlePdfUpload);
  document.getElementById('pdfApplyBtn').addEventListener('click', applyPdfResult);
  document.getElementById('pdfClearBtn').addEventListener('click', clearPdf);
  document.getElementById('tabPdf').addEventListener('click', () => switchImportTab('pdf'));
  document.getElementById('tabOcr').addEventListener('click', () => switchImportTab('ocr'));
  document.getElementById('providerDropdownBtn').addEventListener('click', toggleProviderDropdown);

  // Event delegation for provider dropdown (avoids inline handlers blocked by CSP)
  const dd = document.getElementById('providerDropdown');
  dd.addEventListener('click', e => {
    const a = e.target.closest('[data-select-all]');
    if (a) setAllProviders(a.dataset.selectAll === 'true');
  });
  dd.addEventListener('change', e => {
    const cb = e.target.closest('input[type=checkbox]');
    if (cb) toggleProvider(cb.value, cb.checked);
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#providerFilterRow'))
      document.getElementById('providerDropdown').style.display = 'none';
  });
}

async function handlePdfUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  const serverUrl = $('#serverUrl').value.replace(/\/$/, '');
  const statusEl = document.getElementById('pdfStatus');
  statusEl.textContent = 'Parsing PDF…';
  document.getElementById('pdfBtns').style.display = 'none';
  document.getElementById('providerFilterRow').style.display = 'none';

  const form = new FormData();
  form.append('file', file);
  try {
    const resp = await fetch(`${serverUrl}/api/parse-pdf`, { method: 'POST', body: form });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: resp.statusText }));
      statusEl.textContent = `Error: ${err.detail}`;
      return;
    }
    const data = await resp.json();
    parsedPdfPatients = data.patients;
    pdfProviders = data.providers;
    selectedProviders.clear();
    pdfProviders.forEach(p => selectedProviders.add(p));

    const n = data.count;
    statusEl.textContent = `Found ${n} patient${n !== 1 ? 's' : ''} · ${pdfProviders.length} provider${pdfProviders.length !== 1 ? 's' : ''}`;
    if (pdfProviders.length > 1) {
      buildProviderDropdown();
      document.getElementById('providerFilterRow').style.display = '';
    }
    document.getElementById('pdfBtns').style.display = 'flex';
  } catch (err) {
    statusEl.textContent = `Server error: ${err.message}`;
  }
}

function buildProviderDropdown() {
  const dd = document.getElementById('providerDropdown');
  dd.innerHTML = `<div class="provider-select-all">
    <a data-select-all="true">All</a> · <a data-select-all="false">None</a>
  </div>` + pdfProviders.map(p =>
    `<label class="provider-option">
      <input type="checkbox" value="${escHtml(p)}" ${selectedProviders.has(p) ? 'checked' : ''}>
      ${escHtml(p)}
    </label>`
  ).join('');
  updateProviderBtn();
}

function toggleProviderDropdown() {
  const dd = document.getElementById('providerDropdown');
  dd.style.display = dd.style.display === 'none' ? '' : 'none';
}

function toggleProvider(name, checked) {
  if (checked) selectedProviders.add(name); else selectedProviders.delete(name);
  updateProviderBtn();
}

function setAllProviders(checked) {
  pdfProviders.forEach(p => checked ? selectedProviders.add(p) : selectedProviders.delete(p));
  document.querySelectorAll('#providerDropdown input[type=checkbox]')
    .forEach(cb => { cb.checked = checked; });
  updateProviderBtn();
}

function updateProviderBtn() {
  const n = selectedProviders.size, total = pdfProviders.length;
  document.getElementById('providerDropdownBtn').textContent =
    n === total ? `All providers (${total}) ▾` :
    n === 0    ? 'No providers selected ▾' :
                 `${n} of ${total} providers ▾`;
}

function applyPdfResult() {
  const filtered = parsedPdfPatients
    .filter(p => !p.provider || selectedProviders.has(p.provider))
    .map(p => {
      let line = '';
      if (p.time) line += `${p.time}  `;
      line += `${p.name}  ${p.dob}`;
      if (p.provider) line += `  # ${p.provider}`;
      return line;
    });
  if (!filtered.length) return;
  const current = $('#schedule').value.trim();
  $('#schedule').value = current ? `${current}\n${filtered.join('\n')}` : filtered.join('\n');
  chrome.storage.local.set({ schedule: $('#schedule').value });
  // Auto-fill clinic date if all patients share one date
  const dates = [...new Set(parsedPdfPatients.map(p => p.clinic_date).filter(Boolean))];
  if (dates.length === 1 && !$('#clinicDate').value) {
    const iso = toInputDate(dates[0]);
    if (iso) { $('#clinicDate').value = iso; chrome.storage.local.set({ clinicDate: iso }); }
  }
  document.getElementById('providerDropdown').style.display = 'none';
}

function clearPdf() {
  parsedPdfPatients = []; pdfProviders = []; selectedProviders.clear();
  document.getElementById('pdfStatus').textContent = '';
  document.getElementById('pdfBtns').style.display = 'none';
  document.getElementById('providerFilterRow').style.display = 'none';
  document.getElementById('pdfFile').value = '';
}

function toInputDate(str) {
  const m = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : '';
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
