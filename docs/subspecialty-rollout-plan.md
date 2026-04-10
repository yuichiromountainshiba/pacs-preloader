# PACS Preloader — Subspecialty Rollout Plan

## Overview

Roll out the PACS image preloader/viewer to four additional orthopaedic subspecialties:
**Hand/Upper Extremity**, **Trauma**, **Sports**, and **Foot & Ankle**.

Currently deployed: **Spine** (port 8888), **Hip & Knee** (port 8889).

---

## 1. Architecture Decision: Separate Instances per Subspecialty

**Recommendation: Keep separate server instances + extensions per subspecialty.**

Rationale:

| Factor | Separate instances | Single monolith |
|---|---|---|
| **Parallel use** | Each subspecialty runs its own server process and Chrome extension. Refreshes, preloads, and image serving never block each other. A spine refresh can't starve a trauma refresh for CPU/IO. | One process handles all traffic — a large MRI download for one subspecialty blocks the event loop for others. |
| **Isolation** | A crash or bad data in one subspecialty doesn't take down others. Each has its own `pacs_data/` directory, its own `index.json`, its own log files. | Shared state means a corrupt index or OOM affects everyone. |
| **Independent deployment** | Can update, restart, or debug one subspecialty without touching others. Roll out new features to hand first, confirm stable, then propagate. | Any change requires restarting the entire system. |
| **Simplicity** | Config is a single `config.js` file per instance — no routing layer, no subspecialty multiplexing, no shared-state bugs. The codebase is ~6K lines total; duplicating it is cheap. | Adds middleware complexity for routing requests to the right subspecialty context. |
| **Resource cost** | 6 Python processes each using ~30-50 MB RAM = ~300 MB total. Negligible on any modern machine or server. | Saves ~200 MB RAM. Not worth the complexity tradeoff. |

**The only real cost of separate instances is keeping them in sync when bugs are fixed in shared code (background.js, content.js, server.py, viewer).** Mitigation strategies are discussed in Section 6.

---

## 2. Instance Map

| Subspecialty | Port | Extension Name | Repo / Directory |
|---|---|---|---|
| Spine | 8888 | PACS Preloader — Spine | `pacs-preloader` |
| Hip & Knee | 8889 | PACS Preloader — Hip & Knee | `pacs-preloader-hipknee` |
| Hand | 8890 | PACS Preloader — Hand | `pacs-preloader-hand` |
| Trauma | 8891 | PACS Preloader — Trauma | `pacs-preloader-trauma` |
| Sports | 8892 | PACS Preloader — Sports | `pacs-preloader-sports` |
| Foot & Ankle | 8893 | PACS Preloader — Foot & Ankle | `pacs-preloader-footankle` |

Viewer URLs:
- `http://localhost:8890/viewer` (Hand)
- `http://localhost:8891/viewer` (Trauma)
- `http://localhost:8892/viewer` (Sports)
- `http://localhost:8893/viewer` (Foot & Ankle)

---

## 3. Subspecialty Configurations

### 3a. Hand / Upper Extremity

```js
const SUBSPECIALTY = {
  name: 'Hand',
  id:   'hand',
  defaultServerUrl: 'http://localhost:8890',

  // SEARCH filters — keywords that match PACS study descriptions to pull images
  regionKeywords: {
    hand:     ['finger', 'fingers', 'hand', 'thumb', 'metacarpal', 'phalanx', 'phalanges'],
    wrist:    ['wrist', 'forearm', 'radius', 'ulna', 'distal radius', 'scaphoid', 'carpal'],
    elbow:    ['elbow', 'olecranon', 'radial head', 'proximal forearm'],
    shoulder: ['shoulder', 'humerus', 'proximal humerus', 'rotator cuff', 'clavicle', 'scapula', 'ac joint'],
  },

  // VIEWER filter buttons — what the provider clicks to narrow the image list
  regionCheckboxes: [
    { id: 'filterHand',     label: 'Hand / Finger',       regions: ['hand'] },
    { id: 'filterWrist',    label: 'Wrist / Forearm',     regions: ['wrist'] },
    { id: 'filterElbow',    label: 'Elbow',               regions: ['elbow'] },
    { id: 'filterShoulder', label: 'Shoulder / Humerus',  regions: ['shoulder'] },
  ],

  hideModalityFilters: false,
};
```

### 3b. Trauma

