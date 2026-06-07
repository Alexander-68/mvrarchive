# MVRarchive — Implementation Plan

A web port of the Android **MVR Archive** screen, delivered as a pure static web
app hosted by **OmniGate**. The app browses recorded imaging *Studies* (folders
in the MVR Archive standard) on a NAS/local storage, reachable only through
OmniGate's user-level file API.

> **Status (2026-06-08): Phase 1 complete and deployed** on
> `http://127.0.0.1:9090/` — browse, search, and view (images, video, PDF) all
> work against sample data. See `HOW_IT_SHOULD_WORK.md` for the agreed UX details.
> Next milestone: Phase 2 (edit / copy / delete). Real archive data pending.

---

## 1. Constraints & platform model

**Pure static web code.** No server-side code of our own. Bundle is a directory
of HTML/CSS/JS with `index.html` at the root. Deploy = copy the web files into
`C:\Alex\omnigate\data\apps\mvrarchive`; OmniGate serves them live from disk
(`http.FileServer`), gated behind a per-app login on port **9090**.

**All file access is same-origin through OmniGate**, user-role only. The API
surface available to the app:

| Method | Path | Use in MVRarchive |
|--------|------|-------------------|
| `GET` | `/api/roots` | Discover allowed storage roots (Internal / USB / Network) |
| `GET` | `/api/files?path=` | List a directory → Study folders, Study contents |
| `GET` | `/api/files/read?path=` | Read/stream files — **correct Content-Type, honours HTTP `Range`** |
| `GET` | `/api/files/thumbnail?path=&w=` | JPEG thumbnail of an **image** (`w` default 320) |
| `PUT` | `/api/files/write?path=` | Save edited Study info, annotations, reports |
| `POST` | `/api/files/mkdir?path=` | Create folders (copy/export targets) |
| `DELETE` | `/api/files/delete?path=` | Delete a Study or file (recursive) |
| `POST` | `/__logout` | End session |

OmniGate is also our project (`C:\Alex\omnigate`, Go), so endpoints can be
added/extended when justified — propose them, implement in a separate session.

**Implications / things to design around:**
- `read` streams with `Range` and the right content-type, so `<img>`/`<video>`/
  `<iframe>` can point **directly** at the read URL — video streams and seeks
  natively, PDFs render. No blob fetching needed. *(Resolves former Q1.)*
- **Thumbnails** are server-side for images. **Video** posters are not (the
  endpoint is images-only); they're captured in-browser (hidden `<video>` seeks
  ~1 s in, drawn to `<canvas>`). A server-side video thumbnail is a possible
  future OmniGate addition.
- No DICOM toolkit or PACS networking server-side; anything the Android app did
  with native libs must be done in-browser (Canvas/WASM) or deferred.
- No partial writes — `write` rewrites a whole file.
- The jail rejects any path outside an `--allow-dir` root; all paths must be
  built from a root returned by `/api/roots`.

---

## 2. On-disk data model (MVR Archive standard)

Source of truth from the Android code (`study/Study.kt`, `study/StudyInfo.kt`,
`storage/StorageDevice.kt`).

**Study folder naming** (either form is recognized as a Study):
- Timestamp: `yyyyMMdd_HHmmss_<StudyID>_<Serial>` — e.g. `20240315_143052_P001_MV2024`
- Legacy: `CASE####` — e.g. `CASE0001`

**Folder contents:**
```
20240315_143052_P001_MV2024/
├── study_info.yaml      # primary metadata (YAML)
├── patient_info.json    # legacy mirror of metadata (JSON) — read as fallback
├── I0001.jpg            # images: prefix I (J = parallel/second stream)
├── I0003.dcm            # DICOM-wrapped image
├── V0001.mp4            # videos: prefix V (W = parallel stream); .mp4 or .dcm
├── R0001.pdf            # generated reports: prefix R
```
Media are sequence-numbered, 4-digit zero-padded per prefix (`I0001`, `V0002`).

**`study_info.yaml` fields** (YAML keys, all-but-a-few nullable). Grouped:
- Core: `Type` (HUMAN|VETERINARY), `StudyID`, `Notes`, `StudyDate` (epoch ms), `Creator`
- Human: `PatientFirstName/MiddleName/LastName`, `PatientGender`,
  `PatientBirthYear/Month/Day`
