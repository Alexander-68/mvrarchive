// Thin wrapper over the OmniGate per-app file API. Every call is same-origin and
// authenticated by the app session cookie — no token, no CORS. A 401 means the
// session expired; we bounce to the login page.
//
// Endpoints (see HOW_TO_MAKE_OMNIGATE_WEB_APPS.md):
//   GET    /api/roots                  -> { roots: [{ name, writable }, ...] }
//   GET    /api/files?path=            -> { path, entries: [{name,is_dir,size,mod_time}] }
//   GET    /api/files/read?path=       -> raw bytes (Content-Type: application/octet-stream)
//   PUT    /api/files/write?path=      -> { path, bytes }
//   POST   /api/files/mkdir?path=      -> { path, created }
//   DELETE /api/files/delete?path=     -> { path, deleted }
//
// NOTE: read returns the whole file (no HTTP Range) and is capped at 32 MiB
// server-side. Fine for images and PDFs; large videos need a future streaming
// endpoint (tracked in the implementation plan).
(function () {
  "use strict";
  const MVR = (window.MVR = window.MVR || {});

  const MIME = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
    heif: "image/heif", heic: "image/heic",
    mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
    mkv: "video/x-matroska", m4v: "video/mp4",
    pdf: "application/pdf",
    yaml: "text/yaml", yml: "text/yaml", json: "application/json", txt: "text/plain",
  };

  function mimeFor(name) {
    return MIME[MVR.path.extname(name)] || "application/octet-stream";
  }

  async function req(method, url, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) opts.body = body;
    const res = await fetch(url, opts);
    if (res.status === 401) {
      location.href = "/__login";
      throw new Error("session expired");
    }
    return res;
  }

  async function reqJSON(method, url, body) {
    const res = await req(method, url, body);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
  }

  const q = (path) => `?path=${encodeURIComponent(path)}`;

  // Same-origin, cookie-authenticated URLs that can be used directly as the
  // src of <img>/<video>/<iframe>. read streams and honours HTTP Range (so
  // <video> seeks natively); thumbnail returns a small JPEG for images.
  function fileURL(path) { return "/api/files/read" + q(path); }
  function thumbURL(path, w) { return "/api/files/thumbnail" + q(path) + (w ? `&w=${w}` : ""); }

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

  // /api/roots now returns named shares. The app uses virtual paths of the form
  // /SHARE/subdir for every API call; older absolute-path gateways are tolerated
  // so local deployments are not forced to upgrade in lockstep.
  async function roots() {
    const d = await reqJSON("GET", "/api/roots");
    return (d.roots || [])
      .map(normalizeRoot)
      .filter(Boolean);
  }

  async function list(path) {
    const d = await reqJSON("GET", "/api/files" + q(path));
    return d.entries || [];
  }

  async function readText(path) {
    const res = await req("GET", "/api/files/read" + q(path));
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || `${res.status}`);
    }
    return res.text();
  }

  // readBlob returns a Blob re-typed by the file's extension, because the server
  // always sends application/octet-stream and <img>/<video> need a real MIME.
  async function readBlob(path, name) {
    const res = await req("GET", "/api/files/read" + q(path));
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

  // --- mutating endpoints (used from Phase 2 onward) ---
  async function writeText(path, text) {
    return reqJSON("PUT", "/api/files/write" + q(path), text);
  }
  async function mkdir(path) {
    return reqJSON("POST", "/api/files/mkdir" + q(path));
  }
  async function del(path) {
    return reqJSON("DELETE", "/api/files/delete" + q(path));
  }

  MVR.api = { roots, list, readText, readBlob, objectURL, fileURL, thumbURL, writeText, mkdir, del, mimeFor };
})();
