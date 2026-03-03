"""
PACS Preloader — Local FastAPI Server

Receives images from the Chrome extension, stores them locally,
and serves an iPad-friendly swipe viewer.

Usage:
  pip install fastapi uvicorn python-multipart
  python server.py
"""

import os
import json
import re
import uuid
from pathlib import Path
from datetime import datetime

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import HTMLResponse, FileResponse, JSONResponse
from pydantic import BaseModel
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

# ── Config ──
DATA_DIR = Path("./pacs_data")
IMAGES_DIR = DATA_DIR / "images"
IMAGES_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="PACS Preloader")

# Allow Chrome extension to POST to us
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Extension runs from chrome-extension:// origin
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Data Store (JSON file per session) ──
def get_index_path():
    return DATA_DIR / "index.json"

def load_index():
    path = get_index_path()
    if path.exists():
        data = json.loads(path.read_text())
        if "pending_refreshes" not in data:
            data["pending_refreshes"] = {}
        return data
    return {"patients": {}, "pending_refreshes": {}, "updated": None}

def save_index(index):
    index["updated"] = datetime.now().isoformat()
    get_index_path().write_text(json.dumps(index, indent=2))


# ── API Endpoints ──

@app.get("/api/health")
def health():
    """Extension checks this to verify server is running."""
    return {"status": "ok", "time": datetime.now().isoformat()}


@app.post("/api/ocr")
async def ocr_image(image: UploadFile = File(...)):
    """OCR a clinic schedule screenshot, return extracted text."""
    try:
        import pytesseract
        from PIL import Image, ImageFilter, ImageOps
        import io, re
        pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'

        img = Image.open(io.BytesIO(await image.read()))

        # ── Preprocessing ──
        # 1. Grayscale — removes colour noise
        img = img.convert('L')
        # 2. Upscale 2× — screenshots are ~96 DPI; Tesseract is tuned for ~300 DPI
        w, h = img.size
        img = img.resize((w * 2, h * 2), Image.LANCZOS)
        # 3. Auto-contrast + sharpen — improves edge definition on small fonts
        img = ImageOps.autocontrast(img, cutoff=2)
        img = img.filter(ImageFilter.SHARPEN)

        # ── Try PSM modes; keep the result with the most detected dates ──
        date_re = re.compile(r'\b\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}\b')
        best_text, best_count = '', 0
        for psm in (6, 4, 3):   # 6=uniform block, 4=single column, 3=auto
            t = pytesseract.image_to_string(img, config=f'--psm {psm} --oem 1')
            n = len(date_re.findall(t))
            if n > best_count:
                best_count, best_text = n, t

        return {"text": best_text, "status": "ok", "dates_found": best_count}
    except ImportError:
        raise HTTPException(status_code=503, detail="pytesseract not installed. Run: pip install pytesseract pillow")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/patients/register")
async def register_patient(
    patient_name: str = Form(...),
    patient_dob: str = Form(""),
    clinic_date: str = Form(""),
):
    """Register a patient with no images yet (placeholder for pending preload)."""
    index = load_index()
    patient_key = sanitize_filename(f"{patient_name}_{patient_dob}")
    if patient_key not in index["patients"]:
        index["patients"][patient_key] = {
            "name": patient_name,
            "dob": patient_dob,
            "clinic_date": clinic_date,
            "studies": {},
            "image_count": 0,
            "created_at": datetime.now().isoformat(),
        }
        save_index(index)
    return {"status": "registered", "key": patient_key}


