# How to make OmniGate web apps

**Audience: AI coding agents.** This is a build spec, not a tutorial. Follow the
rules below to produce an app the gateway will accept and serve correctly. When
in doubt, copy the patterns in [`xplore/`](xplore) — it is the reference
implementation and exercises every endpoint here.

## What an app is

An OmniGate app is a directory of **static** web code — HTML/CSS/JS only, **no
server-side code**. You zip the directory's contents and upload the bundle; the
gateway unpacks it and serves it on its own segregated port behind a per-app
login.

```
apps/
  xplore/        reference file browser (browse, view/edit, create, delete)
  xplore.zip     built bundle (generated; not tracked in git)
```

Hard requirements for a valid bundle:

- `index.html` MUST sit at the **zip root** (not inside a subfolder).
- Reference assets and APIs with **relative, same-origin** URLs (`href="styles.css"`,
  `fetch("api/files?...")`). There is no CDN and no cross-origin access.
- Do not ship a backend, a service worker that intercepts `/api/*`, or anything
  expecting Node/PHP/etc. The gateway serves files verbatim.

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

Because auth is a cookie the JS cannot read, your code's only auth concern is
handling a **401** on an API call (the session expired): redirect to `__login`.
See `api()` in `xplore/app.js`.

## Required app behaviours

An app you generate MUST:

1. **Provide a Sign Out control.** Include a logout affordance that ends the
   session. It is a plain form POST — no JS or token needed:

   ```html
   <form method="post" action="__logout">
     <button type="submit">Sign out</button>
   </form>
   ```

   The gateway clears the cookie and redirects to the login page.

2. **Handle session expiry.** When any `api/*` call returns `401`, send the
   browser to `__login` rather than showing a broken UI:

   ```js
   if (res.status === 401) { location.href = "__login"; return; }
   ```

3. **Discover shares before touching files.** Never hard-code a path. Call
   `GET /api/roots` first and build navigation from the returned shares.

4. **Honour the `?path=` deep-link** (see *Start path* below).

## API reference

All endpoints are same-origin and operate at User level. Paths below are
relative to app prefix (use `api/...` in browser URLs). `path` values are
**virtual** (see *Paths* below).

