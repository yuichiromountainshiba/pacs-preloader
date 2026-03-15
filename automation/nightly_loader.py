"""
Nightly Schedule Loader
=======================
Runs via Windows Task Scheduler each evening.  Captures tomorrow's clinic
schedule from Epic Hyperspace (screenshot + OCR) and imports the patients
into the PACS Preloader server.

Primary method:  Epic screen capture (epic_capture.py)
Fallback:        PDF files dropped into  schedule_inbox/
Future:          CSV export from IT (see BRIEFING.md)

The next morning the Chrome extension's auto-refresh will preload X-rays
1-6 minutes before each patient's appointment time.

Usage:
    python nightly_loader.py                    # Epic capture for next weekday
    python nightly_loader.py --date 2026-03-16  # specific date
    python nightly_loader.py --pdf-only         # skip Epic, use inbox PDFs only
    python nightly_loader.py --dry-run          # parse only, don't import

Setup:
    1. Store credentials:       python epic_capture.py --setup-credentials
    2. Record Epic templates:   python epic_capture.py --record
    3. Schedule via Task Scheduler:  install_task.bat
"""

import argparse
import json
import logging
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

import requests

# ── Paths ──
SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent
INBOX_DIR = SCRIPT_DIR / "schedule_inbox"
ARCHIVE_DIR = SCRIPT_DIR / "schedule_archive"
LOG_DIR = SCRIPT_DIR / "logs"
SERVER_SCRIPT = PROJECT_DIR / "backend" / "server.py"
INDEX_PATH = PROJECT_DIR / "pacs_data" / "index.json"

SERVER_URL = os.environ.get("PACS_SERVER", "http://localhost:8888")
SERVER_STARTUP_TIMEOUT = 15  # seconds to wait for server to come up

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("nightly_loader")


# ─────────────────────────────────────────────
#  Server management
# ─────────────────────────────────────────────

def server_is_running():
    try:
        return requests.get(f"{SERVER_URL}/api/health", timeout=3).ok
    except Exception:
        return False


def start_server():
    """Start server.py as a background process. Returns the Popen object."""
    log.info(f"Starting server: {SERVER_SCRIPT}")
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    server_log = open(LOG_DIR / f"server_{datetime.now().strftime('%Y%m%d')}.log", "a")
    proc = subprocess.Popen(
        [sys.executable, str(SERVER_SCRIPT)],
        cwd=str(PROJECT_DIR),
        stdout=server_log,
        stderr=subprocess.STDOUT,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
    )
    for i in range(SERVER_STARTUP_TIMEOUT * 2):
        time.sleep(0.5)
        if proc.poll() is not None:
            log.error(f"Server process exited with code {proc.returncode}")
            log.error(f"Check {LOG_DIR / 'server_*.log'} for details")
            return None
        if server_is_running():
            log.info(f"Server is up (took {(i+1)*0.5:.0f}s)")
            return proc
    log.error(f"Server not responding after {SERVER_STARTUP_TIMEOUT}s")
    log.error(f"Check {LOG_DIR / 'server_*.log'} for details")
    proc.kill()
    return None


def stop_server(proc):
    if proc and proc.poll() is None:
        log.info("Stopping server")
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def _kill_server():
    """Kill any background server.py process listening on port 8888."""
    if not server_is_running():
        print("Server is not running.")
        return
    # Find the PID using the port
    try:
        result = subprocess.run(
            ["netstat", "-ano"], capture_output=True, text=True
        )
        for line in result.stdout.splitlines():
            if ":8888" in line and "LISTENING" in line:
                pid = line.strip().split()[-1]
                subprocess.run(["taskkill", "/F", "/PID", pid])
                print(f"Stopped server (PID {pid})")
                return
    except Exception as e:
        print(f"Error finding server process: {e}")
    print("Could not find server process — try: taskkill /F /IM python.exe")


# ─────────────────────────────────────────────
#  Epic capture
# ─────────────────────────────────────────────

def run_epic_capture(target_date, dry_run=False):
    """Run epic_capture.py to screenshot Epic and OCR the schedule.
    Epic will be launched and logged into automatically if not already running.
    Returns the list of parsed patients, or None on failure."""
    try:
        from epic_capture import capture_schedule
    except ImportError:
        sys.path.insert(0, str(SCRIPT_DIR))
        from epic_capture import capture_schedule

    log.info(f"Capturing schedule for {target_date.strftime('%Y-%m-%d')} (will launch Epic if needed)")
    patients = capture_schedule(target_date, dry_run=dry_run)
    return patients


