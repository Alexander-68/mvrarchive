# How to make OmniGate web apps

**Audience: AI coding agents.** This is a build spec, not a tutorial. Follow the
rules below to produce an app the gateway will accept and serve correctly. When
in doubt, copy the patterns in [`xplore/`](xplore) — it is the reference
implementation and exercises every endpoint here.

[Compact editor guide](APP_EDITOR_GUIDE.md) summarizes architecture and core app
APIs. Gateway embeds that document as trusted system context in every AI edit;
keep it synchronized with app gateway routes when changing platform contracts.

## Persistent app storage: `/priv_data/`

Every installed hosted app gets one writable store shared by all users of that
app. Use it for settings, parameters, saved credentials, and other persistent
state. Server binds store to installed app identity; apps cannot choose another
app's store through a request parameter. This separates trusted apps' data; it
is not a security boundary against sibling apps sharing a browser origin.

Physical layout (default apps root):

```text
data/apps/<installed-id>/       # Static code; app Git versions
data/apps_data/<installed-id>/  # Private app storage; outside code and Git
```

For a custom apps directory, storage root is that directory's path plus
`_data`. `/priv_data/` is a virtual file-provider root, not a folder to include
in your ZIP and not an HTTP endpoint. Do not create a `priv_data/` folder inside
web code. Storage is never served as static assets. Access it through existing
authenticated, app-relative file API; `api/roots` reports `priv_data` as writable.
This root name is reserved and takes precedence over a configured share with
same name within app API. Gateway's general file browser does not gain this root.

```js
const path = encodeURIComponent("/priv_data/settings.json");
const saved = await fetch(`api/files/read?path=${path}`);
if (saved.status === 404) {
  // First use: apply app defaults.
} else if (!saved.ok) {
  throw new Error(`Read settings failed: ${saved.status}`);
} else {
  const settings = await saved.json();
  // Apply settings.
}

const result = await fetch(`api/files/write?path=${path}`, {
  method: "PUT",
  body: JSON.stringify({ theme: "dark" }),
});
if (!result.ok) throw new Error(`Save settings failed: ${result.status}`);
```

Existing list, mkdir, copy, delete, and restore operations also work with
`/priv_data/...`; existing file limits and path jail apply. Writes replace whole
files atomically; simultaneous saves use last successful write. Create nested
folders with `api/files/mkdir` before writing into them. Users of one app share
this state, so do not treat it as per-user confidential storage.

- New install creates empty store; existing apps get store when started.
- Code updates, version saves, and restores leave store unchanged. Code rollback
  does not roll back data: keep settings formats compatible or migrate them.
- Clone copies entire store, including saved credentials and deleted entries,
  while source app requests pause. Copies become independent; source Git history
  is not copied. External filesystem writers must be stopped separately.
- Admin **Update app → Clear data** permanently empties store after confirmation,
  including saved credentials and deleted files. Store stays writable; reload app
  to use defaults. Handle missing settings files even after initial setup.
- Deleting app deletes its store. Back up `apps_data` separately from code
  versions; do not rely on app Git history to recover settings.

## What an app is

An OmniGate app is a directory of **static** web code — HTML/CSS/JS only, **no
server-side code**. You zip the directory's contents and upload the bundle; the
gateway unpacks it and serves it under its own path behind a per-app
login.

```
apps/
  xplore/        reference file browser (browse, view/edit, create, delete)
  xplore.zip     built bundle (generated; not tracked in git)
```

Hard requirements for a valid bundle:

- Put `index.html` at the **zip root**. Wrapper directories are also accepted:
  the shallowest `index.html` determines the app root and its wrapper is removed.
- Put `omnigate.json` and `README.md` beside that `index.html`. Preview,
  installation, and updates reject bundles missing either file.
- Keep UI markup, styling, and rendering separate from file/API and other
  functional code. Simple apps can use separate files; larger apps can use folders.
  Do not put all UI and functionality in one file.
- Reference assets and APIs with **relative, same-origin** URLs (`href="styles.css"`,
  `fetch("api/files?...")`). There is no CDN and no cross-origin access.
- Do not ship a backend, a service worker that intercepts `/api/*`, or anything
  expecting Node/PHP/etc. The gateway serves files verbatim.

### Static bundle checks

