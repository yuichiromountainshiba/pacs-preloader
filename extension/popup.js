// popup.js — PACS Clinic Preloader extension popup logic

const $ = (sel) => document.querySelector(sel);

let pacsTabId = null;
let isPreloading = false;
let ocrDropActive = false;

const FILTER_KEYS = ['filterSpine', 'filterXR', 'filterCT', 'filterMR'];
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

  // Load saved settings
  const saved = await chrome.storage.local.get(STORAGE_KEYS);
  if (saved.schedule)   $('#schedule').value = saved.schedule;
  if (saved.serverUrl)  $('#serverUrl').value = saved.serverUrl;
  if (saved.clinicDate) $('#clinicDate').value = saved.clinicDate;
  for (const id of FILTER_KEYS) {
    if (saved[id] != null) $(`#${id}`).checked = saved[id];
  }

  // Persist settings on change
  $('#schedule').addEventListener('input',  () => chrome.storage.local.set({ schedule: $('#schedule').value }));
  $('#serverUrl').addEventListener('change', () => chrome.storage.local.set({ serverUrl: $('#serverUrl').value }));
  $('#clinicDate').addEventListener('change', () => chrome.storage.local.set({ clinicDate: $('#clinicDate').value }));
  for (const id of FILTER_KEYS) {
    $(`#${id}`).addEventListener('change', () => chrome.storage.local.set({ [id]: $(`#${id}`).checked }));
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
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;

    const dobMatch = trimmed.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s*$/);
    if (!dobMatch) {
      log(`⚠ Skipping (no DOB): ${trimmed}`, 'error');
      continue;
    }

    const dob = dobMatch[1];
    const name = trimmed.slice(0, dobMatch.index).trim().replace(/[,\t]+$/, '').trim();
    if (!name) { log(`⚠ Skipping (no name): ${trimmed}`, 'error'); continue; }

    patients.push({ name, dob });
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
    action:     'startPreload',
    patients,
    serverUrl,
    clinicDate,
    filters:    getFilterOptions(),
    tabId:      pacsTabId,
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
function getFilterOptions() {
  const spineRegions = $('#filterSpine')?.checked
    ? ['lumbar', 'cervical', 'thoracic']
    : null;

  const modalities = [];
  if ($('#filterXR')?.checked) modalities.push('xr');
  if ($('#filterCT')?.checked) modalities.push('ct');
  if ($('#filterMR')?.checked) modalities.push('mr');

  return { spineRegions, modalities: modalities.length > 0 ? modalities : null };
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
  chrome.tabs.create({ url: `${$('#serverUrl').value.replace(/\/$/, '')}/viewer` });
}


// ── Schedule OCR ──
function initOcr() {
  const drop = document.getElementById('ocrDrop');

  drop.addEventListener('click', () => { drop.focus(); drop.classList.add('active'); });
  drop.addEventListener('blur',  () => drop.classList.remove('active'));

  document.getElementById('ocrApplyBtn').addEventListener('click', applyOcrResult);
  document.getElementById('ocrClearBtn').addEventListener('click', clearOcr);

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
    const parsed = parseOcrToSchedule(data.text || '');
    document.getElementById('ocrResult').value = parsed;
    document.getElementById('ocrRaw').value = data.text || '';
    const found = parsed.split('\n').filter(Boolean).length;
    statusEl.textContent = parsed
      ? `Found ${found} patient(s) (${data.dates_found ?? '?'} dates detected) — edit if needed, then Apply`
      : 'No patients detected — expand "Raw OCR text" below to diagnose';
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
  document.getElementById('ocrPreview').style.display = 'none';
  document.getElementById('ocrDrop').style.display = 'block';
  document.getElementById('ocrResult').value = '';
  document.getElementById('ocrRaw').value = '';
  document.getElementById('ocrStatus').textContent = '';
  document.getElementById('ocrImg').src = '';
}
