# MVRarchive

MVRarchive browses imaging studies on OmniGate shares. Users search studies, view images, video, PDF, and DICOM, view study metadata, copy, delete and recover content, and send files to PACS.

## Features

**Archive (study list)**
- Storage selector lists the gateway's shares (local, network, Cloud PACS); read-only shares hide write actions.
- Each storage works like a browser tab: switching away and back returns to where you were (open study with its focused file and scroll position, or focused card and scroll position, search text, Cloud PACS search). Studies already loaded keep their metadata; Refresh re-reads everything. Switching clears the selection; the copy clipboard is kept.
- Study cards, newest first: patient name, IDs, date, modality (cloud), and a preview of the first media (four posters when cards are large).
- Search box filters by folder name, Study ID, patient/animal name, accession number, birth date and study date.
- Cloud PACS opens on recent studies: the last 3 days, widening to 7, 30 and 365 days while none are found; if the last year is empty too, it says whether the store is empty or how many studies it holds and their date range. **Search** asks the store by patient name (Google fuzzy match), MRN, study date range, modality, accession number and description; leave every field empty to go back to recent studies. The status bar names the scope (`last 3 days`, `search`). The search box then filters only the loaded cards.
- Ctrl+wheel or pinch resizes cards. Refresh reloads the share.
- Deep link: `?path=/Share` opens a share, `?path=/Share/<study folder>` opens that study.

**Study detail**
- Media grid of stills, videos, PDFs and DICOM; wheel or pinch resizes tiles.
- Info panel with study metadata from `study_info.yaml` grouped by Patient, Study, etc.; hover a field to see its full value.
- Prev/Next buttons step through studies without returning to the list.

**Viewer**
- Fullscreen images, video, PDF and DICOM. Wheel/pinch zooms, drag pans, Enter re-fits.
- Images: JPEG, PNG, GIF, BMP, WebP, HEIC/HEIF. HEIC/HEIF, which most browsers cannot decode, open as OmniGate's 2048 px ffmpeg rendering. On a gateway without ffmpeg, WebP/HEIC thumbnails answer 415 and the tile keeps the image icon (no retry).
- Multi-frame DICOM plays as cine: play/pause, frame slider, speed (Auto, 2-30 fps), Arrow Up/Down steps frames.
- For DICOM files, Info shows the tag dump. Left/Right or swipe moves between files; Space selects the current file.
- DICOM type comes from the MVR file name or, for unknown names, the payload's Content-Type.

**Selection and actions**
- Select studies or files (Space, Ctrl+click, Ctrl+A). The status bar shows selected and copied counts.
- Copy/Paste (Ctrl+C / Ctrl+V): studies paste into another storage, files into another study; the same place is refused. Copied items keep a green outline.
- Delete (Delete key) asks for confirmation; the gateway soft-deletes.
- Cloud PACS delete (OmniGate admins only): selected studies or selected files are deleted from the store **permanently**. The dialog says so (`Delete permanently`); there is no trash and no Restore. Non-admins see no Delete on Cloud PACS.
- **Show 🗑** browses deleted content (trashed studies and studies holding deleted files); the selection then offers Restore.
- Send to PACS: pick a registered DICOM or Cloud PACS server. JPEG, BMP, WebP/HEIC/HEIF (converted to JPEG by OmniGate, needs ffmpeg there), MP4, PDF and DICOM are sent with the study's patient/study tags; other files are skipped. Byte-weighted progress bar with ETA, per-file errors, Cancel. Cloud PACS sends 3 files at a time with at most one video; DICOM servers get one file at a time.

**Keyboard**: arrows move the focus, Enter goes in, Esc goes out (or clears the search), Space selects, Ctrl+A/C/V, Delete.

**Gateway integration**: user name and Sign out in the header; theme, zoom, inactivity sign-out and screensaver follow OmniGate.

## Implementation notes

For AI coding agents tailoring UI: `index.html` defines screens and controls; `styles.css` sets layout, responsive sizing, and colors; `js/ui.js` owns rendering and interaction. Keep gateway calls in `js/api.js`, study parsing in `js/study.js`, path handling in `js/path.js`, and cine playback logic in `js/cine.js`. `js/yaml.js` handles YAML. Avoid changing these functional files for visual adjustments.

