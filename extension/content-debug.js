// content-debug.js — runs in MAIN world (world: "MAIN" in manifest)
// Exposes window.domDump() to the DevTools console.
//
// Selectors confirmed by DOM inspection:
//   - GWT app is in IFRAME1, found via input[name="patientName"]
//   - Search input:  input[name="patientName"]
//   - Search button: button.gwt-Button text="Search"
//   - Study table:   contains td "Study Instance UID"
//   - Series table:  contains td "Series Instance UID"

'use strict';

var UID_RE_DBG = /^[12]\.\d+\.\d[\d.]{18,}$/;
function dbgIsUid(s) { return typeof s === 'string' && UID_RE_DBG.test(s.trim()); }
function dbgIsVisible(el) { return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length); }

function dbgGetActiveDoc() {
  for (var iframe of document.querySelectorAll('iframe')) {
    try {
      var iDoc = iframe.contentDocument;
      if (iDoc && iDoc.querySelector('input[name="patientName"]')) return iDoc;
    } catch(e) {}
  }
  for (var iframe2 of document.querySelectorAll('iframe')) {
    try {
      var iDoc2 = iframe2.contentDocument;
      if (iDoc2 && iDoc2.querySelectorAll('input').length > 2) return iDoc2;
    } catch(e) {}
  }
  return document;
}

function dbgFindTableByHeader(d, headerText) {
  for (var cell of d.querySelectorAll('td')) {
    if (cell.textContent.trim() === headerText) return cell.closest('table');
  }
  return null;
}

function dbgParseStudyTable(d) {
  var table = dbgFindTableByHeader(d, 'Study Instance UID');
  if (!table) return [];
  var headerCells = [], headerRow = null;
  for (var row of table.querySelectorAll('tr')) {
    var cells = [...row.querySelectorAll('td')].map(function(c) { return c.textContent.trim(); });
    if (cells.includes('Study Instance UID')) { headerRow = row; headerCells = cells; break; }
  }
  if (!headerRow) return [];
  var col = {
    uid:  headerCells.indexOf('Study Instance UID'),
    desc: headerCells.indexOf('Study Description'),
    date: headerCells.indexOf('Study Date'),
    mod:  headerCells.indexOf('Mod'),
    name: headerCells.indexOf('Patient Name'),
  };
  var results = [], pastHeader = false;
  for (var row2 of table.querySelectorAll('tr')) {
    if (row2 === headerRow) { pastHeader = true; continue; }
    if (!pastHeader) continue;
    var cells2 = [...row2.querySelectorAll('td')];
    var uid = cells2[col.uid] && cells2[col.uid].textContent.trim();
    if (!uid || !dbgIsUid(uid)) continue;
    var rawDate = (cells2[col.date] && cells2[col.date].textContent.trim()) || '';
    var dm = rawDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
    results.push({
      uid:         uid.slice(-20),
      description: (cells2[col.desc] && cells2[col.desc].textContent.trim()) || '',
      date:        dm ? dm[1]+dm[2]+dm[3] : rawDate.substring(0,10),
      mod:         (cells2[col.mod]  && cells2[col.mod].textContent.trim())  || '',
      patient:     (cells2[col.name] && cells2[col.name].textContent.trim()) || '',
    });
  }
  return results;
}

function dbgParseSeriesTable(d) {
  var table = dbgFindTableByHeader(d, 'Series Instance UID');
  if (!table) return [];
  var headerCells = [], headerRow = null;
  for (var row of table.querySelectorAll('tr')) {
    var cells = [...row.querySelectorAll('td')].map(function(c) { return c.textContent.trim(); });
    if (cells.includes('Series Instance UID')) { headerRow = row; headerCells = cells; break; }
  }
  if (!headerRow) return [];
  var col = {
    uid:  headerCells.indexOf('Series Instance UID'),
    desc: headerCells.indexOf('Series Description'),
  };
  var results = [], pastHeader = false;
  for (var row2 of table.querySelectorAll('tr')) {
    if (row2 === headerRow) { pastHeader = true; continue; }
    if (!pastHeader) continue;
    var cells2 = [...row2.querySelectorAll('td')];
    var uid = cells2[col.uid] && cells2[col.uid].textContent.trim();
    if (!uid || !dbgIsUid(uid)) continue;
    results.push({
      uid:         uid.slice(-20),
      description: (cells2[col.desc] && cells2[col.desc].textContent.trim()) || '',
    });
  }
  return results;
}

window.domDump = function () {
  var d = dbgGetActiveDoc();
  console.log('[DOM Dump] Active doc: ' + (d === document ? 'TOP (unexpected!)' : 'iframe ✓'));

  // A — search input
  var inp = d.querySelector('input[name="patientName"]');
  console.log('[DOM Dump] ── A) Search input ──');
  console.log(inp ? '  FOUND: input[name="patientName"] value="' + inp.value + '"' : '  NOT FOUND');

  // B — search button
  var btn = null;
  for (var b of d.querySelectorAll('button.gwt-Button, button')) {
    if (b.textContent.trim() === 'Search') { btn = b; break; }
  }
  console.log('[DOM Dump] ── B) Search button ──');
  console.log(btn ? '  FOUND: button.gwt-Button text="Search"' : '  NOT FOUND');

  // C — study table
  var studyRows = dbgParseStudyTable(d);
  console.log('[DOM Dump] ── C) Study table rows: ' + studyRows.length + ' ──');
  if (studyRows.length > 0) console.table(studyRows);
  else console.warn('  Study table not found or empty. Is a search result loaded?');

  // D — series table
  var seriesRows = dbgParseSeriesTable(d);
  console.log('[DOM Dump] ── D) Series table rows: ' + seriesRows.length + ' ──');
  if (seriesRows.length > 0) console.table(seriesRows);
  else console.warn('  Series table not found or empty. Click a study row first.');

  // E — all visible inputs (for troubleshooting)
  var inputs = [...d.querySelectorAll('input')].filter(dbgIsVisible);
  console.log('[DOM Dump] ── E) Visible inputs: ' + inputs.length + ' ──');
  console.table(inputs.map(function(el, i) {
    return { i: i, type: el.type, name: el.name, class: el.className.substring(0,40), value: el.value.substring(0,30) };
  }));
};

console.log('[PACS-DOM] domDump() ready — sections: A=search input, B=search button, C=study table, D=series table, E=all inputs');
