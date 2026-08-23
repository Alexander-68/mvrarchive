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
| `GET` | `/api/files?path=` | List a directory | Returns `{"path","entries":[{name,is_dir,size,mod_time}]}` |
| `GET` | `/api/files/read?path=` | Read a file | Streams; honours `Range` (seek/resume, in-browser video frames) |
| `GET` | `/api/files/thumbnail?path=&w=` | JPEG thumbnail of an **image, video or DICOM file** | `w` defaults to 320, capped at 2048, never upscales; videos are fixed at 640 and need ffmpeg (else `415`); `.dcm`/`.dicom` previews come at source resolution, capped at 4096 px per side, and need DCMTK (else `415`) |
| `PUT` | `/api/files/write?path=` | Write/create a file | Raw request body is the file content (≤ 32 MiB) |
| `POST` | `/api/files/mkdir?path=` | Create a folder | Creates missing parents |
| `DELETE` | `/api/files/delete?path=` | Delete a file or folder | Recursive; cannot delete a share root |
| `GET` | `/api/dcmtk` | List available DCMTK tools | `503` when DCMTK is not installed on the gateway host |
| `POST` | `/api/dcmtk/{tool}` | Run a DCMTK tool | Body `{"args":[...],"timeoutSec":60}`. Mark jail files as `in:/Share/path` / `out:/Share/path` (out needs a writable share); other args pass verbatim, but unmarked args containing `/`, `\`, `..` or a drive prefix are rejected (`400`). Returns `{exitCode,stdout,stderr,stdoutTruncated,stderrTruncated}`; nonzero exit is still `200` |
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
