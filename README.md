# MVRarchive

MVRarchive browses imaging studies on OmniGate shares. Users search studies, view images, video, and DICOM, edit study metadata, recover deleted content, and send files to PACS.

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

Run regressions with `npm test`, including directory pagination beyond 256
entries, deleted/legacy listings, overload retries, invalid cursors, and canceled
scans. Browser header regression: `node test_header.js [path-to-playwright]`.
Build latest bundle with `npm run build`.
