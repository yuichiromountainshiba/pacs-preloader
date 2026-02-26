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
    return FileResponse(filepath, media_type="image/jpeg")


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
    print()
    uvicorn.run(app, host="0.0.0.0", port=8888)
