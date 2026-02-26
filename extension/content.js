// content.js — DOM-based approach (pacs-preloader-DOM v2.0.0)
// Automates InteleBrowser UI to get Study/Series Instance UIDs from the
// rendered DOM tables, then calls ViewPatInfo to fetch images.
//
// Selectors confirmed by DOM inspection:
//   - GWT app lives in IFRAME1 (found via input[name="patientName"])
//   - Search input:  input[name="patientName"]
//   - Search button: button.gwt-Button  text="Search"
//   - Study table:   table containing td text="Study Instance UID"
//   - Series table:  table containing td text="Series Instance UID"
//   - Study date format in cells: "2026-01-26 05:33 AM"

'use strict';

console.log('[PACS-DOM] Content script loaded (DOM v2.0.0)');

// ══════════════════════════════════════════════════════════════════════
// UTILITIES
// ══════════════════════════════════════════════════════════════════════

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function poll(fn, { interval = 400, timeout = 20000, desc = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = fn();
    if (result) return result;
    await sleep(interval);
  }
  throw new Error(`[PACS-DOM] Timeout waiting for ${desc} (${timeout}ms)`);
}

async function pollSoft(fn, opts = {}) {
  try { return await poll(fn, opts); } catch { return null; }
}

// ══════════════════════════════════════════════════════════════════════
// SESSION EXTRACTION  (identical to original)
// ══════════════════════════════════════════════════════════════════════

function getSessionParams() {
  const params = {};
  const usernameEl   = document.getElementById('username');
  const sessionIdEl  = document.getElementById('sessionId');
  const xmppDomainEl = document.getElementById('xmppDomain');
  if (usernameEl)   params.UserName   = usernameEl.value;
  if (sessionIdEl)  params.SID        = sessionIdEl.value;
  if (xmppDomainEl) params.xmppDomain = xmppDomainEl.value;
  if (window.__pacsSessionHost) params.SessionHost = window.__pacsSessionHost;

  if (!params.SID) {
    try {
      for (const iframe of document.querySelectorAll('iframe')) {
        const iDoc = iframe.contentDocument;
        if (!iDoc) continue;
        const iSession = iDoc.getElementById('sessionId');
        const iUser    = iDoc.getElementById('username');
        const iDomain  = iDoc.getElementById('xmppDomain');
        if (iSession) params.SID         = iSession.value;
        if (iUser)    params.UserName    = iUser.value;
        if (iDomain)  params.SessionHost = iDomain.value;
        if (params.SID) break;
      }
    } catch (e) { /* cross-origin */ }
  }
  return params;
}

// ══════════════════════════════════════════════════════════════════════
// UID HELPERS
// ══════════════════════════════════════════════════════════════════════

const UID_RE = /^[12]\.\d+\.\d[\d.]{18,}$/;
function isUid(s) { return typeof s === 'string' && UID_RE.test(s.trim()); }

function extractDateFromUid(uid) {
  const lastSeg = uid.split('.').pop() || '';
  const m = lastSeg.match(/^(\d{2})(\d{2})(\d{2})/);
  if (!m) return '';
  const mm = parseInt(m[2], 10), dd = parseInt(m[3], 10);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return '';
  return `20${m[1]}${m[2]}${m[3]}`;
}

// ══════════════════════════════════════════════════════════════════════
// ACTIVE DOCUMENT — GWT app lives in IFRAME1
// ══════════════════════════════════════════════════════════════════════

/**
 * Return the document containing the InteleBrowser GWT application.
 * Identified by the presence of input[name="patientName"].
 */
function getActiveDoc() {
  for (const iframe of document.querySelectorAll('iframe')) {
    try {
      const iDoc = iframe.contentDocument;
      if (iDoc && iDoc.querySelector('input[name="patientName"]')) return iDoc;
    } catch (e) { /* cross-origin */ }
  }
  // Fallback: first iframe with several inputs
  for (const iframe of document.querySelectorAll('iframe')) {
    try {
      const iDoc = iframe.contentDocument;
      if (iDoc && iDoc.querySelectorAll('input').length > 2) return iDoc;
    } catch (e) { /* cross-origin */ }
  }
  return document;
}