| Method | Path | Purpose | Notes |
|--------|------|---------|-------|
| `GET` | `/api/platform` | Identify the gateway and read its display settings | **No session needed.** Returns `{"platform":"omnigate","product","version","theme","zoom"}` |
| `GET` | `/api/me` | Current authenticated user identity | Returns `{"username","role"}` |
| `GET` | `/api/roots` | List available shares | Returns `{"roots":[{"name","writable"}]}` |
| `GET` | `/api/files?path=` | List a directory | Returns `{"path","entries":[{name,is_dir,size,mod_time}]}`. Add `&deleted=1` to list that directory's **deleted** entries instead: each also carries `original_name` and `deleted_at`; `name` is the on-disk trash name to use in paths |
| `GET` | `/api/files/statfs?path=` | Capacity of the volume behind a path | Returns `{"total","free"}` in bytes; `free` is what the server may still write. Works on local and network shares. Folder sizes are not served: walk `/api/files` and sum `size` |
| `GET` | `/api/files/read?path=` | Read a file | Streams; honours `Range` (seek/resume, in-browser video frames) |
| `GET` | `/api/files/thumbnail?path=&w=` | JPEG thumbnail of an **image, video or DICOM file** | `w` defaults to 320, capped at 2048, never upscales; videos are fixed at 640 and need ffmpeg (else `415`); `.dcm`/`.dicom` previews come at source resolution, capped at 4096 px per side, and need DCMTK (else `415`) |
| `PUT` | `/api/files/write?path=` | Write/create a file | Raw request body is the file content (≤ 32 MiB) |
| `POST` | `/api/files/mkdir?path=` | Create a folder | Creates missing parents |
| `DELETE` | `/api/files/delete?path=` | Delete a file or folder | Soft delete: the entry is renamed in place to `.deleted.<ms>.<name>` and vanishes from listings; returns `{"path","deleted":true,"trash_path"}`. Cannot delete a share root; deleting an already-deleted entry is `400` (no permanent delete exists) |
| `POST` | `/api/files/restore?path=` | Restore a deleted entry | `path` is the `trash_path` / `name` from the deleted listing; returns `{"path","restored":true}` with the live path. `409` if the original name is in use again |
| `POST` | `/api/files/copy?src=&dst=` | Copy a file or folder | Recursive, streams (no size cap), works across shares. `dst` is the new entry's own path; `409` if it exists, `400` if it lies inside `src` |
| `GET` | `/api/dcmtk` | List available DCMTK tools | `503` when DCMTK is not installed on the gateway host |
| `POST` | `/api/dcmtk/{tool}` | Run a DCMTK tool | Body `{"args":[...],"timeoutSec":60}`. Mark jail files as `in:/Share/path` / `out:/Share/path` (out needs a writable share); other args pass verbatim, but unmarked args containing `/`, `\`, `..` or a drive prefix are rejected (`400`). Returns `{exitCode,stdout,stderr,stdoutTruncated,stderrTruncated}`; nonzero exit is still `200` |
| `GET` | `/api/pacs` | List PACS servers an admin registered | Returns `{"servers":[{"name","host","port","aet"}],"callingAET"}`; empty list when none |
| `POST` | `/api/pacs/{name}/send` | Send a file to the named PACS (DICOM C-STORE) | Body `{"path":"/Share/file","tags":{"PatientName":"Doe^Jane",...}}`. See *Send to PACS* below. `200 {ok:true,wrapped}` on success, `502` when the PACS refused (`{error,exitCode,output}`), `503` without DCMTK |
| `POST` | `/__login` | Sign in (form post) | Gateway-rendered page; you rarely call this directly |
| `POST` | `/__logout` | End the session | Use for the Sign Out control above |

Error responses are JSON `{"error": "..."}` with a matching HTTP status:

| Status | Meaning |
|--------|---------|
| `400` | Missing/invalid `path` |
| `401` | No/expired session → redirect to `/__login` |
| `403` | Path names no share, escapes a share, or writes to a read-only share |
| `404` | Target does not exist |
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

The bundled `apps/xplore` demo does exactly this: the fetch sits inline in its
`<head>` and its stylesheet carries an `html[data-theme="light"]` block, so the
gateway's dark/light choice and zoom carry into the app.

The endpoint is also served on the gateway's own origin (`/api/platform`) with
`Access-Control-Allow-Origin: *`, which is how a **linked external** app — one
not hosted by the sandbox — can read it.

### Paths are virtual share paths

A `path` is **not** a server filesystem path. It is `/SHARE/sub/dir/file`, where
the **first segment is a share name** from `GET /api/roots` and the rest is
relative to that share, e.g. `/NAS/photos/cat.jpg`. The absolute server-side
location a share maps to is **never** exposed. Paths are always slash-separated,
regardless of the host OS. Anything that names no share, or escapes a share's
root (via `..` or a symlink), is rejected by the jail.

Each share carries a `writable` flag. For a read-only share, `write`, `mkdir`,
and `delete` return `403` — hide those controls when `writable` is false (the
server enforces it regardless; the UI gating is just courtesy).

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

### Thumbnails: one endpoint for images, video and DICOM

Point an `<img>` at `/api/files/thumbnail?path=…` for images, videos and
`.dcm` files — the server decodes JPEG/PNG/GIF itself, pulls video poster
frames with ffmpeg (640 px, cached beside the video; the `w` parameter is
ignored there) and renders DICOM previews through DCMTK's `dcmj2pnm` (source
resolution, 4096 px cap per side, same hidden-file cache).

A DICOM preview is not a thumbnail: browsers cannot decode `.dcm` pixel data,
so this endpoint is also how an app *views* the image full-screen — point the
viewer at it, not at `/api/files/read`. Multiframe instances render their
middle frame, so a video-wrapped `.dcm` shows one still, not playback.

Video frames need ffmpeg on the host, DICOM previews need DCMTK, and both need
the file on local disk; without the tool (or on a `remote` share) the request
answers `415`. Fall
back in the `<img>`'s `onerror`: point a hidden `<video>` at
`/api/files/read?path=…` (HTTP Range, so only the needed bytes are fetched),
seek a second in, and draw it onto a `<canvas>`; for non-video failures show an
icon. See `mediaThumb` and
`captureVideoFrame` in `xplore/app.js` for a working example.

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
  its own values; only your tags change it.
- The gateway calls with its Device title as AE title (`callingAET` in the
  list) — the PACS must accept it. A `502` means the PACS was reached and said
  no (wrong AE title, unsupported SOP class, ...): show `output` to the user.
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