UI principles: study cards keep identifying details visible; detail view separates media from metadata; viewer provides keyboard navigation and clear back path. Respect read-only shares, preserve deleted/live distinction, and expose PACS errors. OmniGate's `__omnigate/app-session.js` follows dark/light theme and zoom, signs out after gateway inactivity limit, and opens screensaver over sign-in. Keep Sign out visible.

Build with `node build.js` or `build.ps1`. Both bundles include root `index.html`, `omnigate.json`, and `README.md`.

When a DICOM image fails to load and gateway reports inactive DICOM, viewer shows
`Could not load filename.dcm: DICOM is not activated`. Other load errors keep
generic message. Admin activates AKDICOM in OmniGate Settings.

Directory reads follow OmniGate's `next_cursor` until every page is collected
(`limit=256`). Archive studies, study media/metadata, and deleted entries remain
complete when a directory exceeds one page. Gateways without `next_cursor`
remain supported. Listing reads retry transient `429`/`503` responses up to five
times with bounded `Retry-After` delays; mutations are never replayed. Directory
edits during pagination are not a snapshot; refresh to include new names before
the current cursor. Existing archive search still retains the complete listing
in browser memory.

The Storage selector never exposes `/priv_data`, the hosted app's private store;
it is filtered from `/api/roots` before navigation or deep-link resolution.
Read-only share flags are still applied to the shares that remain. On a
read-only share (incl. Cloud PACS) the **Show 🗑** toggle is hidden, since it
can hold no deleted files; switching to one leaves deleted mode.

Cloud PACS: OmniGate lists Google cloud DICOM stores as read-only storage roots
(`erase:true`: an admin's delete is permanent; `api/me` reports `admin`),
each study folder carrying a generated `study_info.yaml`. Cards show
`Modality` beside the study date. `GET api/pacs` entries with `kind: "cloud"`
appear in the send dialog as `Name (Cloud PACS)`. When `SeriesNumberBase` is
set, Send to PACS adds `SeriesNumber` per file: base + 1 (JPEG/BMP/WebP/HEIC/HEIF), + 2 (MP4),
+ 3 (PDF); DICOM files get none. YAML quoted strings unescape backslash, quote and newline escapes in one pass.
Cloud videos never get a browser-made poster (that would download the whole
video from Google): OmniGate answers their thumbnails `404`, and the 415/422
frame-capture fallback is skipped for any study with `CloudPACS` set. A cloud
study sends `PatientID` only from its own `PatientID` (no `StudyID` fallback),
`PatientName` as Last^First^Middle^Prefix^Suffix, and `WlStudyTime` as stored
(fraction kept).

Run regressions with `npm test`, including directory pagination beyond 256
entries, deleted/legacy listings, overload retries, invalid cursors, canceled
scans, and hidden private storage. Browser header regression:
`node test_header.js [path-to-playwright]`. Build latest bundle with `npm run build`.

Thumbnail requests retry temporary 429/502/503/504 (each wait 0.1-5 s) at most 5 times, then show Retry preview (cloud or local busy renderer alike); network failures retry while
needed, including response-body failures. Leaving the viewport or view cancels
obsolete preview work. Media-grid scrolling updates priorities immediately.
Only decoded images count as loaded; permanent errors show Retry preview.
DICOM files play as video when named `V0001`/`W0001` (MVR) or `VVp.`/`VVe.`/`VVm.` (storescp
Video Photographic/Endoscopic/Microscopic); `PDF.`/`R0001` open as PDF. Any other `.dcm`
is checked when opened: the payload's `Content-Type` (one byte from `api/files/payload`)
switches it to the video player or PDF viewer; otherwise it opens as a still.

Cards of PDF-only studies, and PDF tiles in the study view (plain and DICOM PDF),
show page 1 (OmniGate renders it with pdftoppm); without a renderer (415/404/422) the card keeps the study icon, no retry.

Video capture fallback runs only for unsupported/render-failed posters (415/422),
so temporary overload never downloads full videos. Card hydration stays bounded
until card previews finish; returning to interrupted cards resumes their previews.

Browser recovery regression: `node test_preview_recovery.js [path-to-playwright]`.
Covers a 320-image paginated folder, 429/503 recovery, four-poster video cards,
visible tiles after scroll jumps, and explicit retry following permanent failure.