Preview, install, and update reject `node_modules` (case-insensitive) anywhere in
the ZIP, plus these file extensions (also case-insensitive):

```text
.exe .dll .so .dylib .com .msi .sh .bat .cmd .ps1
.php .phtml .py .pyc .rb .pl .cgi .asp .aspx .jsp .jar
.go .tsx .jsx .vue .svelte
```

Ship your build output, not your source tree. Files outside the chosen app root
are also screened. Existing path traversal, symlink, file-count and decompressed
size checks still apply. JavaScript, WebAssembly, and `package.json` are allowed;
OmniGate never runs package scripts or backend code. File extensions are a
deployment check, not proof of safety or backend independence. These checks do
not analyze JavaScript behavior, validate every asset reference, scan malware,
or detect every server language. Rejected bundles leave existing app code intact.

### Required omnigate.json manifest

Place `omnigate.json` beside the selected `index.html` (inside the same wrapper,
if present). It must be valid:

```json
{
  "manifestVersion": 1,
  "id": "xplore",
  "name": "Xplore",
  "version": "1.0.0",
  "apiVersion": 1,
  "description": "Browse and manage files through OmniGate",
  "ageRestriction": 0
}
```

- `manifestVersion` and `apiVersion`: required integers, currently `1` only.
- `id`: required lowercase ASCII slug using letters, digits and hyphens; no
  leading/trailing hyphen. Package identity only for now; installed IDs still
  derive from the App name submitted by the administrator. Updates preserve
  installed IDs; manifest package identity is not yet enforced across updates.
- `name`: required nonblank display name, at most 256 UTF-8 bytes after trimming;
  must contain an ASCII letter or digit so it can become an installed app ID.
- `version`: required nonblank string, at most 128 UTF-8 bytes after trimming.
  SemVer is recommended, not enforced.
- `description`: optional string, at most 4096 UTF-8 bytes after trimming.
- `ageRestriction`: optional nonnegative integer; omitted value defaults to `0`
  (no age restriction). It is metadata only; gateway does not enforce age access.

Manifest limit: 64 KiB. Field names are case-sensitive. Unknown fields, duplicate
JSON members, trailing JSON, wrong field types, and unsupported versions fail
validation. A malformed manifest never silently falls back to HTML metadata.

The **Upload & host app** form uses manifest `name` and nonblank `description`.
Blank manifest description falls back to HTML meta description. Favicon discovery
stays in HTML. Administrators can edit the pre-filled fields.

### Required README.md for AI app tuning

Place `README.md` at app root beside `index.html`. Describe app name, purpose,
essential functionality, and implementation ideas behind key UI principles.
Write for AI coding agents helping users tailor app to their workflow. Point to
UI files and functional files so UI changes can be made without changing API or
data behavior. Installer checks file presence; authors own content quality.