- Veterinary: `AnimalName`, `SpeciesDescription`, `BreedCode`,
  `ResponsiblePerson`, `ResponsiblePersonRole`
- DICOM/clinical (subset shown): `AccessionNumber`, `InstitutionName`,
  `ReferringPhysician`, `PerformingPhysician`, `ScheduledModality`,
  `StudyInstanceUID`, `AnatomicRegion {display, code}`, … (~50 keys total)

> The app **reads** the whole map, **displays** the well-known fields grouped
> Patient / Study / Clinical-DICOM (plus an "Additional" group for the rest), and
> must **round-trip unknown keys untouched** on save. When saving (Phase 2), write
> both `study_info.yaml` and `patient_info.json` to match the Android dual-write.

---

## 3. Visual design (port of the Android look)

Dark theme, bright-blue accent. Values lifted from `compose/LcColors.kt` /
`values/colors.xml`:

| Token | Hex | Role |
|-------|-----|------|
| accent | `#42a8d8` | primary interactive / focus cursor / active border |
| background | `#101010`–`#1a1a1a` | app & card background |
| surface | `#202020` / `#272727` | raised card / toolbar |
| line | `#404040` (grey25) | inactive border / divider |
| text | `#ffffff` | primary text |
| text-muted | `#b2b2b2` / `#c0c0c0` | secondary text, dates |
| success | `#3f8f42` | uploaded/export OK |
| error | `#c00000` | errors |
| checkmark | `#ffc107` | multi-select mark |
| focus / press | `#193f51` / `#21546c` | focus & press states |

- Corner radius **8px**, system font stack, high-contrast white-on-dark.
- **Study card:** thumbnail (first image, or video poster); below it the patient/
  animal name, date, counts (image/video/pdf) + total size, Study ID, DOB.
  **Nothing is drawn over the thumbnail** (no type pill / badge).
- Icons are simple inline SVGs in `assets/icons/` (`ic_study`, `ic_image`,
  `ic_video`, `ic_pdf`, `ic_search`, `ic_id`, `ic_birthday`).
- The Android UI is a 3D horizontal carousel; the web port uses a responsive
  **grid of cards** (better for PC browsing + scroll + search, the blueprint's
  core interaction).

---

## 4. Architecture of the web app (as built)

Dependency-light, **no build step** (keeps "copy to deploy" trivial), **no
external libraries**, **no CDN**:

```
mvrarchive/
├── index.html                 # shell: topbar, archive grid, detail, viewer overlay
├── styles.css                 # theme tokens + components
├── assets/icons/*.svg         # inline line icons
└── js/                        # classic scripts, loaded in order; window.MVR namespace
    ├── yaml.js                # MVR.yaml — minimal parse/dump for study_info.yaml
    ├── path.js                # MVR.path — POSIX/Windows join/parent/sep/ext
    ├── api.js                 # MVR.api — file API wrapper + read/thumbnail URL helpers
    ├── study.js               # MVR.study — folder detection, media classify, hydrate,
    │                          #   search, display + field-group helpers
    └── ui.js                  # controller: archive grid, detail, viewer, navigation
```

- **Classic scripts, not ES modules.** Go's `http.FileServer` on Windows derives
  `.js` MIME from the registry, which can break `type="module"` loading. Each file
  attaches to a global `window.MVR`; load order in `index.html` sets dependencies.
- **YAML in-browser:** our own `MVR.yaml` (small, tailored to the schema), with
  `patient_info.json` as a robust parse fallback. Unknown keys preserved by
  serializing the full object.
- **Media loading:** thumbnails via `/api/files/thumbnail`; full-res via
  `/api/files/read` set **directly** as element `src` (same-origin, cookie auth)
  — no blobs, no object-URL lifecycle. Video posters captured via `<canvas>`.
- **Listing performance:** the grid paints immediately from the directory listing,
  then a bounded-concurrency pool (4 at a time) hydrates each card's
  `study_info.yaml`, counts, and thumbnail — mirroring the Android worker pool.

---

## 5. Feature roadmap

Functions confirmed from the Android Archive (`ArchiveFragment.kt`,
`CoreBaseFragment.kt`, `ReviewFragment.kt`, `ReportFragment.kt`).

### Phase 0 — done
- [x] Static app deployed to OmniGate on port 9090, behind login.
- [x] API reachability check.

