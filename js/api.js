// Thin wrapper over the OmniGate per-app file API. Every call is same-origin and
// authenticated by the app session cookie — no token, no CORS. A 401 means the
// session expired; we bounce to the login page.
//
// Endpoints (see HOW_TO_MAKE_OMNIGATE_WEB_APPS.md):
//   GET    /api/platform               -> { platform, product, version, theme, zoom, inactivityMinutes }
//   GET    /api/me                     -> { username, role }
//   GET    /api/roots                  -> { roots: [{ name, writable }, ...] }
//   GET    /api/files?path=&limit=&cursor= -> { path, entries: [{name,is_dir,size,mod_time}], next_cursor }
//   GET    /api/files/read?path=       -> raw bytes (streams, honours Range)
//   GET    /api/files/thumbnail?path=  -> JPEG thumbnail
//   GET    /api/files/payload?path=    -> JPEG/MP4/PDF wrapped in a DICOM file, served in place (Range OK)
//   PUT    /api/files/write?path=      -> { path, bytes }
//   POST   /api/files/mkdir?path=      -> { path, created }
//   DELETE /api/files/delete?path=     -> { path, deleted }
//   POST   /api/files/copy?src=&dst=   -> { src, dst, copied }   (recursive, across shares)
//   GET    /api/pacs                   -> { servers: [{ name, host, port, aet }], callingAET }
//   POST   /api/pacs/{name}/send       -> { ok, wrapped } | 502 { error, exitCode, output }
(function () {
  "use strict";
  const MVR = (window.MVR = window.MVR || {});

  const MIME = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
    heif: "image/heif", heic: "image/heic", dcm: "application/dicom", dicom: "application/dicom",
    mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
    mkv: "video/x-matroska", m4v: "video/mp4", avi: "video/x-msvideo",
    wmv: "video/x-ms-wmv", flv: "video/x-flv", mpg: "video/mpeg",
    mpeg: "video/mpeg", ts: "video/mp2t", m2ts: "video/mp2t", mts: "video/mp2t",
    "3gp": "video/3gpp", ogv: "video/ogg",
    pdf: "application/pdf",
    yaml: "text/yaml", yml: "text/yaml", json: "application/json", txt: "text/plain",
  };

  function mimeFor(name) {
    return MIME[MVR.path.extname(name)] || "application/octet-stream";
  }

  async function req(method, url, body, headers, signal) {
    const opts = { method, headers: {}, signal };
    if (body !== undefined) opts.body = body;
    if (headers) Object.assign(opts.headers, headers);
    const res = await fetch(url, opts);
    if (res.status === 401) {
      location.href = "__login";
      throw new Error("session expired");
    }
    return res;
  }

  async function reqJSON(method, url, body, headers, signal) {
    const res = await req(method, url, body, headers, signal);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
  }

  const q = (path) => `?path=${encodeURIComponent(path)}`;

  // Same-origin, cookie-authenticated URLs that can be used directly as the
  // src of <img>/<video>/<iframe>. read streams and honours HTTP Range (so
  // <video> seeks natively); thumbnail returns a small JPEG for images.
  function fileURL(path) { return "api/files/read" + q(path); }
  function thumbURL(path, w) { return "api/files/thumbnail" + q(path) + (w ? `&w=${w}` : ""); }
  function retryWait(ms, signal) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
      const timer = setTimeout(finish, ms);
      const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  // A busy renderer is temporary, never a missing preview. Callers cancel
  // when their view goes away; only permanent failures reach the Retry UI.
  async function thumbnail(path, width, signal) {
    for (;;) {
      signal?.throwIfAborted();
      let res;
      const attemptSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000);
      try { res = await req("GET", thumbURL(path, width), undefined, undefined, attemptSignal); }
      catch (err) {
        if (signal?.aborted || err.message === "session expired") throw err;
        await retryWait(1000, signal);
        continue;
      }
      if ([429, 502, 503, 504].includes(res.status)) {
        const seconds = Math.min(5, Math.max(0.1, Number(res.headers.get("Retry-After")) || 1));
        await res.body?.cancel();
        await retryWait(seconds * 1000, signal);
        continue;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw Object.assign(new Error(data.error || `Preview failed (${res.status})`), { status: res.status });
      }
      try { return await res.blob(); }
      catch (err) {
        signal?.throwIfAborted();
        await retryWait(1000, signal);
      }
    }
  }
  // The JPEG, MP4 or PDF encapsulated in a .dcm, header skipped server-side
  // (415 for anything else, e.g. uncompressed pixel data).
  function payloadURL(path) { return "api/files/payload" + q(path); }
  function dicomFrames(path, signal) { return reqJSON("GET", "api/files/dicom-frames" + q(path), undefined, undefined, signal); }
  // <img> errors hide HTTP response bodies. Probe only after a failed DICOM
  // load; request one byte and cancel successful bodies rather than downloading
  // an entire encapsulated video/image merely to diagnose an error.
  async function dicomLoadError(path) {
    try {
      const res = await req("GET", payloadURL(path), undefined, { Range: "bytes=0-0" }, AbortSignal.timeout(5000));
      if (res.status === 403) {
        const data = await res.json();
        return data.error === "DICOM is not activated" ? data.error : "";
      }
      if (res.body) await res.body.cancel();
    } catch (_) { /* retain generic load error for network/other failures */ }
    return "";
  }
  // The bytes a browser can play: the encapsulated payload for a .dcm, else the file.
  function mediaURL(path) { return /\.(dcm|dicom)$/i.test(path) ? payloadURL(path) : fileURL(path); }

  function isSystemAbsolutePath(path) {
    return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path);
  }

  function sharePath(name) {
    const s = String(name || "").trim().replace(/^\/+|\/+$/g, "");
    return s ? `/${s}` : "";
  }

  function normalizeRoot(root) {
    if (typeof root === "string") {
      if (!root) return "";
      if (root.startsWith("/") || isSystemAbsolutePath(root)) return root;
      return sharePath(root);
    }
    if (!root) return "";
    if (root.name) return sharePath(root.name);
    return normalizeRoot(root.path);
  }

  // /api/me reports current authenticated user info
  async function me() {
    return reqJSON("GET", "api/me").catch(() => ({}));
  }

  // /api/roots returns named shares. The app uses virtual paths of the form
  // /SHARE/subdir for every API call; older absolute-path gateways are tolerated
  // so local deployments are not forced to upgrade in lockstep.
  // readOnly collects the shares whose writable flag is false, so the UI can
  // hide Delete/Paste/Restore there (the server enforces 403 regardless).
  const readOnly = new Set();
  async function roots() {
    const d = await reqJSON("GET", "api/roots");
    readOnly.clear();
    for (const r of d.roots || []) if (r && r.writable === false) readOnly.add(normalizeRoot(r));
    return (d.roots || [])
      .map(normalizeRoot)
      .filter(Boolean);
  }

  // Follow every directory page; archive search and study counts need the full
  // listing. Legacy gateways without next_cursor still return one complete page.
  // With deleted=true return the directory's
  // deleted (trashed) entries instead, each carrying original_name/deleted_at
  // while name is the on-disk trash name to use in paths.
  async function list(path, deleted, signal) {
    const entries = [], seen = new Set();
    let cursor = "";
    do {
      const url = "api/files" + q(path) + "&limit=256" + (deleted ? "&deleted=1" : "")
        + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
      let d;
      for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        const res = await req("GET", url, undefined, undefined, signal);
        // Retry safe listing reads only; never replay writes, copy or PACS send.
        if ((res.status === 429 || res.status === 503) && attempt < 5) {
          const seconds = Math.min(6, Math.max(1, Number(res.headers.get("Retry-After")) || 1));
          if (res.body) await res.body.cancel();
          await new Promise(resolve => setTimeout(resolve, seconds * 1000));
          continue;
        }
        d = await res.json().catch(err => { if (res.ok) throw err; return {}; });
        if (!res.ok) throw new Error(d.error || `${res.status} ${res.statusText}`);
        break;
      }
      if (!Array.isArray(d.entries || []) || (d.next_cursor != null && typeof d.next_cursor !== "string")) {
        throw new Error("invalid directory page");
      }
      entries.push(...(d.entries || []));
      cursor = d.next_cursor || "";
      if (cursor && seen.has(cursor)) throw new Error("directory cursor did not advance");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return entries;
  }

  async function readText(path) {
    const res = await req("GET", "api/files/read" + q(path));
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || `${res.status}`);
    }
    return res.text();
  }

  // readBlob returns a Blob re-typed by the file's extension, because the server
  // always sends application/octet-stream and <img>/<video> need a real MIME.
  async function readBlob(path, name) {
    const res = await req("GET", "api/files/read" + q(path));
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || `${res.status}`);
    }
    const buf = await res.arrayBuffer();
    return new Blob([buf], { type: mimeFor(name || path) });
  }

  async function objectURL(path, name) {
    const blob = await readBlob(path, name);
    return URL.createObjectURL(blob);
  }

  // DICOM tags come from the gateway's DCMTK bridge (dcmdump); jail-marked
  // "in:" arg keeps the path inside the share. Needs DCMTK on the host and a
  // local (non-remote) share, else the call answers 503/415.
  async function dicomDump(path) {
    const d = await reqJSON("POST", "api/dcmtk/dcmdump", JSON.stringify({ args: ["in:" + path], timeoutSec: 60 }), { "Content-Type": "application/json" });
    if (d.exitCode) throw new Error((d.stderr || "").trim() || `dcmdump exited ${d.exitCode}`);
    // Pixel-data items are megabytes of hex preview lines; the PixelSequence
    // header line above them already says how many frames there are.
    return (d.stdout || "").split(/\r?\n/).filter((l) => !/^\s*\(fffe,e000\)/.test(l)).join("\n");
  }

  // --- mutating endpoints ---
  async function writeText(path, text) {
    return reqJSON("PUT", "api/files/write" + q(path), text);
  }
  async function mkdir(path) {
    return reqJSON("POST", "api/files/mkdir" + q(path));
  }
  async function del(path) {
    return reqJSON("DELETE", "api/files/delete" + q(path));
  }
  // restore renames a trashed entry (its trash path) back to its original name.
  async function restore(path) {
    return reqJSON("POST", "api/files/restore" + q(path));
  }
  // copy duplicates src as dst (dst is the new entry's full path; 409 if it exists).
  async function copy(src, dst) {
    return reqJSON("POST", `api/files/copy?src=${encodeURIComponent(src)}&dst=${encodeURIComponent(dst)}`);
  }

  // --- PACS (DICOM C-STORE via the gateway) ---
  async function pacs() {
    const d = await reqJSON("GET", "api/pacs").catch(() => ({}));
    return d.servers || [];
  }
  // pacsSend ships one JPEG/BMP/DICOM file to the named server with the given tags.
  async function pacsSend(name, path, tags) {
    const res = await req("POST", `api/pacs/${encodeURIComponent(name)}/send`, JSON.stringify({ path, tags }), { "Content-Type": "application/json" });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((d.output || "").trim() || d.error || `${res.status} ${res.statusText}`);
    return d;
  }

  MVR.api = { me, roots, readOnly, list, readText, readBlob, objectURL, fileURL, thumbURL, thumbnail, payloadURL, mediaURL, dicomDump, dicomFrames, dicomLoadError, writeText, mkdir, del, restore, copy, pacs, pacsSend, mimeFor };
})();
