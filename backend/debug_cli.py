"""
Debug CLI for PACS Preloader — inspect patient data, audit trails, and debug logs.

Usage:
  python backend/debug_cli.py <patient_name_fragment>        # search patients
  python backend/debug_cli.py <patient_name_fragment> --audit # show audit trail
  python backend/debug_cli.py <patient_name_fragment> --full  # show everything
  python backend/debug_cli.py --log [--patient NAME] [--date YYYY-MM-DD] [--tail N]
  python backend/debug_cli.py --patients                      # list all patients
"""

import argparse
import json
import sys
from pathlib import Path
from datetime import datetime

DATA_DIR = Path(__file__).parent / "pacs_data"
INDEX_FILE = DATA_DIR / "index.json"
DEBUG_LOG_FILE = DATA_DIR / "debug.log"


def load_index():
    if not INDEX_FILE.exists():
        print(f"No index file found at {INDEX_FILE}")
        sys.exit(1)
    with open(INDEX_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def find_patients(index, query):
    """Find patients whose key or name matches the query (case-insensitive)."""
    q = query.lower()
    matches = []
    for key, data in index.get("patients", {}).items():
        if q in key.lower() or q in data.get("name", "").lower():
            matches.append((key, data))
    return matches


def print_patient_summary(key, data):
    """Print a one-line summary of a patient."""
    name = data.get("name", "?")
    dob = data.get("dob", "?")
    date = data.get("clinic_date", "?")
    time = data.get("clinic_time", "")
    imgs = data.get("image_count", 0)
    studies = len(data.get("studies", {}))
    provider = data.get("provider", "")
    lr = data.get("last_refresh")
    lr_str = f" | last_refresh: {lr['at']} ({lr['status']})" if lr else ""
    print(f"  {name} (DOB: {dob}) | {date} {time} | {provider} | {studies} studies, {imgs} images{lr_str}")
    print(f"    key: {key}")


def print_patient_detail(key, data):
    """Print detailed patient info including studies."""
    print_patient_summary(key, data)
    print()
    studies = data.get("studies", {})
    if not studies:
        print("  No studies.")
    for sk, study in studies.items():
        desc = study.get("description", "?")
        mod = study.get("modality", "?")
        date = study.get("date", "?")
        loc = study.get("location", "")
        nimgs = len(study.get("images", []))
        print(f"    [{mod}] {desc} ({date}) — {nimgs} images")
        if loc:
            print(f"      location: {loc}")
        print(f"      study_key: {sk}")


def print_audit(key, data):
    """Print the preload audit trail for a patient."""
    log = data.get("preload_log", [])
    if not log:
        print(f"  No audit trail for {data.get('name', key)}")
        return
    print(f"  Audit trail for {data.get('name', key)} ({len(log)} entries):")
    print()
    for i, entry in enumerate(log):
        at = entry.get("at", "?")
        today_only = entry.get("todayOnly", "?")
        filters = entry.get("filters", {})
        found = entry.get("studies_found", "?")
        downloaded = entry.get("studies_downloaded", "?")
        total = entry.get("total_images", "?")
        print(f"  [{i+1}] {at}")
        print(f"      todayOnly={today_only}  filters={json.dumps(filters)}")
        print(f"      studies found: {found}  downloaded: {downloaded}  images: {total}")
        for sr in entry.get("study_results", []):
            err = sr.get("error")
            if err:
                print(f"        ✗ {sr.get('desc', '?')} [{sr.get('modality', '?')}] {sr.get('date', '?')} — ERROR: {err}")
            else:
                print(f"        ✓ {sr.get('desc', '?')} [{sr.get('modality', '?')}] {sr.get('date', '?')} — {sr.get('images', 0)} images from {sr.get('series', '?')} series")
        for sk in entry.get("skipped_studies", []):
            print(f"        ⚠ SKIPPED: {sk.get('desc', '?')} [{sk.get('modality', '?')}] {sk.get('date', '?')} — {sk.get('reason', '?')}")
        print()


def print_debug_log(patient=None, date=None, tail=50, category=None):
    """Print entries from the persistent debug log file."""
    if not DEBUG_LOG_FILE.exists():
        print("No persistent debug log found.")
        return
    events = []
    with open(DEBUG_LOG_FILE, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                evt = json.loads(line)
            except Exception:
                continue
            if patient:
                p = patient.lower()
                msg = (evt.get("message") or "").lower()
                details_str = json.dumps(evt.get("details", {})).lower()
                if p not in msg and p not in details_str:
                    continue
            if date and not (evt.get("_server_time") or "").startswith(date):
                continue
            if category and evt.get("category") != category:
                continue
            events.append(evt)

    events = events[-tail:]
    if not events:
        print("No matching debug log entries.")
        return
    print(f"  Showing {len(events)} debug log entries:")
    print()
    for evt in events:
        ts = evt.get("_server_time", evt.get("ts", "?"))
        src = evt.get("source", "?")
        lvl = evt.get("level", "?")
        cat = evt.get("category", "?")
        msg = evt.get("message", "")
        details = evt.get("details", {})
        icon = {"pass": "✓", "error": "✗", "warn": "⚠", "start": "→", "info": "·"}.get(lvl, "·")
        print(f"  {icon} [{ts}] {src}/{cat} — {msg}")
        if details:
            for k, v in details.items():
                if k.startswith("_"):
                    continue
                val = json.dumps(v) if isinstance(v, (dict, list)) else str(v)
                if len(val) > 120:
                    val = val[:120] + "..."
                print(f"      {k}: {val}")
        print()


def main():
    parser = argparse.ArgumentParser(description="PACS Preloader Debug CLI")
    parser.add_argument("query", nargs="?", default="", help="Patient name fragment to search for")
    parser.add_argument("--audit", action="store_true", help="Show preload audit trail")
    parser.add_argument("--full", action="store_true", help="Show everything (detail + audit + debug log)")
    parser.add_argument("--log", action="store_true", help="Show persistent debug log")
    parser.add_argument("--patients", action="store_true", help="List all patients")
    parser.add_argument("--patient", default="", help="Filter debug log by patient name")
    parser.add_argument("--date", default="", help="Filter debug log by date (YYYY-MM-DD)")
    parser.add_argument("--category", default="", help="Filter debug log by category")
    parser.add_argument("--tail", type=int, default=50, help="Number of log entries to show (default: 50)")
    args = parser.parse_args()

    if args.log:
        patient_filter = args.patient or args.query or None
        print_debug_log(patient=patient_filter, date=args.date, tail=args.tail, category=args.category)
        return

    index = load_index()

    if args.patients:
        patients = index.get("patients", {})
        print(f"\n  {len(patients)} patients in index:\n")
        for key, data in sorted(patients.items(), key=lambda x: x[1].get("clinic_date", ""), reverse=True):
            print_patient_summary(key, data)
        return

    if not args.query:
        parser.print_help()
        return

    matches = find_patients(index, args.query)
    if not matches:
        print(f"\n  No patients matching '{args.query}'")
        # Check debug log for any mentions
        print(f"\n  Checking debug log for '{args.query}'...")
        print_debug_log(patient=args.query, tail=args.tail)
        return

    print(f"\n  Found {len(matches)} patient(s) matching '{args.query}':\n")
    for key, data in matches:
        if args.full:
            print_patient_detail(key, data)
            print()
            print_audit(key, data)
            print("  --- Debug log entries ---")
            print_debug_log(patient=args.query, tail=args.tail)
        elif args.audit:
            print_patient_summary(key, data)
            print()
            print_audit(key, data)
        else:
            print_patient_detail(key, data)
        print()


if __name__ == "__main__":
    main()