```js
const SUBSPECIALTY = {
  name: 'Trauma',
  id:   'trauma',
  defaultServerUrl: 'http://localhost:8891',

  // SEARCH filters — pull ALL xrays (trauma sees everything)
  regionKeywords: {
    hand:     ['finger', 'fingers', 'hand', 'thumb', 'metacarpal', 'phalanx', 'phalanges'],
    wrist:    ['wrist', 'forearm', 'radius', 'ulna', 'distal radius', 'scaphoid', 'carpal'],
    elbow:    ['elbow', 'olecranon', 'radial head'],
    shoulder: ['shoulder', 'humerus', 'proximal humerus', 'clavicle', 'scapula'],
    ribs:     ['rib', 'ribs', 'chest', 'thorax'],
    pelvis:   ['pelvis', 'pelvic', 'acetabulum', 'acetabular', 'sacrum', 'sacroiliac', 'si joint'],
    hip:      ['hip', 'femur', 'femoral', 'intertrochanteric', 'subtrochanteric', 'neck of femur'],
    knee:     ['knee', 'patella', 'patellar', 'distal femur', 'proximal tibia'],
    tibia:    ['tibia', 'tibial', 'fibula', 'ankle', 'pilon', 'malleolus'],
    foot:     ['foot', 'toes', 'toe', 'metatarsal', 'calcaneus', 'hindfoot', 'midfoot'],
  },

  regionCheckboxes: [
    { id: 'filterHand',     label: 'Hand / Finger',       regions: ['hand'] },
    { id: 'filterWrist',    label: 'Wrist / Forearm',     regions: ['wrist'] },
    { id: 'filterElbow',    label: 'Elbow',               regions: ['elbow'] },
    { id: 'filterShoulder', label: 'Shoulder / Humerus',  regions: ['shoulder'] },
    { id: 'filterRibs',     label: 'Ribs',                regions: ['ribs'] },
    { id: 'filterPelvis',   label: 'Pelvis',              regions: ['pelvis'] },
    { id: 'filterHip',      label: 'Hip / Femur',         regions: ['hip'] },
    { id: 'filterKnee',     label: 'Knee',                regions: ['knee'] },
    { id: 'filterTibia',    label: 'Tibia / Ankle',       regions: ['tibia'] },
    { id: 'filterFoot',     label: 'Foot / Toes',         regions: ['foot'] },
  ],

  hideModalityFilters: false,
};
```

> **Note:** Trauma search pulls all XRs by default (no region filtering on search). The viewer filter buttons let the provider narrow down to the relevant body part once images are loaded.

### 3c. Sports

```js
const SUBSPECIALTY = {
  name: 'Sports',
  id:   'sports',
  defaultServerUrl: 'http://localhost:8892',

  regionKeywords: {
    knee:     ['knee', 'patella', 'patellar', 'acl', 'mcl', 'meniscus', 'distal femur', 'proximal tibia'],
    shoulder: ['shoulder', 'clavicle', 'ac joint', 'rotator cuff', 'labrum', 'humerus', 'scapula'],
    hip:      ['hip', 'labral', 'femoral head', 'acetabulum', 'cam', 'pincer'],
    elbow:    ['elbow', 'ucl', 'radial head', 'olecranon'],
    wrist:    ['wrist', 'scaphoid', 'tfcc'],
  },

  regionCheckboxes: [
    { id: 'filterKnee',     label: 'Knee',                 regions: ['knee'] },
    { id: 'filterShoulder', label: 'Shoulder / Clavicle',  regions: ['shoulder'] },
    { id: 'filterHip',      label: 'Hip',                  regions: ['hip'] },
  ],

  hideModalityFilters: false,
};
```

### 3d. Foot & Ankle

```js
const SUBSPECIALTY = {
  name: 'Foot & Ankle',
  id:   'footankle',
  defaultServerUrl: 'http://localhost:8893',

  regionKeywords: {
    foot:  ['foot', 'toes', 'toe', 'metatarsal', 'calcaneus', 'hindfoot', 'midfoot',
            'forefoot', 'hallux', 'bunion', 'lisfranc', 'tarsal', 'navicular', 'cuboid', 'cuneiform'],
    ankle: ['ankle', 'tibia', 'tibial', 'fibula', 'malleolus', 'pilon',
            'achilles', 'talar', 'talus', 'syndesmosis', 'mortise'],
  },

  regionCheckboxes: [
    { id: 'filterFoot',  label: 'Foot / Toes',     regions: ['foot'] },
    { id: 'filterAnkle', label: 'Tibia / Ankle',   regions: ['ankle'] },
  ],

  hideModalityFilters: false,
};
```

---

## 4. What Changes Per Instance

Only **3 files** differ between subspecialties. Everything else is identical:

| File | What changes |
|---|---|
| `extension/config.js` | Subspecialty name, id, port, region keywords, filter checkboxes |
| `extension/manifest.json` | Extension name, description, port in `host_permissions` |
| `backend/server.py` | Default `--port` argument (1 line) |