@app.post("/api/images")
async def receive_image(
    image: UploadFile = File(...),
    patient_name: str = Form(...),
    patient_dob: str = Form(""),
    study_uid: str = Form(""),
    study_description: str = Form(""),
    study_date: str = Form(""),
    image_index: str = Form("0"),
    clinic_date: str = Form(""),
    image_uid: str = Form(""),
    slice_location: str = Form(""),
    image_position: str = Form(""),
    image_orientation: str = Form(""),
    rows: str = Form(""),
    cols: str = Form(""),
    pixel_spacing: str = Form(""),
):
    """Receive an image from the Chrome extension and store it locally."""

    # Update index
    index = load_index()
    # Create / update patient
    patient_key = sanitize_filename(f"{patient_name}_{patient_dob}")
    patient_dir = IMAGES_DIR / patient_key
    patient_dir.mkdir(parents=True, exist_ok=True)
    if patient_key not in index["patients"]:
        index["patients"][patient_key] = {
            "name": patient_name,
            "dob": patient_dob,
            "clinic_date": clinic_date,
            "studies": {},
            "image_count": 0,
            "created_at": datetime.now().isoformat(),
        }
    elif clinic_date and not index["patients"][patient_key].get("clinic_date"):
        index["patients"][patient_key]["clinic_date"] = clinic_date

    patient = index["patients"][patient_key]
    # Use study UID when available; fall back to description+date so studies from
    # different dates never share a key even if descriptions are identical
    if study_uid:
        study_key = study_uid
    else:
        fallback_date = study_date or clinic_date or ""
        study_key = sanitize_filename(f"{study_description or 'study'}_{fallback_date}") or "unknown"
    if study_key not in patient["studies"]:
        patient["studies"][study_key] = {
            "uid": study_uid,
            "description": study_description,
            "date": study_date,
            "images": [],
        }

    study = patient["studies"][study_key]

    # Duplicate check: skip if this image UID already exists for this study
    if image_uid:
        for img in study["images"]:
            if img.get("uid") == image_uid:
                return {"status": "skipped", "reason": "duplicate", "patient": patient_key}

    # Save image file only after dedupe check
    study_prefix = sanitize_filename(study_description or study_uid or "study")
    filename = f"{study_prefix}_{image_index}_{uuid.uuid4().hex[:6]}.jpg"
    filepath = patient_dir / filename

    contents = await image.read()
    filepath.write_bytes(contents)

    image_entry = {
        "filename": filename,
        "path": str(filepath.relative_to(DATA_DIR)),
        "index": int(image_index),
        "saved_at": datetime.now().isoformat(),
    }
    if image_uid:
        image_entry["uid"] = image_uid
    if slice_location:
        try: image_entry["slice_location"] = float(slice_location)
        except ValueError: pass
    if image_position:
        try: image_entry["image_position"] = json.loads(image_position)
        except (json.JSONDecodeError, ValueError): pass
    if image_orientation:
        try: image_entry["image_orientation"] = json.loads(image_orientation)
        except (json.JSONDecodeError, ValueError): pass
    if rows:
        try: image_entry["rows"] = int(rows)
        except (ValueError, TypeError): pass
    if cols:
        try: image_entry["cols"] = int(cols)
        except (ValueError, TypeError): pass
    if pixel_spacing:
        try: image_entry["pixel_spacing"] = json.loads(pixel_spacing)
        except (json.JSONDecodeError, ValueError): pass

    study["images"].append(image_entry)
    patient["image_count"] = sum(
        len(s["images"]) for s in patient["studies"].values()
    )

    save_index(index)

    return {"status": "saved", "filename": filename, "patient": patient_key}


@app.get("/api/patients")
def list_patients():
    """List all preloaded patients."""
    index = load_index()
    patients = []
    for key, data in index["patients"].items():
        patients.append({
            "key": key,
            "name": data["name"],
            "dob": data["dob"],
            "clinic_date": data.get("clinic_date", ""),
            "image_count": data["image_count"],
            "study_count": len(data["studies"]),
        })
    # Sort: primary = clinic_date descending, secondary = schedule entry order (created_at) ascending
    patients.sort(key=lambda p: p.get("created_at", ""))           # secondary sort first (stable)
    patients.sort(key=lambda p: p["clinic_date"] or "", reverse=True)  # primary sort preserves secondary
    return {"patients": patients}


@app.get("/api/patients/{patient_key}")
def get_patient(patient_key: str):
    """Get details and image list for a patient."""
    index = load_index()
    if patient_key not in index["patients"]:
        raise HTTPException(status_code=404, detail="Patient not found")

    patient = index["patients"][patient_key]
    return {
        "name": patient["name"],
        "dob": patient["dob"],
        "studies": patient["studies"],
    }


@app.get("/api/images/{patient_key}/{filename}")
def serve_image(patient_key: str, filename: str):
    """Serve a cached image."""
    filepath = IMAGES_DIR / patient_key / filename
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="Image not found")
    return FileResponse(filepath, media_type="image/jpeg",
                        headers={"Cache-Control": "public, max-age=86400"})


@app.post("/api/patients/{patient_key}/request-refresh")
def request_refresh(patient_key: str):
    """Queue a refresh request for a patient."""
    index = load_index()
    if patient_key not in index["patients"]:
        raise HTTPException(status_code=404, detail="Patient not found")
    index["pending_refreshes"][patient_key] = datetime.utcnow().isoformat()
    save_index(index)
    return {"status": "queued"}


@app.get("/api/pending_refreshes")
def get_pending_refreshes():
    """Return all pending refresh requests (polled by the extension)."""
    index = load_index()
    return {"pending": index.get("pending_refreshes", {})}


