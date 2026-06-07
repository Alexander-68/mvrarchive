# MVRarchive — Implementation Plan

A web port of the Android **MVR Archive** screen, delivered as a pure static web
app hosted by **OmniGate**. The app browses recorded imaging *Studies* (folders
in the MVR Archive standard) on a NAS/local storage, reachable only through
OmniGate's user-level file API.

> Status: planning. The repository currently contains a deployed connectivity
> smoke-test (`index.html` / `app.js` / `styles.css`) confirming the OmniGate
> API is reachable on `http://127.0.0.1:9090/`.

---

## 1. Constraints & platform model

**Pure static web code.** No server-side code. Bundle is a directory of
HTML/CSS/JS with `index.html` at the root. Deploy = copy the web files into
`C:\Alex\omnigate\data\apps\mvrarchive`; OmniGate serves them live from disk
(`http.FileServer`), gated behind a per-app login on port **9090**.

**All file access is same-origin through OmniGate**, user-role only. The full
API surface available to the app:

| Method | Path | Use in MVRarchive |
|--------|------|-------------------|
| `GET` | `/api/roots` | Discover allowed storage roots (Internal / USB / Network) |
| `GET` | `/api/files?path=` | List a directory → Study folders, Study contents |
| `GET` | `/api/files/read?path=` | Read `study_info.yaml`, images, videos, PDFs |
| `PUT` | `/api/files/write?path=` | Save edited Study info, annotations, reports |
| `POST` | `/api/files/mkdir?path=` | Create folders (copy/export targets) |
| `DELETE` | `/api/files/delete?path=` | Delete a Study or file (recursive) |
| `POST` | `/__logout` | End session |

**Implications / hard limits to design around:**
- No server-side thumbnailing, transcoding, DICOM toolkit, or PACS networking.
  Anything the Android app did with native libraries must be done in-browser
  (Canvas/WebCodecs/WASM) or be dropped/deferred.
- `read` returns the **whole file**. Confirm whether it honors HTTP `Range`
  before relying on video seeking; if not, large-video playback needs a
  fallback (full download to a Blob URL). **(Open question Q1.)**
- No file API for partial writes — saves rewrite a whole file.
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

> The web app should **read** the whole map, **display** the well-known fields,
> and **round-trip unknown keys untouched** on save so it never loses data. When
> saving, write both `study_info.yaml` and `patient_info.json` to match the
> Android app's dual-write contract.

---

## 3. Visual design (port of the Android look)

Dark theme, bright-blue accent. Values lifted from `compose/LcColors.kt` /
`values/colors.xml`:

| Token | Hex | Role |
|-------|-----|------|
| accent | `#42a8d8` | primary interactive / borders on active |
| background | `#101010`–`#1a1a1a` | app & card background |
| surface | `#202020` / `#272727` | raised card / toolbar |
| line | `#404040` (grey25) | inactive border / divider |
| text | `#ffffff` | primary text |
| text-muted | `#b2b2b2` / `#c0c0c0` | secondary text, dates |
| success | `#3f8f42` | uploaded/export OK |
| error | `#c00000` | errors |
| checkmark | `#FFC107` | multi-select mark |
| focus / press | `#193f51` / `#21546c` | focus & press states |

- Corner radius **8dp**, card border **~6px**, system font stack, high-contrast
  white-on-dark.
- **Study card** contents (mirror Android `StudyItem`): study icon + title/date,
  thumbnail (first image, ~408×240), image-count + video-count + total size with
  `ic_image`/`ic_video` icons, patient name, DOB + Patient ID rows, and an
  export-status badge (scheduled / uploaded / error).
- Reuse the Android icon set where useful: `ic_study(_human/_veterinary)`,
  `ic_image`, `ic_video`, `ic_pdf`, `ic_search`, `ic_but_copy`, `ic_but_report`,
  `ic_delete`, `ic_birthday`, `ic_id`, `checkmark`. Export as PNG/SVG from
  `res/drawable*` into an `assets/icons/` folder in the bundle.
- The Android UI is a 3D horizontal carousel; the web port should use a simpler,
  responsive **grid/list of cards** (more natural for PC browsing + scroll +
  search, which the blueprint calls out as the core interaction).

---

## 4. Architecture of the web app

Dependency-light, no build step (keeps "copy to deploy" trivial):

```
mvrarchive/
├── index.html
├── styles.css                 # theme tokens + components
├── assets/icons/*.svg
├── js/
│   ├── api.js                 # thin wrapper over the OmniGate file API
│   ├── path.js                # POSIX/Windows path join/parent/sep helpers
│   ├── study.js               # Study model: parse folder, load study_info, counts
│   ├── studyinfo.js           # YAML field map <-> display model, dual-write
│   ├── views/
│   │   ├── archive.js         # Study grid, search, sort, multi-select
│   │   ├── study.js           # Study detail: media grid, info panel
│   │   ├── imageView.js       # image viewer + zoom/pan (+ annotate, phase 3)
│   │   ├── videoView.js       # video player
│   │   └── report.js          # report builder (phase 3)
│   └── app.js                 # router/boot
└── vendor/
    └── js-yaml.min.js         # vendored YAML parser/dumper (static, no CDN)
```