Total delta per subspecialty: ~50 lines of config.

---

## 5. Deployment Options

### Option A: Local workstation (current model)
- All 6 servers run on your machine
- All 6 Chrome extensions installed in your browser
- Morning launcher starts all servers
- **Pros:** Simple, no infrastructure, works offline
- **Cons:** Only works on your machine, other providers can't use it

### Option B: Shared server (recommended next step)
- Run all 6 backend servers on a single always-on Windows machine (or Linux VM) on the clinic network
- Replace `localhost` with the server's IP/hostname in each `config.js`
- Any machine on the network can open `http://server:8888/viewer`, etc.
- Chrome extensions on each provider's machine talk to the central server
- **Pros:** Multiple providers can view images simultaneously, data persists regardless of workstation state, servers run 24/7 (nightly loader always works)
- **Cons:** Requires a dedicated machine, network configuration, potential IT coordination

### Option C: Hybrid
- Run backends on a server (Option B)
- Keep Chrome extensions local per provider workstation
- Viewer is just a webpage — anyone with the URL can open it, no extension needed for viewing
- Extension is only needed for the person who triggers preloads

**Recommended path:** Start with Option A for buildout and testing, migrate to Option B once stable. The only change required is updating the server URL in `config.js` — no code changes.

---

## 6. Keeping Instances In Sync

The main risk of separate repos is code drift — a bug fixed in spine doesn't automatically get fixed in trauma.

### Strategy: Template repo + scripted propagation

1. Designate `pacs-preloader` (spine) as the **canonical source** for shared code
2. Create a deploy script that copies shared files to all subspecialty directories:

```
sync_shared.bat
  - Copies: background.js, content.js, popup.js, popup.html, server.py, viewer/index.html
  - Skips: config.js, manifest.json
  - Diffs before overwriting so you can review
```

3. After fixing a bug in spine, run `sync_shared.bat` to propagate to all others
4. Each subspecialty repo only ever has manual edits in `config.js` and `manifest.json`

Alternative (future): refactor into a monorepo with a build step that stamps out per-subspecialty bundles from a single source + config. More engineering upfront but eliminates drift entirely.

---

## 7. Automation Updates

### Morning launcher
Update `morning_launcher.py` SERVERS list to include all 6 backends:

```python
SERVERS = [
    {"name": "spine",     "url": "http://localhost:8888", ...},
    {"name": "hipknee",   "url": "http://localhost:8889", ...},
    {"name": "hand",      "url": "http://localhost:8890", ...},
    {"name": "trauma",    "url": "http://localhost:8891", ...},
    {"name": "sports",    "url": "http://localhost:8892", ...},
    {"name": "footankle", "url": "http://localhost:8893", ...},
]
```

### Nightly schedule loader
- Currently captures from Epic via `epic_capture.py`
- Future: accept a CSV file per subspecialty dropped into `schedule_inbox/`
- CSV format: `patient_name, dob, provider, clinic_date, clinic_time`
- Each CSV targets a specific subspecialty server via filename convention (e.g., `hand_2026-04-07.csv`)

### Task Scheduler
- `install_task.bat` already supports nightly + morning tasks
- Add per-subspecialty nightly import tasks as CSV feeds come online

---

## 8. Rollout Checklist (Per Subspecialty)

- [ ] Clone `pacs-preloader` to `pacs-preloader-{id}`
- [ ] Update `config.js` with subspecialty regions/filters (configs in Section 3)
- [ ] Update `manifest.json` name + port
- [ ] Update `server.py` default port
- [ ] Create `pacs_data/` directory for image storage
- [ ] Test: start server, install extension, run a manual preload for one patient
- [ ] Test: verify viewer filter buttons work correctly
- [ ] Test: verify MRI/CT series detection + crossline localizers
- [ ] Add to morning launcher
- [ ] Set up schedule import (when CSV feeds are ready)
- [ ] Brief the subspecialty providers on viewer URL + workflow

---

## 9. Open Questions / Future Decisions

| # | Question | When to decide |
|---|---|---|
| 1 | Provider list per subspecialty (for schedule filtering) | Before each subspecialty goes live |
| 2 | CSV schedule feed format + delivery mechanism | Before nightly automation |
| 3 | Server hosting: local vs shared machine | After 1-2 subspecialties are stable |
| 4 | Monorepo refactor vs sync script | After all 6 are deployed and pattern is proven |
| 5 | Per-provider viewer bookmarks vs a landing page with links to all viewers | When multiple providers start using it |
| 6 | Trauma: should search pull truly ALL xrays or still use region keywords? | During trauma testing with the trauma provider |