@app.delete("/api/pending_refreshes/{patient_key}")
def clear_refresh(patient_key: str):
    """Clear a fulfilled refresh request."""
    index = load_index()
    index.get("pending_refreshes", {}).pop(patient_key, None)
    save_index(index)
    return {"status": "cleared"}


# ── Cast Display ──

_cast_state: dict = {"room1": "", "room2": "", "room3": ""}

ROOM_NAMES_PATH = DATA_DIR / "room_names.json"

def load_room_names() -> dict:
    if ROOM_NAMES_PATH.exists():
        try: return json.loads(ROOM_NAMES_PATH.read_text())
        except: pass
    return {"room1": "Room 1", "room2": "Room 2", "room3": "Room 3"}

def save_room_names(names: dict):
    ROOM_NAMES_PATH.write_text(json.dumps(names, indent=2))

_room_names: dict = load_room_names()


class CastPayload(BaseModel):
    url: str = ""


@app.post("/api/cast/{room_key}")
def set_cast_image(room_key: str, payload: CastPayload):
    """Set the image for a room — exclusively (clears all other rooms)."""
    if room_key not in _cast_state:
        raise HTTPException(status_code=404, detail="Unknown room")
    for r in _cast_state:
        _cast_state[r] = ""
    _cast_state[room_key] = payload.url
    return {"status": "ok", "room": room_key}


@app.delete("/api/cast/{room_key}")
def clear_cast_image(room_key: str):
    """Clear the cast image for a room."""
    if room_key not in _cast_state:
        raise HTTPException(status_code=404, detail="Unknown room")
    _cast_state[room_key] = ""
    return {"status": "ok"}


@app.get("/api/cast/{room_key}")
def get_cast_image(room_key: str):
    """Return the current image URL for a cast room (polled by display page)."""
    if room_key not in _cast_state:
        raise HTTPException(status_code=404, detail="Unknown room")
    return {"url": _cast_state.get(room_key, ""), "name": _room_names.get(room_key, room_key)}


class RoomNamePayload(BaseModel):
    name: str

@app.put("/api/cast/{room_key}/name")
def set_room_name(room_key: str, payload: RoomNamePayload):
    """Set a custom display name for a cast room."""
    if room_key not in _cast_state:
        raise HTTPException(status_code=404, detail="Unknown room")
    _room_names[room_key] = payload.name[:40]
    save_room_names(_room_names)
    return {"status": "ok", "name": _room_names[room_key]}


