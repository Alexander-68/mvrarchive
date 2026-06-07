# MVRarchive — How it should work

A living, plain-language spec of the intended behaviour and UX, captured as we
discuss it. This is the reference for *intent*; the implementation plan
(`MVRarchive_implementation_plan.md`) covers phasing and architecture.

Last updated: 2026-06-08.

---

## Product

A web port of the Android **MVR Archive** screen, served as a pure static app by
OmniGate (port 9090, behind a per-app login). It browses recorded imaging
*Studies* (folders on a NAS / local storage) through OmniGate's user-level file
API only — no server-side code of our own. Look & feel follow the Android app:
dark theme, accent `#42a8d8`.

## Storage & data

- A **Study** is a folder named `CASE####` (legacy) or
  `yyyyMMdd_HHmmss_<StudyID>_<Serial>` (Send-to-NAS / direct recording).
- Metadata lives in `study_info.yaml` (mirrored to `patient_info.json`, used as a
  parse fallback). Media files: `I/J*` images, `V/W*` videos, `R*` PDF reports.
- Unknown metadata keys must be **preserved** — display the known ones, never
  drop the rest (matters when we add editing/saving).

## Archive (grid of Study cards)

- Storage-root selector (from `/api/roots`). Studies listed **newest-first**.
- Cards load progressively: the grid paints immediately, then each card hydrates
  its counts, metadata and thumbnail in the background (bounded concurrency).
- **Card content:** thumbnail (first image), patient/animal name (falls back to
  Study ID, then folder name), date, counts (image / video / pdf) + total size,
  Study ID, date of birth.
  - **Nothing is drawn on top of the thumbnail image** — no type pill, no badges.
- **Search** is incremental and client-side: matches folder name, Study ID,
  patient first/last name, accession, and date. It filters the visible set.

## Selection

- **Space** toggles selection (mark) on the focused study (gold border). The
  number selected shows on the right of the status bar.

## Navigation model (no on-screen help text — keys are intuitive)

A visible **focus cursor** (blue outline) marks the current item.

| Input | Archive grid | Study detail | Single-image viewer |
|-------|--------------|--------------|---------------------|
| Arrows | move focus (←→ in row, ↑↓ by row) | move focus among media tiles | ←/→ previous / next file |
| Enter | open focused study | open focused media | re-fit (reset zoom) |
| Esc | clear search (if any) | back to archive | close viewer |
| Space | select / unselect study | select / unselect tile | — |
| Mouse | click = focus + open | click = open | wheel = zoom toward cursor; drag = pan when zoomed |
| Touch | tap = open | tap = open; pinch/wheel resize tiles | pinch-zoom, drag-pan, swipe ←/→ to change file |

## Study detail

- Header (top row): **← Studies** (back), title, sub-line (date · counts), and on
  the **right side** **‹ Prev / Next ›** buttons to move between studies.
  - Prev/Next set = studies **visible after search** (not absolute order). If more
    than one study is **selected**, navigation is confined to the selection; a
    single selection is ignored (behaves as "all visible"). Buttons disable at the
    ends.
- **Media tiles:** each shows one compact caption at the bottom, e.g.
  `IMAGE, I0001.jpg` — nothing else printed over the preview.
- **Wheel / pinch** over the media area resizes the preview tiles.
- **Info panel:** grouped into Patient / Study / Clinical-DICOM, plus an
  "Additional" group for any other present keys (so nothing is hidden).

## Single-image viewer

- Top label: **patient · folder · file (n/total)**. The patient part is omitted
  when it would just repeat the folder name (study without metadata).
- **Zoom:** mouse wheel (toward the cursor) and touch pinch (anchored on the
  gesture midpoint), 1×–8×. **Pan:** drag (mouse) or one-finger drag (touch) when
  zoomed.
- **Zoom & pan persist when switching images** — stepping through a series keeps
  the same magnification and position (useful for comparing the same region).
  Zoom resets only on a fresh open of the viewer or when Enter (re-fit) is pressed.
- **Smooth transitions:** when changing image, the previous frame stays visible
  while the next loads, then cross-fades in on top — no blank/dark flash between
  frames, like a movie.
- Video and PDF play in the viewer. DICOM (`.dcm`) is not viewable yet (decoder
  planned). Files over 32 MiB can't load through the current API — a streaming
  endpoint is proposed (`omnigate-streaming-endpoint.md`).

## Platform notes / constraints

- The file `read` endpoint always returns `application/octet-stream`; the client
  re-types blobs by file extension so images/video render.
- `read` has **no HTTP Range** and a **32 MiB cap** — fine for images/PDFs, blocks
  large video. Streaming endpoint proposal addresses this.
- The app uses **classic scripts** (a `window.MVR` namespace), not ES modules, to
  avoid Windows MIME-registry issues with `http.FileServer` serving `.js`.

## Deployment

- Edit in `C:\Alex\MVRachive`; deploy by copying the web files
  (`index.html`, `styles.css`, `js/`, `assets/`) into
  `C:\Alex\omnigate\data\apps\mvrarchive`. OmniGate serves them live; no restart.
- Commit + push after each significant step.
