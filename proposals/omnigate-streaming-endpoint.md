# Proposal: streaming file endpoint for OmniGate apps

**For:** OmniGate (`C:\Alex\omnigate`) — to be implemented in a separate session.
**Requested by:** MVRarchive, to play recorded videos.
**Status:** proposal.

## Problem

The current read endpoint, `GET /api/files/read`
(`internal/httpapi/handlers_files.go` → `internal/fileprovider/provider.go`):

1. **Caps reads at 32 MiB** (`maxReadSize = 32 << 20`) and rejects anything
   larger, so recorded videos (routinely hundreds of MB) cannot be loaded at all.
2. **Reads the whole file into memory** (`os.ReadFile`) and writes it in one
   shot, with **no HTTP `Range` support**. Even under 32 MiB this means no
   seeking and no progressive playback — the browser must download the entire
   file before `<video>` can start, and dragging the scrub bar re-downloads.
3. Always sends `Content-Type: application/octet-stream`, so the browser can't
   infer the media type (MVRarchive currently works around this by re-typing
   blobs client-side).

This is fine for images/PDFs (small, loaded whole) but blocks video review,
which is a core Archive feature.

## Goal

A same-origin, user-level endpoint that lets `<video controls>` (and `<img>`,
`<embed>`) stream large files with seeking, while keeping the jail's security
guarantees. It should not load whole files into memory.

## Proposed endpoint

```
GET /api/files/stream?path=<path>
```

Behavior:

- **Honor HTTP `Range`.** On a `Range: bytes=START-END` request, reply
  `206 Partial Content` with `Content-Range` and only the requested slice; on a
  plain request reply `200 OK` with the full body. Advertise
  `Accept-Ranges: bytes`.
- **No 32 MiB cap.** Stream from disk; never buffer the whole file. (Optionally
  keep a configurable max, but it must be far above video sizes or absent.)
- **Correct `Content-Type`** inferred from the file extension
  (`mime.TypeByExtension`), falling back to `application/octet-stream`.
- **Same jail + auth** as the existing file API: resolve through the jail,
  reject paths outside an `--allow-dir`, require the app session, reject
  cross-origin — identical to `requireApp` on the other `/api/files/*` routes.
- Set `Content-Length` (full or slice length) and a `Last-Modified` header so
  the browser caches/validates sensibly.

### Implementation sketch (Go)

Go's standard library does almost all of this via `http.ServeContent`, which
handles `Range`, `If-Range`, `Content-Range`, `Content-Length`, status `206`,
and conditional requests automatically given an `io.ReadSeeker`:

```go
// fpStream serves a file with Range support, streaming from disk.
func fpStream(w http.ResponseWriter, r *http.Request, files *fileprovider.Provider) {
    path := r.URL.Query().Get("path")
    if path == "" { writeError(w, http.StatusBadRequest, "missing path"); return }

    f, info, err := files.Open(path) // NEW: jail-resolved *os.File + FileInfo
    if err != nil {
        status, msg := fileErrorStatus(err); writeError(w, status, msg); return
    }
    defer f.Close()
    if info.IsDir() { writeError(w, http.StatusBadRequest, "path is a directory"); return }

    if ct := mime.TypeByExtension(filepath.Ext(info.Name())); ct != "" {
        w.Header().Set("Content-Type", ct)
    }
    // ServeContent adds Accept-Ranges, handles Range/If-Range, sets status 206.
    http.ServeContent(w, r, info.Name(), info.ModTime(), f)
}
```

This needs one new provider method that returns an open, jail-checked file
handle (an `io.ReadSeeker`) instead of a `[]byte`:

```go
// Open resolves reqPath through the jail and returns an open file for streaming.
// Caller must Close it. Mirrors Read()'s jail/stat checks but does not buffer.
func (p *Provider) Open(reqPath string) (*os.File, os.FileInfo, error) {
    real, err := p.jail.resolve(reqPath)
    if err != nil { return nil, nil, err }
    info, err := os.Stat(real)
    if err != nil { return nil, nil, err }
    if info.IsDir() { return nil, nil, ErrIsDir }
    f, err := os.Open(real)
    return f, info, err
}
```

Then register it on **both** the admin server and the app gateway, next to the
existing read route, so semantics match:

```go
// internal/httpapi/appserver.go (AppGateway.Handler)
mux.HandleFunc("GET /api/files/stream",
    g.requireApp(cookie, func(w http.ResponseWriter, r *http.Request) { fpStream(w, r, g.files) }))
```

### Security notes

- Reuses `jail.resolve`, so zip-slip/`..` traversal and out-of-jail paths are
  rejected exactly as today.
- `requireApp` keeps it user-role, same-origin, session-gated.
- Streaming from an `*os.File` bounds memory regardless of file size; no new
  zip-bomb-style exposure.
- `ServeContent` clamps invalid/oversized ranges to the file length and returns
  `416 Range Not Satisfiable` when appropriate — standard, well-tested behavior.

## How MVRarchive will use it

- `<video>`/`<img>`/`<embed>` `src` points straight at
  `/api/files/stream?path=…` (no Blob needed), so the browser does ranged,
  progressive loading and seeking natively.
- Keep `/api/files/read` for small text/metadata (`study_info.yaml`,
  `patient_info.json`) where reading the whole body is simplest.
- Client change is small: in `js/api.js` add a `streamURL(path)` helper and have
  the viewer use it for video (and optionally images/PDF). The 32 MiB error
  message in the viewer can then be removed.

## Open sub-questions

- Keep a (large) size ceiling on streaming, or none?
- Should `read` itself just gain Range support instead of adding a second route?
  A separate `stream` route keeps `read`'s simple "whole small file → bytes"
  contract intact and is less risky; recommended.
- Thumbnails: streaming doesn't generate thumbnails. If full-res image loads
  become a performance issue on large archives, a separate server-side
  thumbnail endpoint (`?w=320`) could be a later proposal — out of scope here.