# ─────────────────────────────────────────────
#  PDF fallback
# ─────────────────────────────────────────────

def find_pdfs():
    INBOX_DIR.mkdir(parents=True, exist_ok=True)
    return sorted(INBOX_DIR.glob("*.pdf"))


def parse_pdf_via_server(pdf_path):
    log.info(f"Parsing PDF: {pdf_path.name}")
    with open(pdf_path, "rb") as f:
        resp = requests.post(
            f"{SERVER_URL}/api/parse-pdf",
            files={"file": (pdf_path.name, f, "application/pdf")},
            timeout=60,
        )
    resp.raise_for_status()
    data = resp.json()
    log.info(f"  Found {data.get('count', 0)} patient(s)")
    return data.get("patients", [])


def archive_pdf(pdf_path):
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = ARCHIVE_DIR / f"{timestamp}_{pdf_path.name}"
    shutil.move(str(pdf_path), str(dest))
    log.info(f"  Archived -> {dest.name}")


# ─────────────────────────────────────────────
#  Import to server
# ─────────────────────────────────────────────

def import_patients(patients, clinic_date):
    """Push patients to server via API."""
    resp = requests.post(
        f"{SERVER_URL}/api/schedule/import",
        json={"patients": patients, "clinic_date": clinic_date, "source": "nightly_loader"},
        timeout=10,
    )
    resp.raise_for_status()
    data = resp.json()
    log.info(f"  Imported {data.get('registered', 0)} patient(s) for {clinic_date}")
    return data


def import_patients_direct(patients, clinic_date):
    """Write patients directly to index.json (fallback when server can't start)."""
    import re

    def sanitize(s):
        return re.sub(r'[^\w\s\-.]', '', s).replace(' ', '_')[:100]

    INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
    if INDEX_PATH.exists():
        index = json.loads(INDEX_PATH.read_text())
    else:
        index = {"patients": {}, "pending_refreshes": {}, "updated": None}
    index.setdefault("pending_refreshes", {})

    registered = 0
    for p in patients:
        name = p.get("name", "").strip()
        dob = p.get("dob", "").strip()
        if not name or not dob:
            continue
        key = sanitize(f"{name}_{dob}")
        clinic_time = p.get("time", "")
        provider = p.get("provider", "")
        pt_clinic_date = p.get("clinic_date") or clinic_date
        if key not in index["patients"]:
            index["patients"][key] = {
                "name": name, "dob": dob, "clinic_date": pt_clinic_date,
                "clinic_time": clinic_time, "provider": provider,
                "studies": {}, "image_count": 0,
                "created_at": datetime.now().isoformat(),
            }
        else:
            pt = index["patients"][key]
            if pt_clinic_date:
                pt["clinic_date"] = pt_clinic_date
            if clinic_time:
                pt["clinic_time"] = clinic_time
            if provider and not pt.get("provider"):
                pt["provider"] = provider
        registered += 1

    index["updated"] = datetime.now().isoformat()
    INDEX_PATH.write_text(json.dumps(index, indent=2))
    log.info(f"  Wrote {registered} patient(s) directly to index.json for {clinic_date}")
    return registered


# ─────────────────────────────────────────────
#  Main
# ─────────────────────────────────────────────

def next_weekday(from_date):
    d = from_date + timedelta(days=1)
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d