- **Vanilla ES modules**, no framework, matching the existing demo style. (A
  framework is optional and not required for the feature set; revisit only if
  the view layer grows unwieldy.)
- **YAML in-browser:** vendor `js-yaml` as a static file (parse + dump). Preserve
  unknown keys by serializing the full object.
- **Binary media:** `fetch('/api/files/read?path=…')` → `res.blob()` →
  `URL.createObjectURL` for `<img>` / `<video>`. Revoke object URLs on
  navigation to avoid leaks.
- **Listing performance:** the Android app lazy-loads metadata with a worker
  pool (4 local / 12 network). Mirror with a bounded-concurrency queue: render
  Study cards immediately from the directory listing, then hydrate
  `study_info.yaml`, counts, and thumbnails progressively.

---

## 5. Feature roadmap

Functions confirmed from the Android Archive (`ArchiveFragment.kt`,
`CoreBaseFragment.kt`, `ReviewFragment.kt`, `ReportFragment.kt`). Phased by value
vs. how much each fights the static-only platform.

### Phase 0 — done
- [x] Static app deployed to OmniGate on port 9090, behind login.
- [x] API reachability check (`/api/roots`, `/api/files`).

### Phase 1 — Browse & search (MVP, the blueprint's core)
- Root/storage selector from `/api/roots`.
- List Study folders (filter by `isMvrStudyFolder` naming), **sort newest-first**.
- Study card with metadata, counts, first-image thumbnail, export badge.
- **Search/filter** by folder name, Study ID, date, patient first/last name,
  accession (incremental, client-side — mirrors `StudyInfo.filter`).
- Open a Study → detail view: media grid (images/videos/PDFs) + info panel.
- Full-size image viewer with zoom/pan; video playback; PDF view (browser native
  or `pdf.js` if needed).

### Phase 2 — Study management
- **Edit Study info** form (well-known fields) → dual-write `study_info.yaml` +
  `patient_info.json`, preserving unknown keys.
- **Copy Study** to another root (mkdir + per-file read→write copy, with
  progress). Timestamp-suffix on name collision.
- **Delete** Study / file (confirm dialog with counts) via `DELETE`.
- Multi-select (mark) + bulk copy/delete.

### Phase 3 — Authoring (heavier, in-browser)
- **Image annotation** (line/rect/circle/arrow + notes) on Canvas; save
  annotated copy and/or sidecar notes via `PUT`.
- **Report builder**: pick images, choose layout/paper, render to PDF in-browser
  (`jspdf` or `pdf-lib`, vendored) → write `R####.pdf` into the Study folder.

### Phase 4 — Stretch / platform-limited (needs decisions)
- **Send to PACS (DICOM C-STORE):** PACS networking + DICOM encoding are not
  possible from a sandboxed browser with only a file API. Options: (a) drop;
  (b) "export to a watched NAS folder" that a separate OmniGate-side service
  uploads; (c) request a new OmniGate endpoint. **(Open question Q2.)**
- **Video trim/stitch:** feasible only via WebCodecs/ffmpeg.wasm (large, slow);
  likely defer. **(Open question Q3.)**
- **DICOM (`.dcm`) image/video rendering:** needs an in-browser DICOM parser
  (e.g. `cornerstone`/`dicom-parser`). Phase 1 can show non-DICOM media and mark
  `.dcm` as "open externally" until added. **(Open question Q4.)**

---

## 6. Risks & open questions

- **Q1 — Range requests:** Does `/api/files/read` support HTTP `Range`? Determines
  whether video seeking works or we must download whole files. *Verify against
  the OmniGate file provider before Phase 1 video work.*
- **Q2 — PACS:** Is "Send to PACS" in scope for the web port, and if so via which
  mechanism (drop / NAS hand-off / new endpoint)?
- **Q3 — Video editing:** Is trim/stitch required, or is playback enough?
- **Q4 — DICOM:** How common are `.dcm` files in target archives? Drives whether
  a WASM DICOM decoder is worth bundling early.
- **Write atomicity:** `PUT` rewrites whole files with no locking. Concurrent
  edits from the device + web app could clobber. Mitigate with read-before-write
  and a visible "last modified" check.
- **Large directories:** archives can hold thousands of Studies; rely on
  progressive hydration + virtualized scrolling for the grid.
- **No file-watch/push:** the app must poll/refresh to see new Studies; add a
  manual Refresh and optional interval poll.

---

## 7. Immediate next steps

1. Confirm Q1 (Range) and Q4 (DICOM prevalence) — both are quick checks and gate
   Phase 1 media handling.
2. Extract the icon set and theme tokens into `assets/` + `styles.css`.
3. Build `api.js` + `path.js` + `study.js`/`studyinfo.js`, then the Phase 1
   archive grid + search against a real archive root.
4. Point OmniGate's `--allow-dir` at a NAS/archive folder with sample Studies for
   end-to-end testing.