def _cast_page_html(room_key: str) -> str:
    name = _room_names.get(room_key, room_key)
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>{name}</title>
  <style>
    * {{ margin:0; padding:0; box-sizing:border-box; }}
    body {{ background:#000; width:100vw; height:100vh; overflow:hidden;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }}
    #castFrame {{ position:fixed; inset:0; width:100%; height:100%; border:none; display:none; }}
    #idle {{
      position:fixed; inset:0; display:flex; flex-direction:column;
      align-items:center; justify-content:center; gap:16px;
    }}
    .idle-name {{ color:#1e293b; font-size:36px; font-weight:700; letter-spacing:.05em; }}
    .idle-sub  {{ color:#0f172a; font-size:16px; }}
  </style>
</head>
<body>
  <iframe id="castFrame" allowfullscreen></iframe>
  <div id="idle">
    <div class="idle-name">{name}</div>
    <div class="idle-sub">Waiting for image…</div>
  </div>
  <script>
    let currentUrl = null;
    let currentName = {json.dumps(name)};
    const frame = document.getElementById('castFrame');
    const idle  = document.getElementById('idle');

    async function poll() {{
      try {{
        const r = await fetch('/api/cast/{room_key}');
        if (!r.ok) return;
        const d = await r.json();
        if (d.name && d.name !== currentName) {{
          currentName = d.name;
          document.title = d.name;
          document.querySelector('.idle-name').textContent = d.name;
        }}
        if (d.url === currentUrl) return;
        currentUrl = d.url;
        if (d.url) {{
          frame.src = d.url;
          frame.style.display = 'block';
          idle.style.display = 'none';
        }} else {{
          frame.style.display = 'none';
          frame.src = '';
          idle.style.display = 'flex';
        }}
      }} catch(e) {{}}
    }}

    setInterval(poll, 1000);
    poll();
  </script>
</body>
</html>"""


@app.get("/cast/{room_key}", response_class=HTMLResponse)
def cast_display(room_key: str):
    """Serve the fullscreen cast display page for a room."""
    if room_key not in _cast_state:
        raise HTTPException(status_code=404, detail="Unknown room")
    return HTMLResponse(_cast_page_html(room_key), headers={"Cache-Control": "no-store"})


@app.post("/api/parse-pdf")
async def parse_pdf(file: UploadFile = File(...)):
    """Parse a clinic schedule PDF and return structured patient list + provider names."""
    try:
        import pdfplumber, io
    except ImportError:
        raise HTTPException(503, "pdfplumber not installed. Run: pip install pdfplumber")

    data = await file.read()
    patients = []
    providers_seen = {}
    ocr_used = False

    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for page in pdf.pages:
            # Try formal table extraction first
            page_patients = _parse_pdf_tables(page)
            if page_patients:
                for p in page_patients:
                    patients.append(p)
                    if p.get('provider'):
                        providers_seen[p['provider']] = True
                continue

            # Check if page has extractable text
            text = page.extract_text() or ''
            if not page.extract_words():
                # Image-only page — render and OCR with pymupdf + tesseract
                ocr_text = _ocr_pdf_page(data, page.page_number - 1)
                if ocr_text:
                    text = ocr_text
                    ocr_used = True

            for line in text.split('\n'):
                p = _parse_pdf_text_line(line.strip())
                if p:
                    patients.append(p)
                    if p.get('provider'):
                        providers_seen[p['provider']] = True

    return {"patients": patients, "providers": list(providers_seen),
            "count": len(patients), "ocr_used": ocr_used}


def _ocr_pdf_page(pdf_bytes: bytes, page_index: int) -> str:
    """Render an image-based PDF page and OCR it using spatial row reconstruction.

    image_to_string reads multi-column schedules column-by-column, so name and DOB
    end up on different lines and the parser misses everything.  image_to_data gives
    per-word bounding boxes; we group words by vertical centre into visual rows, sort
    each row left→right, and join — producing "@ 1:30 PM Smith, John 6/1/1970 Doe, MD"
    on a single line exactly as it appears on the page.
    Returns '' on any failure.
    """
    try:
        import fitz
    except ImportError:
        return ""
    try:
        import pytesseract
        from PIL import Image
        import io as _io
        pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'

        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        pg  = doc[page_index]
        pix = pg.get_pixmap(matrix=fitz.Matrix(2, 2), colorspace=fitz.csGRAY)
        img = Image.open(_io.BytesIO(pix.tobytes("png")))
        doc.close()

        data = pytesseract.image_to_data(
            img, config='--psm 6 --oem 1',
            output_type=pytesseract.Output.DICT,
        )

        # Collect words that have real text content
        words = []
        for i in range(len(data['text'])):
            text = str(data['text'][i]).strip()
            conf = int(data['conf'][i])
            if text and conf > 0:
                words.append({
                    'text': text,
                    'left': int(data['left'][i]),
                    'top':  int(data['top'][i]),
                    'h':    max(int(data['height'][i]), 1),
                })

        if not words:
            return ""

        # Cluster words into visual rows: two words belong to the same row when their
        # vertical centres are within ~70 % of the average word height of each other.
        avg_h   = sum(w['h'] for w in words) / len(words)
        row_tol = max(avg_h * 0.7, 8)

        words.sort(key=lambda w: w['top'])
        rows = [[words[0]]]
        for w in words[1:]:
            cur_mid = sum(ww['top'] + ww['h'] / 2 for ww in rows[-1]) / len(rows[-1])
            w_mid   = w['top'] + w['h'] / 2
            if abs(w_mid - cur_mid) <= row_tol:
                rows[-1].append(w)
            else:
                rows.append([w])

        # Sort each row left→right and join into a single line
        lines = []
        for row in rows:
            row.sort(key=lambda w: w['left'])
            lines.append(' '.join(w['text'] for w in row))

        return '\n'.join(lines)
    except Exception:
        return ""


def _parse_pdf_tables(page):
    """Try pdfplumber table extraction. Returns list of patient dicts, or []."""
    patients = []
    for table in (page.extract_tables() or []):
        if not table or len(table) < 2:
            continue
        header = [str(c or '').strip() for c in table[0]]
        col = _detect_columns(header)
        if col['name'] is None and col['last'] is None:
            continue
        for row in table[1:]:
            cells = [str(c or '').strip() for c in row]
            if col['name'] is not None and col['name'] < len(cells):
                name = cells[col['name']]
            else:
                last  = cells[col['last']]  if col['last']  is not None and col['last']  < len(cells) else ''
                first = cells[col['first']] if col['first'] is not None and col['first'] < len(cells) else ''
                name  = f"{last}, {first}".strip(', ')
            dob_raw  = (cells[col['dob']]      if col['dob']      is not None and col['dob']      < len(cells) else '').strip()
            provider = (cells[col['provider']] if col['provider'] is not None and col['provider'] < len(cells) else '').strip()
            clinic_date = (cells[col['date']]  if col['date']     is not None and col['date']     < len(cells) else '').strip()
            dob = _normalise_date(dob_raw)
            if not name.strip() or not dob:
                continue
            patients.append({"name": name.strip(), "dob": dob,
                             "clinic_date": clinic_date, "provider": provider})
    return patients


def _parse_pdf_text_line(line):
    """Parse a single text line for name + DOB + provider. Returns patient dict or None.

    Expected schedule format:
        {icon} {H:MM[AM|PM]} {Last, First MI.} {M/D/YYYY} {Provider, Cred}
    e.g. "@ 8:30AM Smith, John A. 6/25/1984 Erickson, Curt, PA-C"
    """
    if not line:
        return None
    date_pat = re.compile(r'\b(\d{1,2})[/\-](\d{1,2})[/\-](\d{2,4})\b')
    time_pat = re.compile(r'\b\d{1,2}:\d{2}\s*(?:AM|PM)?\s*', re.IGNORECASE)

    date_m = date_pat.search(line)
    if not date_m:
        return None

    mo, d, y = date_m.group(1), date_m.group(2), date_m.group(3)
    if len(y) == 2:
        y = ('19' if int(y) > 30 else '20') + y
    dob = f"{mo}/{d}/{y}"

    before = line[:date_m.start()]

    # Find the appointment time that precedes the patient name.
    # If no time appears before the DOB, this line is likely a header or summary
    # (e.g. "spine - 3/3/2026 Total: 59 Last refresh: 7:37 PM") — reject it.
    time_m = time_pat.search(before)
    if time_m:
        # Name is everything between the end of the time and the DOB
        name_raw = before[time_m.end():]
    else:
        # No time before DOB — fall back to old stripping but require a comma
        name_raw = re.sub(r'\b\d{5,}\b', '', before)  # strip MRN-style numbers
        if ',' not in name_raw:
            return None

    name = re.sub(r'\s{2,}', ' ', name_raw.replace('\t', ' ')).strip().rstrip(',').strip()
    if not name or len(name) < 3:
        return None

    # Reject header / footer / summary lines by keyword
    # e.g. "Page 1 of 2", "Total: 59", "Last refresh:", "spine - 3/3/2026 Total:..."
    if re.search(r'\bpage\s+\d+\b|\bof\s+\d+\b|\btotal\b|\brefresh\b|\bschedule\b|\bprinted\b',
                 name, re.IGNORECASE):
        return None

    # Provider is everything after the DOB date
    provider = line[date_m.end():].strip()

    return {"name": name, "dob": dob, "clinic_date": "", "provider": provider}


def _detect_columns(header):
    def find(keywords):
        for i, h in enumerate(header):
            if any(k in h.lower() for k in keywords):
                return i
        return None
    return {
        "name":     find(['patient name', 'patient', 'name']),
        "last":     find(['last']),
        "first":    find(['first']),
        "dob":      find(['dob', 'date of birth', 'birth date', 'birthdate']),
        "provider": find(['provider', 'physician', 'doctor', 'resource', 'attending']),
        "date":     find(['appt date', 'appointment date', 'clinic date', 'visit date', 'date']),
    }


def _normalise_date(raw):
    m = re.match(r'(\d{1,2})[/\-](\d{1,2})[/\-](\d{2,4})', raw)
    if not m:
        return raw
    mo, d, y = m.group(1), m.group(2), m.group(3)
    if len(y) == 2:
        y = ('19' if int(y) > 30 else '20') + y
    return f"{mo}/{d}/{y}"


@app.post("/api/debug-pdf")
async def debug_pdf(file: UploadFile = File(...)):
    """Return full pdfplumber extraction details for debugging the PDF parser."""
    try:
        import pdfplumber, io
    except ImportError:
        raise HTTPException(503, "pdfplumber not installed. Run: pip install pdfplumber")

    data = await file.read()
    result = {"filename": file.filename, "pages": []}

    with pdfplumber.open(io.BytesIO(data)) as pdf:
        result["total_pages"] = len(pdf.pages)
        for i, page in enumerate(pdf.pages):
            raw_text = page.extract_text() or ""
            words = page.extract_words() or []
            tables_raw = page.extract_tables() or []
            is_image_page = len(words) == 0

            page_info = {
                "page": i + 1,
                "width": float(page.width),
                "height": float(page.height),
                "raw_text": raw_text,
                "word_count": len(words),
                "table_count": len(tables_raw),
                "is_image_page": is_image_page,
                "tables": [],
                "text_lines": [],
                "ocr_text": None,
                "ocr_lines": [],
            }

            # Tables: header, column detection, first 10 data rows
            for ti, table in enumerate(tables_raw):
                if not table:
                    continue
                header = [str(c or "").strip() for c in table[0]]
                col_map = _detect_columns(header)
                page_info["tables"].append({
                    "table_index": ti,
                    "row_count": len(table),
                    "col_count": len(table[0]) if table else 0,
                    "header": header,
                    "column_detection": col_map,
                    "sample_rows": [
                        [str(c or "") for c in row]
                        for row in table[1:11]
                    ],
                })

            # Text lines from pdfplumber
            lines = raw_text.split("\n")
            page_info["line_count"] = len(lines)
            for line in lines[:80]:
                parsed = _parse_pdf_text_line(line.strip())
                page_info["text_lines"].append({
                    "line": line,
                    "parsed": parsed,
                })

            # If image-only page, attempt OCR and show those results too
            if is_image_page:
                ocr_text = _ocr_pdf_page(data, i)
                page_info["ocr_text"] = ocr_text or ""
                if ocr_text:
                    for line in ocr_text.split("\n")[:80]:
                        parsed = _parse_pdf_text_line(line.strip())
                        page_info["ocr_lines"].append({
                            "line": line,
                            "parsed": parsed,
                        })
                else:
                    page_info["ocr_error"] = (
                        "OCR returned empty — check that pymupdf and pytesseract are installed "
                        "(pip install pymupdf pytesseract) and Tesseract is at "
                        "C:\\Program Files\\Tesseract-OCR\\tesseract.exe"
                    )

            result["pages"].append(page_info)

    return JSONResponse(result)


@app.get("/pdf-debug", response_class=HTMLResponse)
def pdf_debug_page():
    """Serve the PDF parser debug tool."""
    return HTMLResponse("""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>PDF Parser Debug</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f172a;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:20px;font-size:13px}
h1{color:#38bdf8;font-size:18px;margin-bottom:16px}
h2{color:#94a3b8;font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin:18px 0 8px}
h3{color:#64748b;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;margin:10px 0 4px}
.upload-row{display:flex;gap:10px;align-items:center;margin-bottom:20px}
input[type=file]{background:#1e293b;border:1px solid #334155;border-radius:6px;color:#e2e8f0;padding:6px 10px;font-size:12px}
button{background:#0ea5e9;color:#fff;border:none;border-radius:6px;padding:7px 18px;font-size:13px;font-weight:600;cursor:pointer}
button:hover{background:#0284c7}
button:disabled{background:#1e3a5f;color:#475569;cursor:not-allowed}
.status{font-size:12px;color:#64748b}
.card{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:14px;margin-bottom:14px}
.page-header{font-size:14px;font-weight:600;color:#e0f2fe;margin-bottom:10px}
.meta{font-size:11px;color:#475569;margin-bottom:8px}
.section{margin-bottom:12px}
.raw-text{background:#0f172a;border:1px solid #1e293b;border-radius:4px;padding:8px;font-family:monospace;font-size:11px;white-space:pre-wrap;max-height:200px;overflow-y:auto;color:#94a3b8}
table{width:100%;border-collapse:collapse;font-size:11px;margin-top:6px}
th{background:#334155;color:#94a3b8;padding:4px 8px;text-align:left;border:1px solid #475569}
td{padding:3px 8px;border:1px solid #1e293b;color:#cbd5e1;font-family:monospace}
.match{color:#34d399}
.no-match{color:#475569}
.tag{display:inline-block;background:#1e293b;border:1px solid #334155;border-radius:3px;padding:1px 6px;font-size:10px;margin-right:4px}
.tag.found{background:rgba(56,189,248,.15);border-color:#38bdf8;color:#38bdf8}
.tag.miss{background:rgba(239,68,68,.1);border-color:#ef4444;color:#f87171}
.summary-box{background:#064e3b;border:1px solid #065f46;border-radius:6px;padding:10px 14px;margin-bottom:16px;color:#6ee7b7;font-size:13px}
.summary-box.warn{background:#451a03;border-color:#92400e;color:#fbbf24}
</style>
</head>
<body>
<h1>PDF Parser Debug</h1>
<div class="upload-row">
  <input type="file" id="pdfInput" accept=".pdf">
  <button id="runBtn" onclick="runDebug()">Analyse PDF</button>
  <span class="status" id="status"></span>
</div>
<div id="output"></div>
<script>
async function runDebug() {
  const file = document.getElementById('pdfInput').files[0];
  if (!file) { alert('Select a PDF first'); return; }
  const btn = document.getElementById('runBtn');
  const st  = document.getElementById('status');
  btn.disabled = true;
  st.textContent = 'Uploading…';
  const form = new FormData();
  form.append('file', file);
  try {
    const r = await fetch('/api/debug-pdf', { method: 'POST', body: form });
    if (!r.ok) {
      const e = await r.json().catch(() => ({ detail: r.statusText }));
      st.textContent = 'Error: ' + e.detail;
      btn.disabled = false;
      return;
    }
    const data = await r.json();
    render(data);
    st.textContent = 'Done — ' + data.total_pages + ' page(s)';
  } catch(e) {
    st.textContent = 'Server error: ' + e.message;
  }
  btn.disabled = false;
}

function esc(s){ const d=document.createElement('div');d.textContent=s||'';return d.innerHTML; }

function render(data) {
  const out = document.getElementById('output');

  // Count total patients extracted across all paths
  let tablePatients = 0, textPatients = 0;
  for (const pg of data.pages) {
    for (const t of pg.tables) {
      for (const row of (t.sample_rows || [])) {
        const col = t.column_detection;
        const nameIdx = col.name ?? col.last;
        const dobIdx  = col.dob;
        if (nameIdx != null && dobIdx != null && row[nameIdx] && row[dobIdx]) tablePatients++;
      }
    }
    for (const l of pg.text_lines) {
      if (l.parsed) textPatients++;
    }
  }

  let html = '';
  const imagePagesCount = data.pages.filter(p => p.is_image_page).length;
  const ocrPatients = data.pages.reduce((n, pg) => n + pg.ocr_lines.filter(l => l.parsed).length, 0);

  if (tablePatients > 0) {
    html += '<div class="summary-box">Table path found ~' + tablePatients + ' patient rows across sample rows shown.</div>';
  } else if (textPatients > 0) {
    html += '<div class="summary-box warn">No tables detected. Text-line fallback found ' + textPatients + ' candidate lines.</div>';
  } else if (imagePagesCount > 0 && ocrPatients > 0) {
    html += '<div class="summary-box">Image PDF detected (' + imagePagesCount + ' page(s) with no text). OCR found ' + ocrPatients + ' candidate line(s). Restart server after running <code>pip install pymupdf</code> if OCR section is empty.</div>';
  } else if (imagePagesCount > 0) {
    html += '<div class="summary-box warn">⚠ Image PDF — all pages have 0 words (scanned or image-based PDF). '
      + 'OCR fallback attempted — see per-page OCR section below. '
      + 'If OCR section is empty, run: <code>pip install pymupdf</code> then restart the server.</div>';
  } else {
    html += '<div class="summary-box warn">No patients found by either path. See raw text below to understand the PDF structure.</div>';
  }

  for (const pg of data.pages) {
    html += '<div class="card">';
    html += '<div class="page-header">Page ' + pg.page + '</div>';
    const imgBadge = pg.is_image_page ? ' &nbsp;<span style="background:#7c2d12;color:#fca5a5;font-size:10px;padding:1px 6px;border-radius:3px;font-weight:700">IMAGE PDF</span>' : '';
    html += '<div class="meta">' + pg.width.toFixed(0) + ' × ' + pg.height.toFixed(0) + ' pt &nbsp;|&nbsp; '
      + pg.word_count + ' words &nbsp;|&nbsp; '
      + pg.table_count + ' table(s) &nbsp;|&nbsp; '
      + pg.line_count + ' text lines' + imgBadge + '</div>';

    // Tables
    html += '<div class="section"><h3>Tables (' + pg.tables.length + ')</h3>';
    if (pg.tables.length === 0) {
      html += '<div class="no-match" style="font-size:11px">No tables extracted by pdfplumber — PDF may use visual columns without real table structure.</div>';
    }
    for (const t of pg.tables) {
      const col = t.column_detection;
      html += '<div style="margin-bottom:10px">';
      html += '<div style="font-size:11px;color:#64748b;margin-bottom:4px">Table ' + (t.table_index+1)
        + ' — ' + t.row_count + ' rows × ' + t.col_count + ' cols</div>';
      html += '<div style="margin-bottom:4px">';
      const colNames = ['name','last','first','dob','provider','date'];
      for (const k of colNames) {
        const v = col[k];
        html += '<span class="tag ' + (v != null ? 'found' : 'miss') + '">'
          + k + (v != null ? '=col'+v : '=?') + '</span>';
      }
      html += '</div>';
      if (t.header.length) {
        html += '<table><tr>';
        t.header.forEach((h,i) => { html += '<th>' + esc(h) + '<br><span style="font-weight:400;color:#64748b">col '+i+'</span></th>'; });
        html += '</tr>';
        for (const row of t.sample_rows) {
          html += '<tr>' + row.map(c => '<td>' + esc(c) + '</td>').join('') + '</tr>';
        }
        html += '</table>';
      }
      html += '</div>';
    }
    html += '</div>';

    // Raw text
    html += '<div class="section"><h3>Raw Text</h3>';
    html += '<div class="raw-text">' + esc(pg.raw_text || '(empty)') + '</div></div>';

    // Text-line parse results (pdfplumber text)
    if (!pg.is_image_page) {
      html += '<div class="section"><h3>Line-by-line Parse Results (first 80 lines)</h3>';
      html += '<table><tr><th>#</th><th>Line</th><th>Parsed patient?</th></tr>';
      pg.text_lines.forEach((l, i) => {
        const cls = l.parsed ? 'match' : 'no-match';
        const parsed = l.parsed ? esc(l.parsed.name) + ' &nbsp; DOB: ' + esc(l.parsed.dob) : '—';
        html += '<tr><td style="color:#475569">' + (i+1) + '</td><td class="' + cls + '">' + esc(l.line) + '</td><td class="' + cls + '">' + parsed + '</td></tr>';
      });
      html += '</table></div>';
    }

    // OCR section (image PDF pages only)
    if (pg.is_image_page) {
      html += '<div class="section"><h3>OCR Results</h3>';
      if (pg.ocr_error) {
        html += '<div class="no-match" style="font-size:11px;padding:6px 0">' + esc(pg.ocr_error) + '</div>';
      } else if (pg.ocr_text) {
        html += '<div style="font-size:11px;color:#64748b;margin-bottom:6px">OCR raw text (' + pg.ocr_lines.length + ' lines):</div>';
        html += '<div class="raw-text">' + esc(pg.ocr_text) + '</div>';
        html += '<h3 style="margin-top:8px">OCR Line-by-line Parse (first 80 lines)</h3>';
        html += '<table><tr><th>#</th><th>Line</th><th>Parsed patient?</th></tr>';
        pg.ocr_lines.forEach((l, i) => {
          const cls = l.parsed ? 'match' : 'no-match';
          const parsed = l.parsed ? esc(l.parsed.name) + ' &nbsp; DOB: ' + esc(l.parsed.dob) : '—';
          html += '<tr><td style="color:#475569">' + (i+1) + '</td><td class="' + cls + '">' + esc(l.line) + '</td><td class="' + cls + '">' + parsed + '</td></tr>';
        });
        html += '</table>';
      } else {
        html += '<div class="no-match" style="font-size:11px">OCR returned no text. Make sure <code>pip install pymupdf</code> is done and the server has been restarted.</div>';
      }
      html += '</div>';
    }

    html += '</div>'; // card
  }
  out.innerHTML = html;
}
</script>
</body>
</html>""", headers={"Cache-Control": "no-store"})


@app.delete("/api/clear")
def clear_all():
    """Clear all cached data."""
    import shutil
    if IMAGES_DIR.exists():
        shutil.rmtree(IMAGES_DIR)
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    save_index({"patients": {}, "updated": None})
    return {"status": "cleared"}


# ── Viewer ──

@app.get("/viewer", response_class=HTMLResponse)
def viewer():
    """Serve the iPad-friendly swipe viewer."""
    viewer_path = Path(__file__).parent.parent / "viewer" / "index.html"
    if viewer_path.exists():
        return HTMLResponse(viewer_path.read_text(encoding='utf-8'))
    return HTMLResponse("<h1>Viewer not found</h1>")


# ── Helpers ──

def sanitize_filename(name: str) -> str:
    """Make a string safe for use as a filename/directory name."""
    name = re.sub(r'[^\w\s\-.]', '', name)
    name = re.sub(r'\s+', '_', name)
    return name[:100]


# ── Run ──

if __name__ == "__main__":
    print("\n  🏥 PACS Preloader Server")
    print("  ────────────────────────")
    print("  Viewer:  http://localhost:8888/viewer")
    print("  API:     http://localhost:8888/api/health")
    print("  Data:    ./pacs_data/")
    print("  Deps:    pip install pdfplumber  (for PDF schedule upload)")
    print()
    uvicorn.run(app, host="0.0.0.0", port=8888)