def main():
    parser = argparse.ArgumentParser(description="Nightly schedule loader for PACS Preloader")
    parser.add_argument("--date", default=None,
                        help="Clinic date (YYYY-MM-DD). Default: next weekday.")
    parser.add_argument("--pdf-only", action="store_true",
                        help="Skip Epic capture, only process PDFs from inbox")
    parser.add_argument("--dry-run", action="store_true",
                        help="Parse only, don't import or archive")
    parser.add_argument("--stop-server", action="store_true",
                        help="Stop the background PACS server and exit")
    parser.add_argument("--setup-email", action="store_true",
                        help="Store Gmail credentials for summary emails")
    parser.add_argument("--send-email", action="store_true",
                        help="Send the most recent summary email now")
    parser.add_argument("--server", default=None,
                        help="PACS server URL (default: $PACS_SERVER or localhost:8888)")
    args = parser.parse_args()

    global SERVER_URL
    if args.server:
        SERVER_URL = args.server.rstrip("/")

    if args.stop_server:
        _kill_server()
        return

    if args.setup_email:
        setup_email()
        return

    if args.send_email:
        send_summary_email()
        return

    # File logging
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    fh = logging.FileHandler(LOG_DIR / f"nightly_{datetime.now().strftime('%Y%m%d')}.log")
    fh.setFormatter(logging.Formatter("%(asctime)s  %(levelname)s  %(message)s", datefmt="%H:%M:%S"))
    log.addHandler(fh)

    # Target date
    if args.date:
        target_date = datetime.strptime(args.date, "%Y-%m-%d")
    else:
        target_date = next_weekday(datetime.now())
    clinic_date = target_date.strftime("%Y-%m-%d")
    log.info(f"=== Nightly Loader — clinic date: {clinic_date} ===")

    # ── Start server (needed for OCR, import, and extension preloading) ──
    # Server is left running after this script exits so the Chrome extension
    # can preload X-rays overnight. Next night's run will reuse it.
    if not server_is_running():
        server_proc = start_server()
        if not server_proc:
            log.warning("Could not start server — will use local OCR and direct import")
    else:
        log.info("Server already running")

    all_patients = []

    # ── Method 1: Epic screen capture + OCR ──
    if not args.pdf_only:
        epic_patients = run_epic_capture(target_date, dry_run=args.dry_run)
        if epic_patients:
            all_patients.extend(epic_patients)
            log.info(f"Epic capture: {len(epic_patients)} patient(s)")
        else:
            log.info("Epic capture returned no patients — will try PDF fallback")

    # ── Method 2: PDF inbox fallback ──
    if not all_patients:
        pdfs = find_pdfs()
        if pdfs:
            log.info(f"Found {len(pdfs)} PDF(s) in inbox — processing as fallback")
            for pdf_path in pdfs:
                if server_is_running():
                    patients = parse_pdf_via_server(pdf_path)
                else:
                    log.error("Server not available for PDF parsing — skipping")
                    continue
                all_patients.extend(patients)
                if not args.dry_run:
                    archive_pdf(pdf_path)
        else:
            log.info(f"No PDFs in {INBOX_DIR} either")

    # ── Import ──
    if not all_patients:
        log.info("No patients found from any source. Nothing to import.")
        return

    if args.dry_run:
        log.info(f"[dry-run] Would import {len(all_patients)} patient(s) for {clinic_date}")
        for p in all_patients:
            t = p.get("time", "")
            prov = p.get("provider", "")
            log.info(f"  {t:>8s}  {p['name']:<30s}  {p['dob']}  {prov}")
        return

    # Import patients (Epic capture may have already imported via its own flow,
    # but calling again is safe — it updates existing records)
    if server_is_running():
        import_patients(all_patients, clinic_date)
    else:
        log.info("Server not running — writing directly to index.json")
        import_patients_direct(all_patients, clinic_date)

    log.info(f"=== Done: {len(all_patients)} patient(s) loaded for {clinic_date} ===")

    # ── Write summary report ──
    write_summary(clinic_date, all_patients, dry_run=args.dry_run)


# ─────────────────────────────────────────────
#  Summary report
# ─────────────────────────────────────────────