### Phase 1 — Browse, search & view — **done**
- [x] Storage-root selector from `/api/roots`.
- [x] List Study folders (`CASE####` / timestamp naming), **sort newest-first**,
  progressive hydration.
- [x] Study cards: thumbnail (image or video poster), name, date, counts + size,
  Study ID, DOB. Nothing drawn over the thumbnail.
- [x] Incremental client-side **search** (folder, Study ID, patient name,
  accession, date).
- [x] **Navigation model** with a focus cursor: arrows move, Enter = in, Esc =
  out/back, Space = select; mouse (click, wheel), touch (tap, pinch, swipe). No
  on-screen help.
- [x] Study **detail**: media grid (compact `KIND, file` captions), wheel/pinch
  tile resize, info panel grouped Patient/Study/Clinical-DICOM (+Additional),
  and **‹ Prev / Next ›** study buttons scoped to the post-search visible set
  (or the selection when >1 is selected).
- [x] **Viewer**: images, video (streams + seeks), PDF. Wheel/pinch zoom toward
  cursor, drag/touch pan, swipe + arrows to change file. Zoom/pan **persist**
  across image switches; **instant** image swap (no blank, no fade).

### Phase 2 — Study management — **next**
- **Edit Study info** form (well-known fields) → dual-write `study_info.yaml` +
  `patient_info.json`, preserving unknown keys (read-before-write guard).
- **Copy Study** to another root (`mkdir` + per-file read→write copy, with
  progress). Timestamp-suffix on name collision.
- **Delete** Study / file (confirm dialog with counts) via `DELETE`.
- Bulk actions over the current multi-select.

### Phase 3 — Authoring (heavier, in-browser)
- **Image annotation** (line/rect/circle/arrow + notes) on Canvas; save annotated
  copy and/or sidecar notes via `PUT`.
- **Report builder**: pick images, choose layout/paper, render PDF in-browser
  (`jspdf` or `pdf-lib`, vendored) → write `R####.pdf` into the Study folder.

### Phase 4 — Stretch / platform-limited (needs decisions)
- **Send to PACS (DICOM C-STORE):** not possible from a sandboxed browser with a
  file API only. Options: drop / "export to a watched NAS folder" handled by an
  OmniGate-side service / a new OmniGate endpoint. **(Q2.)**
- **Video trim/stitch:** feasible only via WebCodecs/ffmpeg.wasm (large, slow);
  likely defer. **(Q3.)**
- **DICOM (`.dcm`) rendering:** needs an in-browser DICOM parser (e.g.
  `cornerstone`/`dicom-parser`). Currently `.dcm` is listed but shown as "not
  viewable yet". **(Q4.)**

---

## 6. Risks & open questions

- **Q1 — Range requests:** ✅ resolved — `read` streams and honours `Range`.
- **Q2 — PACS:** Is "Send to PACS" in scope, and via which mechanism (drop / NAS
  hand-off / new endpoint)?
- **Q3 — Video editing:** Is trim/stitch required, or is playback enough?
- **Q4 — DICOM:** How common are `.dcm` files in target archives? Drives whether a
  WASM DICOM decoder is worth bundling.
- **Export status badge:** the Android card shows per-file PACS export status,
  which isn't exposed through the file API — badge deferred unless a marker file
  or endpoint provides it.
- **Write atomicity:** `write` rewrites whole files with no locking; concurrent
  edits from the device + web app could clobber. Mitigate with read-before-write
  and a visible "last modified" check.
- **Large directories:** archives can hold thousands of Studies; progressive
  hydration is in; add virtualized scrolling for the grid if needed.
- **No file-watch/push:** the app polls/refreshes to see new Studies (manual
  Refresh today; optional interval poll later).

---

## 7. Immediate next steps

1. Get **real archive Studies** into an `--allow-dir` root and sanity-check
   Phase 1 against them (esp. video streaming/seek and DICOM prevalence → Q4).
2. Start **Phase 2**: Edit Study info (form + dual-write, preserving unknown
   keys), then Copy, then Delete, then bulk actions.
3. Decide Q2 (PACS) and Q3 (video editing) scope.
4. Consider proposing a **server-side video thumbnail** endpoint to OmniGate to
   replace client-side frame capture.