// ══════════════════════════════════════════════════════════════════════
// FORM ELEMENT FINDERS
// ══════════════════════════════════════════════════════════════════════

function findSearchInput() {
  return getActiveDoc().querySelector('input[name="patientName"]');
}

function findSearchButton() {
  const d = getActiveDoc();
  for (const btn of d.querySelectorAll('button.gwt-Button, button')) {
    if (btn.textContent.trim() === 'Search') return btn;
  }
  return null;
}

/**
 * Click the "All Dates" radio button so searches aren't limited to
 * a recent date window. Best-effort; doesn't throw if not found.
 */
function setDateFilterAllDates() {
  const d = getActiveDoc();
  for (const span of d.querySelectorAll('span.gwt-RadioButton')) {
    if (span.textContent.trim() === 'All Dates') {
      const input = span.querySelector('input[type="radio"]');
      if (input) { input.click(); return true; }
    }
  }
  return false;
}

/**
 * Set a GWT TextBox value and fire the events GWT listens to.
 */
function setInputValue(input, value) {
  input.focus();
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  if (nativeSetter && nativeSetter.set) {
    nativeSetter.set.call(input, value);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new Event('input',  { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function clearInput(input) { setInputValue(input, ''); }

function pressEnter(input) {
  const opts = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
  input.dispatchEvent(new KeyboardEvent('keydown',  opts));
  input.dispatchEvent(new KeyboardEvent('keypress', opts));
  input.dispatchEvent(new KeyboardEvent('keyup',    opts));
}

// ══════════════════════════════════════════════════════════════════════
// TABLE PARSING — column-index based (reliable, no content guessing)
// ══════════════════════════════════════════════════════════════════════

/**
 * Find the first table that contains a <td> with the exact given header text.
 * Searches the active GWT document first, then falls back to all accessible iframes
 * (the series panel may render in a separate frame from the search form).
 */
function findTableByHeader(headerText) {
  const d = getActiveDoc();
  for (const cell of d.querySelectorAll('td')) {
    if (cell.textContent.trim() === headerText) return cell.closest('table');
  }
  // Fallback: check every accessible iframe
  for (const iframe of document.querySelectorAll('iframe')) {
    try {
      const iDoc = iframe.contentDocument;
      if (!iDoc || iDoc === d) continue;
      for (const cell of iDoc.querySelectorAll('td')) {
        if (cell.textContent.trim() === headerText) return cell.closest('table');
      }
    } catch (e) { /* cross-origin */ }
  }
  return null;
}

/**
 * Read all data rows from the study results table.
 * Returns [{ studyUid, description, studyDate, modality, patientName, row }]
 *
 * Study table columns (confirmed):
 *   Patient Name | M.R.N. | DOB | Sex | Req. No. | Study Date | Mod |
 *   Series | Study Description | Study Instance UID
 *
 * Date cell format: "2026-01-26 05:33 AM"
 */
function parseStudyTable() {
  const table = findTableByHeader('Study Instance UID');
  if (!table) return [];

  // Locate header row
  let headerRow = null;
  let headerCells = [];
  for (const row of table.querySelectorAll('tr')) {
    const cells = [...row.querySelectorAll('td')].map(c => c.textContent.trim());
    if (cells.includes('Study Instance UID')) {
      headerRow  = row;
      headerCells = cells;
      break;
    }
  }
  if (!headerRow) return [];

  const col = {
    uid:  headerCells.indexOf('Study Instance UID'),
    desc: headerCells.indexOf('Study Description'),
    date: headerCells.indexOf('Study Date'),
    mod:  headerCells.indexOf('Mod'),
    name: headerCells.indexOf('Patient Name'),
  };

  const results = [];
  let pastHeader = false;

  for (const row of table.querySelectorAll('tr')) {
    if (row === headerRow) { pastHeader = true; continue; }
    if (!pastHeader) continue;

    const cells = [...row.querySelectorAll('td')];
    if (cells.length <= col.uid || col.uid < 0) continue;

    const studyUid = cells[col.uid]?.textContent.trim();
    if (!isUid(studyUid)) continue;

    // Date: "2026-01-26 05:33 AM" → "20260126"
    let studyDate = '';
    if (col.date >= 0) {
      const raw = cells[col.date]?.textContent.trim() || '';
      const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) studyDate = m[1] + m[2] + m[3];
    }

    results.push({
      studyUid,
      description: col.desc >= 0 ? (cells[col.desc]?.textContent.trim() || '') : '',
      studyDate,
      modality:    col.mod  >= 0 ? (cells[col.mod]?.textContent.trim()  || '') : '',
      patientName: col.name >= 0 ? (cells[col.name]?.textContent.trim() || '') : '',
      row,
    });
  }

  return results;
}

/**
 * Read all data rows from the series panel table.
 * Returns [{ seriesUid, description }]
 *
 * Series table columns (confirmed):
 *   Patient Name | Series Date | Mod | Series# | Images |
 *   Series Description | Source AE | Owner AE | Series Instance UID
 */
function parseSeriesTable() {
  const table = findTableByHeader('Series Instance UID');
  if (!table) return [];

  let headerRow = null;
  let headerCells = [];
  for (const row of table.querySelectorAll('tr')) {
    const cells = [...row.querySelectorAll('td')].map(c => c.textContent.trim());
    if (cells.includes('Series Instance UID')) {
      headerRow   = row;
      headerCells = cells;
      break;
    }
  }
  if (!headerRow) return [];

  const col = {
    uid:  headerCells.indexOf('Series Instance UID'),
    desc: headerCells.indexOf('Series Description'),
  };

  const results = [];
  let pastHeader = false;

  for (const row of table.querySelectorAll('tr')) {
    if (row === headerRow) { pastHeader = true; continue; }
    if (!pastHeader) continue;

    const cells = [...row.querySelectorAll('td')];
    if (cells.length <= col.uid || col.uid < 0) continue;

    const seriesUid = cells[col.uid]?.textContent.trim();
    if (!isUid(seriesUid)) continue;

    results.push({
      seriesUid,
      description: col.desc >= 0 ? (cells[col.desc]?.textContent.trim() || '') : '',
    });
  }

  return results;
}

// ══════════════════════════════════════════════════════════════════════
// MAIN DOM SEARCH FUNCTION
// ══════════════════════════════════════════════════════════════════════

async function searchPatientDOM(name, dob, debug = false) {
  const log = msg => console.log('[PACS-DOM]', msg);

  // Clean name (strip middle initial — same as original)
  let cleanName = name;
  if (cleanName.includes(',')) {
    const parts = cleanName.split(',').map(s => s.trim());
    cleanName = `${parts[0]}, ${(parts[1] || '').split(/\s+/)[0]}`;
  }
  cleanName = cleanName.replace(/\s+[A-Za-z]\.?$/, '').trim();
  log(`Searching: "${cleanName}" (original: "${name}", DOB: ${dob || 'none'})`);

  // ── Find search input ──
  const searchInput = findSearchInput();
  if (!searchInput) {
    throw new Error('input[name="patientName"] not found — is the Patient Search page open?');
  }

  // ── Set date filter to "All Dates" ──
  const dateSet = setDateFilterAllDates();
  log(`Date filter set to All Dates: ${dateSet}`);
  await sleep(100);

  // ── Snapshot current study UIDs ──
  const preSearchUids = new Set(parseStudyTable().map(s => s.studyUid));
  log(`Pre-search study UIDs: ${preSearchUids.size}`);

  // ── Fill and trigger search ──
  clearInput(searchInput);
  await sleep(100);
  setInputValue(searchInput, cleanName.toLowerCase());
  await sleep(100);

  const btn = findSearchButton();
  if (btn) {
    log('Clicking Search button');
    btn.click();
  } else {
    log('Search button not found — pressing Enter');
    pressEnter(searchInput);
  }

  // ── Wait for study table to update ──
  log('Waiting for results...');
  const nameParts = cleanName.toLowerCase().split(/[,\s]+/).filter(p => p.length > 1);

  let studyRows = null;
  try {
    studyRows = await poll(() => {
      const rows = parseStudyTable();
      if (rows.length === 0) return null;

      // Prefer rows matching the searched name
      const matching = rows.filter(r =>
        nameParts.some(p => r.patientName.toLowerCase().includes(p))
      );
      if (matching.length > 0) return matching;

      // Accept any change in the study UID set
      const currentUids = new Set(rows.map(r => r.studyUid));
      if ([...currentUids].some(u => !preSearchUids.has(u))) return rows;

      return null;
    }, { timeout: 25000, interval: 500, desc: 'search results' });
  } catch {
    log('No results within 25s');
    return { studies: [], patientNamesFound: [] };
  }

  log(`Found ${studyRows.length} study row(s)`);

  // ── Click each study row to load its series ──
  const studies = [];

  for (let i = 0; i < studyRows.length; i++) {
    const sr = studyRows[i];
    log(`Study ${i+1}/${studyRows.length}: "${sr.description}" [${sr.studyUid.slice(-14)}...]`);

    // Snapshot series before clicking
    const beforeSeriesUids = new Set(parseSeriesTable().map(s => s.seriesUid));

    // GWT registers click handlers via event delegation on <td>, not <tr>.
    // Fire the full mouse event sequence so GWT's sinkEvents system picks it up.
    const clickTarget = sr.row.querySelector('td') || sr.row;
    for (const evType of ['mousedown', 'mouseup', 'click']) {
      clickTarget.dispatchEvent(new MouseEvent(evType, { bubbles: true, cancelable: true }));
    }
    await sleep(300);

    // Wait for series table to show different UIDs
    let seriesRows = await pollSoft(() => {
      const current = parseSeriesTable();
      if (current.length === 0) return null;
      const currentUids = new Set(current.map(s => s.seriesUid));
      const changed = current.length !== beforeSeriesUids.size ||
                      [...currentUids].some(u => !beforeSeriesUids.has(u));
      return changed ? current : null;
    }, { timeout: 8000, interval: 300, desc: 'series table update' });

    if (!seriesRows) {
      // Table didn't change — may already be showing the right series (first row auto-selected)
      seriesRows = parseSeriesTable();
      log(`  Series unchanged after click, using current: ${seriesRows.length}`);
    }

    log(`  → ${seriesRows.length} series: ${seriesRows.map(s => s.description || s.seriesUid.slice(-8)).join(', ')}`);

    studies.push({
      studyUid:    sr.studyUid,
      description: sr.description,
      studyDate:   sr.studyDate,
      patientName: sr.patientName || name.toUpperCase(),
      patientDob:  dob ? (normalizeDob(dob) || '') : '',
      modality:    sr.modality,
      series:      seriesRows,
    });

    await sleep(350);
  }

  // ── DOB filter ──
  let result = studies;
  if (dob && result.length > 0) {
    const dobNorm = normalizeDob(dob);
    if (dobNorm) {
      const filtered = result.filter(s => s.patientDob === dobNorm);
      if (filtered.length > 0) {
        log(`DOB filter: ${result.length} → ${filtered.length}`);
        result = filtered;
      } else {
        log('DOB filter matched nothing — keeping all');
      }
    }
  }

  const patientNamesFound = [...new Set(result.map(s => s.patientName).filter(Boolean))];
  log(`Done: ${result.length} studies, patients: ${patientNamesFound.join(', ')}`);
  return { studies: result, patientNamesFound };
}

// ══════════════════════════════════════════════════════════════════════
// NORMALIZE DOB  (identical to original)
// ══════════════════════════════════════════════════════════════════════

function normalizeDob(dob) {
  const m = dob.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}${m[1].padStart(2,'0')}${m[2].padStart(2,'0')}`;
  if (/^\d{8}$/.test(dob)) return dob;
  return null;
}

// ══════════════════════════════════════════════════════════════════════
// STUDY FILTERS  (identical to original)
// ══════════════════════════════════════════════════════════════════════

const SPINE_REGION_KEYWORDS = {
  lumbar:   ['lumbar', 'lumbosacral', 'l-spine', 'l spine', 'l1', 'l2', 'l3', 'l4', 'l5', 's1', 'sacrum', 'sacral', 'coccyx', 'scoliosis', 'spine'],
  cervical: ['cervical', 'c-spine', 'c spine', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'myelogram'],
  thoracic: ['thoracic', 't-spine', 't spine', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10', 't11', 't12'],
};

const MODALITY_FILTERS = { xr: ['XR','CR','DX','RF'], ct: ['CT'], mr: ['MR','MRI'] };

function filterStudies(studies, options = {}) {
  let filtered = studies;

  if (options.spineRegions && options.spineRegions.length > 0) {
    filtered = filtered.filter(s => {
      const desc = (s.description || '').toLowerCase();
      return options.spineRegions.some(region =>
        (SPINE_REGION_KEYWORDS[region] || []).some(kw => desc.includes(kw))
      );
    });
    console.log(`[PACS-DOM] Spine filter: ${studies.length} → ${filtered.length}`);
  }

  if (options.modalities && options.modalities.length > 0) {
    const allowedMods = options.modalities.flatMap(m => MODALITY_FILTERS[m] || []);
    if (allowedMods.length > 0) {
      const before = filtered.length;
      const KNOWN_MOD_RE = /^(XR|MRI|MR|CT|DX|US|RF|NM|PT|CR|DR|DS|SC|OT)[\s\-]/i;
      filtered = filtered.filter(s => {
        const desc = (s.description || '').trim();
        if (allowedMods.some(mod => new RegExp(`^${mod}[\\s\\-]`, 'i').test(desc))) return true;
        if (options.modalities.includes('xr') && !KNOWN_MOD_RE.test(desc)) return true;
        return false;
      });
      console.log(`[PACS-DOM] Modality filter: ${before} → ${filtered.length}`);
    }
  }

  return filtered;
}

// ══════════════════════════════════════════════════════════════════════
// CONCURRENCY HELPER
// ══════════════════════════════════════════════════════════════════════

/**
 * Run an array of async task functions with at most `concurrency` running at once.
 * Returns an array of results in the same order as tasks.
 */
async function pLimit(tasks, concurrency) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      try { results[i] = await tasks[i](); }
      catch (e) { results[i] = null; console.warn('[PACS-DOM] task error:', e.message); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

// ══════════════════════════════════════════════════════════════════════
// BATCH PRELOAD — parallel ViewPatInfo + image download for one study
// ══════════════════════════════════════════════════════════════════════

/**
 * Fetch all series images for a study in parallel and upload to the local server.
 * 3 concurrent ViewPatInfo calls, 4 concurrent image downloads.
 *
 * Called via the 'batchPreloadStudy' message from popup.js.
 */
async function batchPreloadStudy({ studyUid, series, patient, studyDescription, studyDate, serverUrl, clinicDate }) {
  let resolvedStudyDate = studyDate || '';

  // ── Step 1: ViewPatInfo for all series, 3 at a time ──
  const viewTasks = series.map(s => async () => {
    const result = await getStudyImages(studyUid, s.seriesUid);
    if (result.studyDate && !resolvedStudyDate) resolvedStudyDate = result.studyDate;
    return { series: s, urls: result.urls || [], studyDate: result.studyDate || '' };
  });

  const seriesResults = await pLimit(viewTasks, 3);

  // ── Step 2: Collect all image download tasks ──
  const downloadTasks = [];
  for (const sr of seriesResults) {
    if (!sr || !sr.urls.length) continue;
    const desc = studyDescription +
      (sr.series.description ? ' - ' + sr.series.description : '');
    const sDate = sr.studyDate || resolvedStudyDate;

    sr.urls.forEach((url, i) => {
      downloadTasks.push(async () => {
        try {
          const imgResp = await fetch(url, { credentials: 'include' });
          if (!imgResp.ok) return 0;
          const blob = await imgResp.blob();
          if (blob.size < 100) return 0;

          const imageUid = getImageUidFromUrl(url);

          const fd = new FormData();
          fd.append('image',             blob, `image_${i}.jpg`);
          fd.append('patient_name',      patient.name);
          fd.append('patient_dob',       patient.dob);
          fd.append('study_uid',         studyUid);
          fd.append('dicom_study_uid',   studyUid);
          fd.append('study_description', desc.trim());
          fd.append('study_date',        sDate);
          fd.append('image_index',       String(i));
          fd.append('clinic_date',       clinicDate || '');
           fd.append('image_uid',         imageUid);

          const resp = await fetch(`${serverUrl}/api/images`, { method: 'POST', body: fd });
          return resp.ok ? 1 : 0;
        } catch { return 0; }
      });
    });
  }

  // ── Step 3: Download + upload all images, 4 at a time ──
  const downloadResults = await pLimit(downloadTasks, 4);
  const count = downloadResults.reduce((a, b) => (a || 0) + (b || 0), 0);

  console.log(`[PACS-DOM] batchPreloadStudy "${studyDescription}": ${count}/${downloadTasks.length} images`);
  return { count, studyDate: resolvedStudyDate };
}

// ══════════════════════════════════════════════════════════════════════
// IMAGE RETRIEVAL (ViewPatInfo)  — identical to original
// ══════════════════════════════════════════════════════════════════════

async function getStudyImages(studyUid, seriesUid) {
  const session = getSessionParams();
  console.log(`[PACS-DOM] ViewPatInfo: study=...${studyUid.slice(-12)} series=...${seriesUid.slice(-12)}`);

  if (!seriesUid) return { urls: [], error: 'Series UID required' };

  const sessionHost = session.SessionHost || session.xmppDomain || '';
  const allUrls = new Set();
  let curpos = 1;
  let studyDate = '';

  while (true) {
    const formData = new URLSearchParams();
    formData.append('UserName',          session.UserName || '');
    formData.append('SID',               session.SID || '');
    formData.append('SessionHost',       sessionHost);
    formData.append('Action',            'inlinejpg');
    formData.append('study',             studyUid);
    formData.append('series',            seriesUid);
    formData.append('maxImagesPerPage0', '999');
    formData.append('curpos0',           String(curpos));

    try {
      const response = await fetch('/InteleBrowser/InteleBrowser.ViewPatInfo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData.toString(),
        credentials: 'include'
      });
      if (!response.ok) throw new Error(`ViewPatInfo HTTP ${response.status}`);

      const html = await response.text();
      console.log(`[PACS-DOM] ViewPatInfo length=${html.length} curpos=${curpos}`);

      if (curpos === 1) {
        const hostMatch = html.match(/name="SessionHost"\s+value="([^"]+)"/i);
        if (hostMatch?.[1]) {
          window.__pacsSessionHost = hostMatch[1];
          console.log('[PACS-DOM] SessionHost:', hostMatch[1]);
        }
        if (!studyDate) {
          const fld = html.match(/name=["']?(?:StudyDate|studyDate|study_date)["']?\s+value=["'](\d{8})["']/i);
          if (fld) { studyDate = fld[1]; }
          else {
            const raw = html.match(/\b(20[12]\d(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))\b/);
            if (raw) studyDate = raw[1];
          }
          if (studyDate) console.log('[PACS-DOM] Study date:', studyDate);
        }
      }

      const pageUrls = extractImageUrls(html);
      console.log(`[PACS-DOM] curpos=${curpos}: ${pageUrls.length} URL(s)`);
      if (pageUrls.length === 0) break;

      const prevSize = allUrls.size;
      for (const url of pageUrls) allUrls.add(url);
      if (allUrls.size === prevSize || allUrls.size >= 500) break;
      if (pageUrls.length < 999) break;
      curpos += pageUrls.length;

    } catch (err) {
      console.error('[PACS-DOM] ViewPatInfo error:', err);
      throw err;
    }
  }

  console.log(`[PACS-DOM] Total images: ${allUrls.size}`);
  return { urls: [...allUrls], studyDate };
}

function extractImageUrls(html) {
  const urls = new Set();
  const origin = window.location.origin;
  const doc = new DOMParser().parseFromString(html, 'text/html');

  for (const img of doc.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    if (src.includes('JpegServlet') || src.includes('getJpeg')) urls.add(makeAbsolute(src, origin));
  }
  if (urls.size === 0) {
    for (const m of html.matchAll(/((?:https?:\/\/[^'")\s]*)?\/JpegServlet\/getJpeg[^'")\s<>]+)/g)) {
      urls.add(makeAbsolute(m[1], origin));
    }
  }
  return [...urls];
}

function makeAbsolute(url, origin) {
  if (url.startsWith('http')) return url;
  if (url.startsWith('/'))    return `${origin}${url}`;
  return `${origin}/${url}`;
}

// ══════════════════════════════════════════════════════════════════════
// FETCH AND SEND IMAGES  (identical to original)
// ══════════════════════════════════════════════════════════════════════

function getImageUidFromUrl(url) {
  try {
    const u = new URL(url, window.location.origin);
    const sop  = u.searchParams.get('sop')  || '';
    const path = u.searchParams.get('path') || '';
    if (sop || path) return `${sop}|${path}`;
    return u.pathname + '?' + u.searchParams.toString();
  } catch {
    return String(url || '');
  }
}

async function fetchAndSendImages(urls, patient, study, serverUrl, clinicDate) {
  let count = 0;
  for (let i = 0; i < urls.length; i++) {
    try {
      const imgResponse = await fetch(urls[i], { credentials: 'include' });
      if (!imgResponse.ok) { console.warn(`[PACS-DOM] Image ${i}: HTTP ${imgResponse.status}`); continue; }
      const blob = await imgResponse.blob();
      if (blob.size < 100) { console.warn(`[PACS-DOM] Image ${i} too small`); continue; }

      const imageUid = getImageUidFromUrl(urls[i]);

      const fd = new FormData();
      fd.append('image',             blob, `image_${i}.jpg`);
      fd.append('patient_name',      patient.name);
      fd.append('patient_dob',       patient.dob);
      fd.append('study_uid',         study.uid || '');
      fd.append('dicom_study_uid',   study.dicom_study_uid || '');
      fd.append('study_description', study.description || '');
      fd.append('study_date',        study.date || '');
      fd.append('image_index',       String(i));
      fd.append('clinic_date',       clinicDate || '');
      fd.append('image_uid',         imageUid);

      const resp = await fetch(`${serverUrl}/api/images`, { method: 'POST', body: fd });
      if (resp.ok) { count++; console.log(`[PACS-DOM] Saved ${i+1}/${urls.length}`); }
    } catch (err) {
      console.warn(`[PACS-DOM] Image ${i}:`, err.message);
    }
    await sleep(150);
  }
  return { count };
}

// ══════════════════════════════════════════════════════════════════════
// MESSAGE HANDLER
// ══════════════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[PACS-DOM] Message:', message.action);

  switch (message.action) {
    case 'searchPatient':
      searchPatientDOM(message.name, message.dob, message.debug || false)
        .then(result => {
          if (message.filters && result.studies) result.studies = filterStudies(result.studies, message.filters);
          // Strip non-serializable DOM elements (row) before crossing the message boundary
          if (result.studies) {
            result.studies = result.studies.map(({ row, ...rest }) => rest);
          }
          sendResponse(result);
        })
        .catch(err => sendResponse({ error: err.message, studies: [] }));
      return true;

    case 'dumpDebug':
      window.domDump();
      sendResponse({ ok: true });
      return false;

    case 'getStudyImages':
      getStudyImages(message.studyUid, message.seriesUid)
        .then(sendResponse)
        .catch(err => sendResponse({ error: err.message, urls: [] }));
      return true;

    case 'fetchAndSendImages':
      fetchAndSendImages(message.urls, message.patient, message.study, message.serverUrl, message.clinicDate)
        .then(sendResponse)
        .catch(err => sendResponse({ error: err.message, count: 0 }));
      return true;

    case 'batchPreloadStudy':
      batchPreloadStudy(message)
        .then(sendResponse)
        .catch(err => sendResponse({ error: err.message, count: 0 }));
      return true;

    case 'ping': {
      const session = getSessionParams();
      sendResponse({ ok: true, session, hasSession: !!(session.SID && session.UserName) });
      return false;
    }
  }
});

console.log('[PACS-DOM] Ready');