Manifest declares compatibility, not permissions. Optional `omnigate.sig` beside
it signs every packaged file, including manifest and README. Unsigned apps remain
allowed. Present signatures must verify during preview/install/update and startup;
invalid signed apps are rejected. Upload preview reports verified or unsigned.
See [app signing](../SIGNING.md#app-bundle-signing). After tailoring any file,
re-sign before packaging, or remove signature to distribute an unsigned app.
Direct GitHub installation is not implemented.

## The runtime model (read before coding)

Each app runs below its own **path** (e.g. `http://127.0.0.1:8080/xplore/`) behind the
per-app **gateway**, which:

- **gates** the static files behind a login — requesting any app file without a
  valid session 303-redirects the browser to a sign-in page;
- **brokers** a user-level file API on the app's *own* origin, so your code
  calls plain relative URLs (`fetch("api/files?path=…")`) — **no token, no
  CORS, no admin API**. The session rides in an `HttpOnly` cookie you never see;
- forces every app session to the **User** role — an app can never act as admin,
  even if an admin signs in to it.

Because auth is a cookie the JS cannot read, handle a **401** on an API call
(the session expired) by redirecting to `__login`. Also sign out after browser
inactivity; do not wait for the next API call. See `api()` in `xplore/core.js`.

## Required app behaviours

An app you generate MUST:

1. **Provide a Sign Out control.** Include a logout affordance that ends the
   session. It is a plain form POST — no JS or token needed:

   ```html
   <form method="post" action="__logout">
     <button type="submit">Sign out</button>
   </form>
   ```

   The gateway clears the cookie, redirects to the login page, and starts its
   screensaver. Keyboard input or a click wakes the sign-in page.

2. **Handle session expiry.** When any `api/*` call returns `401`, send the
   browser to `__login` rather than showing a broken UI:

   ```js
   if (res.status === 401) { location.href = "__login"; return; }
   ```

3. **Sign out after browser inactivity.** Include the gateway's shared script
   in `<head>`, and keep the Sign Out form above. It reads `inactivityMinutes`
   from `api/platform`, watches user input, submits that form when idle, and
   rechecks elapsed time when a hidden tab returns. The gateway still enforces
   session expiry; client timer makes it visible without an API call.

   ```html
   <script src="__omnigate/app-session.js"></script>
   ```

   The same script applies OmniGate's `dark`/`light` theme and zoom on load and
   when a hidden tab returns. Define both palettes in CSS using
   `html[data-theme="light"]`. Place script in `<head>` to limit wrong-theme
   paint. Built-in `xplore` and `o5tart` show the pattern.

4. **Discover shares before touching files.** Never hard-code a path. Call
   `GET /api/roots` first and build navigation from the returned shares.

5. **Honour the `?path=` deep-link** (see *Start path* below).

## API reference

All endpoints are same-origin and operate at User level. Paths below are
relative to app prefix (use `api/...` in browser URLs). `path` values are
**virtual** (see *Paths* below).

| Method | Path | Purpose | Notes |
|--------|------|---------|-------|
| `GET` | `/api/platform` | Identify the gateway and read its display/session settings | **No session needed.** Returns `{"platform":"omnigate","product","version","theme","zoom","inactivityMinutes"}` |
| `GET` | `/api/me` | Current authenticated user identity | Returns `{"username","role"}` |
| `GET` | `/api/roots` | List available shares | Returns `{"roots":[{"name","writable","remote"?,"search"?}]}` (`remote`, `search` only when true); Cloud PACS roots are `writable:false`, `remote:true`, `search:true` (see *Cloud PACS roots*) |
| `GET` | `/api/files?path=` | List a directory | Returns `{"path","entries":[{name,is_dir,size,mod_time}],"next_cursor"}`. Default 256 rows; `limit=1..1000`, repeat with `cursor=next_cursor` until empty. Add `&deleted=1` to list that directory's **deleted** entries instead: each also carries `original_name` and `deleted_at`; `name` is the on-disk trash name to use in paths |
| `GET` | `/api/files/statfs?path=` | Capacity of the volume behind a path | Returns `{"total","free"}` in bytes; `free` is what the server may still write. Works on local and network shares. |
| `GET` | `/api/files/size?path=&refresh=1` | Recursive visible folder size | Returns `{bytes,files,folders,calculated_at,cached}`. Omit refresh to use 30-second host cache; abort fetch to cancel your request. Last waiter cancellation stops shared scan. Hidden entries, trash and symlinks excluded; errors never return partial totals. |
| `GET` | `/api/files/read?path=` | Read a file | Streams; honours `Range` (seek/resume, in-browser video frames) |
| `GET` | `/api/files/thumbnail?path=&w=` | JPEG thumbnail of an **image, video, PDF or DICOM file** (still, video or PDF) | `w` (default 320, max 2048) applies to plain images; tool-rendered previews are fixed at 640 and answer `415` without their tool. See *Thumbnails* below for the full matrix and fallbacks |
| `PUT` | `/api/files/write?path=` | Write/create a file | Raw request body is the file content (≤ 32 MiB) |
| `POST` | `/api/files/mkdir?path=` | Create a folder | Creates missing parents |
| `DELETE` | `/api/files/delete?path=` | Delete a file or folder | Soft delete: the entry is renamed in place to `.deleted.<ms>.<name>` and vanishes from listings; returns `{"path","deleted":true,"trash_path"}`. Cannot delete a share root; deleting an already-deleted entry is `400` (no permanent delete exists) |
| `POST` | `/api/files/restore?path=` | Restore a deleted entry | `path` is the `trash_path` / `name` from the deleted listing; returns `{"path","restored":true}` with the live path. `409` if the original name is in use again |
| `POST` | `/api/files/copy?src=&dst=` | Copy a file or folder | Recursive, streams (no size cap), works across shares. `dst` is the new entry's own path; `409` if it exists, `400` if it lies inside `src` |
| `GET` | `/api/dcmtk` | List available DCMTK tools | `503` when DCMTK is not installed on the gateway host |
| `POST` | `/api/dcmtk/{tool}` | Run a DCMTK tool | Body `{"args":[...],"timeoutSec":60}`. Mark jail files as `in:/Share/path` / `out:/Share/path` (out needs a writable share); other args pass verbatim, but unmarked args containing `/`, `\`, `..` or a drive prefix are rejected (`400`). Returns `{exitCode,stdout,stderr,stdoutTruncated,stderrTruncated}`; nonzero exit is still `200` |
| `GET` | `/api/pacs` | List PACS servers an admin registered | Returns `{"servers":[{"name","kind","host","port","aet"}],"callingAET"}`; `kind` is `"dicom"` or `"cloud"`; empty list when none |
| `GET` | `/api/apps` | List installed apps for a launcher | Returns `{"apps":[{"id","name","description","manifestName","manifestDescription"}]}`. Manifest fields are blank for linked apps or older bundles |
| `GET` | `/api/apps/{id}/launch` | Open an installed app | Hosted apps receive a one-use session handoff; linked apps redirect to their registered URL. Navigate to this relative URL rather than fetching it |
| `POST` | `/api/pacs/{name}/send` | Send a file to the named PACS (DICOM C-STORE) | Body `{"path":"/Share/file","tags":{"PatientName":"Doe^Jane",...}}`. See *Send to PACS* below. `200 {ok:true,wrapped}` on success, `502` when the PACS refused (`{error,exitCode,output}`), `503 dcmtk not installed` without DCMTK. Works for cloud stores too (STOW-RS, also needs DCMTK) |
| `POST` | `/__login` | Sign in (form post) | Gateway-rendered page; you rarely call this directly |
| `POST` | `/__logout` | End the session | Clears session, redirects to login screensaver |

Error responses are JSON `{"error": "..."}` with a matching HTTP status:

| Status | Meaning |
|--------|---------|
| `400` | Missing/invalid `path` |
| `401` | No/expired session → redirect to `/__login` |
| `403` | Path names no share, escapes a share, or writes to a read-only share |
| `404` | Target does not exist |
| `429` / `503` | Temporary rate/load limit; honor `Retry-After`, retry safe reads while needed, cancel obsolete work. Never mark a failed thumbnail complete or fall back to video capture merely because host is busy. |
| `413` | Write body exceeds 32 MiB |
| `415` | File type or share not supported by the tool (thumbnail, DCMTK bridge, Send to PACS) |
| `502` | PACS refused or the transfer failed; `output` carries the DCMTK message |
| `504` | PACS transfer exceeded 120 s |

### Detecting OmniGate and matching its look

`GET api/platform` needs no session, so an app can call it as soon as it loads —
including from its own login page. `platform === "omnigate"` means the app is
running on the gateway rather than opened standalone; `version` is the gateway
version (`v1.0.YYMMDD`). `theme` is `"dark"` or `"light"` and `zoom` is a
percentage (60–200), both device-wide settings of the gateway UI:

```js
const p = await (await fetch("api/platform")).json();
if (p.platform === "omnigate") {
  document.documentElement.dataset.theme = p.theme;
  document.documentElement.style.zoom = p.zoom + "%";
}
```

The bundled apps load `__omnigate/app-session.js` from `<head>` and carry an
`html[data-theme="light"]` stylesheet block. The script also reads
`inactivityMinutes` and signs out after that many minutes without input.
Real input, including `omnigate:activity` from launcher/editor parent, also renews
app session through throttled `api/me` requests (at most once per 20 seconds).
No background keepalive runs while idle. Shared Sign Out form remains required.

Platform reply also contains `device_id`, currently 12 lowercase hex characters.
Treat it as an opaque string, not a 32-bit integer. Earlier builds returned eight
characters; those remain the prefix when identity source is unchanged. Apps
storing IDs or enforcing the old length must migrate. Bundled apps do not depend
on device ID length. New DICOM exports use the longer ID too.

The endpoint is also served on the gateway's own origin (`/api/platform`) with
`Access-Control-Allow-Origin: *`, which is how a **linked external** app — one
not hosted by the sandbox — can read it.

### Paths are virtual share paths

DICOM features require active `AKDICOM` on verified device and official build.
Authenticated requests to PACS/DCMTK, DICOM payload/frame extraction, and DICOM
thumbnail APIs return `403 {"error":"DICOM is not activated"}` when inactive.
Show that message instead of retrying. Admin manages activation in main Settings;
hosted apps cannot list or enter activation codes. Generic file APIs are unaffected.

A `path` is **not** a server filesystem path. It is `/SHARE/sub/dir/file`, where
the **first segment is a share name** from `GET /api/roots` and the rest is
relative to that share, e.g. `/NAS/photos/cat.jpg`. The absolute server-side
location a share maps to is **never** exposed. Paths are always slash-separated,
regardless of the host OS. Anything that names no share, or escapes a share's
root (via `..` or a symlink), is rejected by the jail.

Each share carries a `writable` flag. For a read-only share, `write`, `mkdir`,
and `delete` return `403` — hide those controls when `writable` is false (the
server enforces it regardless; the UI gating is just courtesy).

### Cloud PACS roots

An admin can register Google Cloud Healthcare DICOM stores. Each shows up as a
root `/<name>` with `writable:false`, `remote:true`; `write`, `mkdir`, `copy`
into it, `delete` and `restore` answer `403` (delete from Cloud PACS is not
implemented). Layout:

- Study folders `yyyyMMdd_HHmmss_<PatientID>_<PatientName>_<12hex>`. Sort
  newest-first yourself.
- **Search, don't list.** A plain `GET /api/files?path=/<name>` pulls every
  study from Google (up to 50 000, about one request per 1 000). Roots with
  `search:true` take study filters on that same call instead; any of them
  turns the listing into a QIDO search (paging and `cursor` unchanged):

  | Param | Matching |
  |-------|----------|
  | `StudyDate` | `YYYYMMDD` or range `YYYYMMDD-YYYYMMDD` (else `400`) |
  | `PatientName` | Google fuzzy: any word prefixes any name part (`jo` finds `DOE^JOHN`) |
  | `PatientID`, `AccessionNumber` | exact |
  | `ModalitiesInStudy` | any of a comma list, e.g. `ES,XC` (matched by OmniGate) |
  | `StudyDescription` | case-insensitive substring (matched by OmniGate) |

  Values are at most 64 characters; filters work only on the root (`400`
  below it or on a share without `search`). A search returns at most 5 000
  studies; beyond that the response carries `"truncated":true`. Results are
  cached about 60 s per filter. Modality or description alone still scans the
  whole store; pair them with a date range. Study folders from a search (or a
  deep link) open without listing the whole store: OmniGate resolves them by
  the folder's date. MVRarchive opens on the last 3 days and widens to 7, 30,
  365 while empty.
- `GET /api/files/summary?path=/<cloud root>` -> `{"studies":N,"first":"YYYYMMDD","last":"YYYYMMDD"}`.
  `studies` is `0` for an empty store, `-1` when the count is unavailable
  (Google store metrics need `healthcare.dicomStores.get`). Dates come from
  `limit=1` QIDO probes (binary search, a few seconds, cached about 60 s);
  undated studies leave them out.
- Files `I####_<12hex>.dcm` (images), `V...` (video), `R...` (PDF report).
- Virtual `study_info.yaml` per study (WlStudyDate, WlStudyTime,
  SeriesNumberBase, CloudPACS, ...).
- Sizes are `0` until a file is fetched; first read downloads it (cached
  locally, listings cached about 60 s).
- Image thumbnails work; video thumbnails answer `404 {"error":"no
  preview"}`. Never read a cloud video (read or payload) to make a poster:
  that downloads the whole video from Google. Show an icon instead. MVRarchive
  and Xplore fall back to a browser poster only on `415`/`422`.
- `study_info.yaml` names: `PatientLastName`, `PatientFirstName`,
  `PatientMiddleName`, `PatientNamePrefix`, `PatientNameSuffix` (DICOM PN
  components); `WlStudyTime` is the full DICOM TM (fraction kept).
- Errors: `502 "Cloud PACS credentials rejected"`, `504 "Cloud PACS timed
  out"`.
- Names are unique across shares, network storage and PACS servers.

### Deleted entries (recycle bin)

Nothing is removed when you call `delete`: the entry is hidden in place and
stays restorable until the admin's retention period (default 28 days) runs
out, or earlier when the share runs short of free space. A deleted folder keeps
its contents, so listing or reading paths *inside* a trash folder works as
usual. To offer a recycle-bin view:

```js
const { entries } = await (await fetch(`api/files?path=${encodeURIComponent(dir)}&deleted=1`)).json();
// entries: [{ name: ".deleted.1757068800000.report.pdf", original_name: "report.pdf",
//             deleted_at: "2025-09-05T10:00:00Z", is_dir: false, size: 1234, mod_time: "…" }]
await fetch(`api/files/restore?path=${encodeURIComponent(dir + "/" + entries[0].name)}`, { method: "POST" });
```

Once the gateway removes an entry for real it first overwrites the bytes in
place (text formats fully, other files head and tail), so do not expect to
recover anything past the retention period.

Show `original_name` to people, keep `name` for the API. The built-in xplore
app does exactly this behind its **🗑 Deleted** toggle.

A share may also carry `"remote": true`: it is SMB network storage rather than
local disk, configured by the user or an admin in Settings. Reads, writes and
listings behave identically, so an app needs no special case for it — but two
server-side features are unavailable there and answer `415`: video poster frames
(fall back to the client-side capture below, which you already need for hosts
without ffmpeg) and the DCMTK bridge. Network shares can also be slower and can
disappear when the server does, so treat their errors as normal, not fatal.

### Start path (`?path=` deep-link)

An app is opened at `http://<host>:<port>/<app-id>/`. You may append `?path=/SHARE/sub`
to deep-link into a starting location — the app should read it on boot and open
there instead of a default. The gateway **preserves this URL across the login
redirect** (it round-trips through a sanitised `next` parameter), so a user who
isn't signed in yet still lands on the requested folder after authenticating.

Read it from the page URL and resolve the share from its first segment:

```js
const want = new URLSearchParams(location.search).get("path"); // "/NAS/photos"
```

See `startPath()` and `boot()` in `xplore/app.js` for the full pattern,
including falling back to the first share when `path` is absent or names an
unknown share.

### Thumbnails: OmniGate renders them, apps only request them

Do not decode media in the browser to make previews. Point an `<img>` (or a
`fetch`) at `GET /api/files/thumbnail?path=…`: the gateway renders a JPEG for
every supported type and caches tool-made ones beside the file as a hidden
`.<name>.jpg` (regenerated when the source is newer, never written to
read-only shares, invisible in listings).

| Source | How the gateway renders it | Size | Needs | Network storage |
|--------|----------------------------|------|-------|-----------------|
| Image (`.jpg`, `.png`, `.gif`, …) | In-process (pure Go) | `w` (default 320, max 2048, never upscaled) | nothing | yes |
| JPEG XL (`.jxl`) | ffmpeg, first frame | 640 wide, never upscaled | ffmpeg with libjxl | yes (staged) |
| Video (`.mp4`, `.mov`, `.mkv`, …) | ffmpeg, frame ~1 s in | 640 wide | ffmpeg | no → `415` |
| PDF (`.pdf`) | pdftoppm, page 1 | longer side 640 | pdftoppm (poppler) | yes (staged) |
| DICOM still, encapsulated JPEG | In-process from the payload | 640 | nothing | yes |
| DICOM still, other pixel data | DCMTK `dcmj2pnm`, middle frame of a multiframe | 640 | DCMTK | yes (staged) |
| DICOM video (encapsulated MP4) | ffmpeg on the payload byte range, in place | 640 wide | ffmpeg | no → `415` |
| DICOM Encapsulated PDF | pdftoppm on the payload, page 1 | longer side 640 | pdftoppm | yes (staged) |
| Cloud PACS root | Google renders stills | `w` | — | video and PDF answer `404` |

`w` only applies to plain images and Cloud PACS stills; every other row is
fixed so one cached file serves all callers. `.dcm`/`.dicom` requests need
DICOM activation (`403 {"error":"DICOM is not activated"}` otherwise).

A DICOM still preview is also how an app *views* the image full-screen
(browsers cannot decode `.dcm` pixel data): point the viewer at this endpoint
or, for the encapsulated JPEG/MP4/PDF itself, at `/api/files/payload`.

Handle the answers:

- **`200`**: show it.
- **`429` / `503`**: busy; honor `Retry-After` and retry. Never treat it as
  final or start a fallback.
- **`415`** (tool missing, or a video on network storage), **`422`** (render
  failed): final. For a video (plain or DICOM) you may capture a frame in the
  browser: a hidden `<video>` on `/api/files/read` (plain) or
  `/api/files/payload` (DICOM), seek ~1 s, draw to a `<canvas>`; HTTP Range
  keeps it to the needed bytes. For anything else show a type icon.
- **`404`** on Cloud PACS: no preview; show an icon. Never capture a frame
  there (it downloads the whole video from Google).

Working examples: `mediaThumb` and `captureVideoFrame` in `xplore/app.js`.

### Send to PACS

An admin registers DICOM storage servers (Settings → PACS storage); your app
lists them with `GET /api/pacs` and lets the user pick one by `name`. Then
`POST /api/pacs/{name}/send` with the file's virtual path and the DICOM tags
the object should carry:

```js
const { servers } = await api("GET", "/api/pacs");
const res = await fetch(`api/pacs/${encodeURIComponent(servers[0].name)}/send`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    path: "/NAS/case42/photo.jpg",
    tags: {
      PatientName: "Doe^Jane",
      PatientID: "P001",
      StudyInstanceUID: studyUID, // reuse for every photo of one study
      StudyDescription: "Endoscopy",
    },
  }),
});
const out = await res.json(); // {ok:true, exitCode:0, output:"", wrapped:true} or {error, exitCode, output}
```

- **JPEG and BMP** photos are wrapped into a *VL Photographic Image* DICOM
  object on the gateway (`wrapped: true`); **`.dcm`/`.dicom`** files go as they
  are, modified on a temporary copy when you pass tags. Other types answer
  `415`. Files on network shares can be sent.
- **Tags** are keyed by DICOM keyword (`PatientName`) or number
  (`(0010,0010)` or `0010,0010`), up to 100 of them, values up to 1024
  printable characters. Group `0002` (file meta) keys are refused with `400`.
- **Defaults the gateway fills in for a wrapped photo** when you leave them
  out: `Modality=XC`, `Manufacturer=MediCapture Inc`,
  `ManufacturerModelName=MSP`, `DeviceID`, `SoftwareVersions`, `StationName`,
  `InstitutionName`, `InstitutionAddress`, `InstitutionalDepartmentName`,
  `PerformedLocation` (all from the gateway's Device card) and
  Study/Series/Content date and time (now). Patient identity is **never**
  invented: always send `PatientName` and `PatientID`, and generate one
  `StudyInstanceUID` per study so the PACS groups the photos. A DICOM file keeps
  its own values; your tags only fill attributes it lacks or holds empty (empty, spaces or `^` only) (unreadable DICOM
  answers `415`).
- The gateway calls with its Device title as AE title (`callingAET` in the
  list) — the PACS must accept it. A `502` means the PACS was reached and said
  no (wrong AE title, unsupported SOP class, ...): show `output` to the user.
- A server with `kind:"cloud"` is a Cloud PACS store: the same call sends via
  STOW-RS (needs DCMTK like C-STORE: `503` without it; never retried, 10 min timeout). `409` means the
  instance already exists there.
- Every send is logged on the gateway; there is no undo.

## Building a bundle

Zip the **contents** of the app directory so `index.html` sits at the zip root.

PowerShell:

```powershell
Compress-Archive -Path apps\xplore\* -DestinationPath apps\xplore.zip -Force
```

POSIX:

```sh
( cd apps/xplore && zip -r ../xplore.zip . )
```

## Uploading

From the admin dashboard's **Apps** panel, or via the API (admin token):

```sh
curl -s -X POST http://localhost:8000/api/apps \
  -H "Authorization: Bearer $TOKEN" \
  -F name=xplore -F bundle=@apps/xplore.zip
# -> {"id":"xplore","port":8080,...}
```

Then open the reported app URL (e.g. <http://127.0.0.1:8080/xplore/>), sign in, and use it.
To deep-link into a folder, append `?path=/SHARE/sub` to that URL.