def write_summary(clinic_date, patients, dry_run=False):
    """Write a human-readable summary to logs/summary_YYYYMMDD.txt."""
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    date_stamp = datetime.now().strftime("%Y%m%d")
    summary_path = LOG_DIR / f"summary_{date_stamp}.txt"

    # Collect errors from the day's log file
    errors = []
    log_file = LOG_DIR / f"nightly_{date_stamp}.log"
    if log_file.exists():
        for line in log_file.read_text(encoding="utf-8", errors="replace").splitlines():
            if "ERROR" in line:
                errors.append(line.strip())

    providers = set()
    for p in patients:
        prov = p.get("provider", "").strip()
        if prov:
            providers.add(prov)

    lines = []
    lines.append(f"PACS Preloader - Nightly Summary")
    lines.append(f"{'=' * 40}")
    lines.append(f"Run date:     {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    lines.append(f"Clinic date:  {clinic_date}")
    lines.append(f"Mode:         {'DRY RUN' if dry_run else 'LIVE'}")
    lines.append(f"")
    lines.append(f"Patients loaded:  {len(patients)}")
    lines.append(f"Providers:        {', '.join(sorted(providers)) if providers else 'none'}")
    lines.append(f"")

    if patients:
        lines.append(f"{'Time':>8s}  {'Patient':<10s}  Provider")
        lines.append(f"{'-'*8}  {'-'*10}  {'-'*20}")
        for p in patients:
            t = p.get("time", "")
            prov = p.get("provider", "")
            # HIPAA: use initials only — no full name or DOB in email
            name = p.get("name", "")
            initials = "".join(w[0].upper() for w in name.split() if w) if name else "?"
            lines.append(f"{t:>8s}  {initials:<10s}  {prov}")
        lines.append(f"")

    if errors:
        lines.append(f"ERRORS ({len(errors)}):")
        lines.append(f"{'-' * 40}")
        for e in errors:
            lines.append(f"  {e}")
    else:
        lines.append(f"No errors.")

    lines.append(f"")
    lines.append(f"Server running: {'yes' if server_is_running() else 'no'}")

    summary_text = "\n".join(lines)
    summary_path.write_text(summary_text, encoding="utf-8")
    log.info(f"Summary written to {summary_path}")
    return summary_path


# ─────────────────────────────────────────────
#  Email summary
# ─────────────────────────────────────────────

def send_summary_email():
    """Email today's summary report via Gmail SMTP.

    Credentials stored in Windows Credential Manager:
      service: pacs-preloader-email
      __username__: your gmail address
      password: Gmail app password (not your regular password)

    Setup:
      python nightly_loader.py --setup-email
    """
    import smtplib
    from email.mime.text import MIMEText

    import keyring

    service = "pacs-preloader-email"
    sender = keyring.get_password(service, "__username__")
    if not sender:
        log.error(f"No email credentials in keyring service '{service}'. Run --setup-email first.")
        return False
    app_password = keyring.get_password(service, sender)
    recipient = keyring.get_password(service, "__recipient__") or sender

    # Find today's summary
    date_stamp = datetime.now().strftime("%Y%m%d")
    summary_path = LOG_DIR / f"summary_{date_stamp}.txt"
    if not summary_path.exists():
        # Try yesterday (the nightly run was last night)
        yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y%m%d")
        summary_path = LOG_DIR / f"summary_{yesterday}.txt"
    if not summary_path.exists():
        log.error(f"No summary file found for today or yesterday")
        return False

    body = summary_path.read_text(encoding="utf-8")

    # Check for errors to flag in subject
    has_errors = "ERRORS (" in body
    subject = f"PACS Preloader - {'ERRORS - ' if has_errors else ''}Nightly Summary"

    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = recipient

    try:
        with smtplib.SMTP("smtp.gmail.com", 587) as server:
            server.starttls()
            server.login(sender, app_password)
            server.send_message(msg)
        log.info(f"Summary emailed to {recipient}")
        return True
    except Exception as e:
        log.error(f"Failed to send email: {e}")
        return False


def setup_email():
    """Prompt for Gmail credentials and store in Windows Credential Manager."""
    import getpass
    import keyring

    service = "pacs-preloader-email"
    print("\n=== Email Setup (Gmail SMTP) ===")
    print("You need a Gmail App Password (not your regular password).")
    print("Generate one at: Google Account > Security > App passwords")
    print()

    sender = input("Gmail address (sender): ").strip()
    if not sender:
        print("Aborted.")
        return
    app_password = getpass.getpass("Gmail app password: ")
    if not app_password:
        print("Aborted.")
        return
    recipient = input(f"Send summary to (default: {sender}): ").strip() or sender

    keyring.set_password(service, "__username__", sender)
    keyring.set_password(service, sender, app_password)
    keyring.set_password(service, "__recipient__", recipient)
    print(f"\nCredentials stored. Summary emails will be sent to {recipient}")
    print("Test with: python nightly_loader.py --send-email")
    del app_password


if __name__ == "__main__":
    main()
