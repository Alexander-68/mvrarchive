// Thin wrapper over the OmniGate per-app file API. Every call is same-origin and
// authenticated by the app session cookie — no token, no CORS. A 401 means the
// session expired; we bounce to the login page.
//
// Endpoints (see HOW_TO_MAKE_OMNIGATE_WEB_APPS.md):
//   GET    /api/platform               -> { platform, product, version, theme, zoom, inactivityMinutes }
//   GET    /api/me                     -> { username, role, admin }
//   GET    /api/roots                  -> { roots: [{ name, writable, search, erase }, ...] }
//   GET    /api/files?path=&limit=&cursor= -> { path, entries: [{name,is_dir,size,mod_time}], next_cursor }
//   GET    /api/files/read?path=       -> raw bytes (streams, honours Range)
//   GET    /api/files/thumbnail?path=  -> JPEG thumbnail
//   GET    /api/files/payload?path=    -> JPEG/MP4/PDF wrapped in a DICOM file, served in place (Range OK)
//   POST   /api/files/mkdir?path=      -> { path, created }
//   DELETE /api/files/delete?path=     -> { path, deleted, permanent? }  (permanent: admin on Cloud PACS)
//   POST   /api/files/copy?src=&dst=   -> { src, dst, copied }   (recursive, across shares)
//   GET    /api/pacs                   -> { servers: [{ name, host, port, aet }], callingAET }
//   POST   /api/pacs/{name}/send       -> { ok, wrapped } | 502 { error, exitCode, output }
(function () {
  "use strict";
  const MVR = (window.MVR = window.MVR || {});

  async function req(method, url, body, headers, signal) {
    const opts = { method, headers: {}, signal };
    if (body !== undefined) opts.body = body;
    if (headers) Object.assign(opts.headers, headers);
    const res = await fetch(url, opts);
    if (res.status === 401) {
      // Same ?next= round-trip the gateway does, so the user lands back on the study.
      location.href = "__login?next=" + encodeURIComponent((location.pathname || "") + (location.search || ""));
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
  // Callers cancel when their view goes away. Sustained 429/502/503/504
  // (cloud or a local busy renderer) gives up after 5 retries and rejects, so
  // the tile shows Retry; network errors keep retrying.
  async function thumbnail(path, width, signal) {
    for (let busy = 0; ;) {
      signal?.throwIfAborted();
      let res;
      const attemptSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000);
      try { res = await req("GET", thumbURL(path, width), undefined, undefined, attemptSignal); }
      catch (err) {
        if (signal?.aborted || err.message === "session expired") throw err;
        await retryWait(1000, signal);
        continue;
      }
      if ([429, 502, 503, 504].includes(res.status) && busy++ < 5) {
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
  function dicomFrames(path, signal) { return getJSONRetry("api/files/dicom-frames" + q(path), signal); }
  // probePayload requests one byte of the payload (body cancelled): enough to
  // read its Content-Type, or the reason for a 403. <img> errors hide HTTP
  // response bodies, and a full read would download a whole video.
  async function probePayload(path) {
    try {
      const res = await req("GET", payloadURL(path), undefined, { Range: "bytes=0-0" }, AbortSignal.timeout(5000));
      if (res.status === 403) return { error: (await res.json().catch(() => ({}))).error };
      await res.body?.cancel();
      return { type: res.ok ? (res.headers.get("Content-Type") || "").toLowerCase() : "" };
    } catch (_) { return {}; } // network/other failures keep the generic message and a still
  }
  // dicomLoadError: the reason a .dcm failed to load, when it is activation.
  async function dicomLoadError(path) {
    const { error } = await probePayload(path);
    return error === "DICOM is not activated" ? error : "";
  }
  // dicomPayloadKind: what a .dcm encapsulates, "video" (MP4), "pdf", else "image".
  async function dicomPayloadKind(path) {
    const { type = "" } = await probePayload(path);
    return type.startsWith("video/") ? "video" : type.startsWith("application/pdf") ? "pdf" : "image";
  }
  // The bytes a browser can play: the encapsulated payload for a .dcm, else the file.
  function mediaURL(path) { return /\.(dcm|dicom)$/i.test(path) ? payloadURL(path) : fileURL(path); }

  function sharePath(name) {
    const s = String(name || "").trim().replace(/^\/+|\/+$/g, "");
    return s ? `/${s}` : "";
  }

  // /priv_data is the hosted app's private store (data/apps_data/<id>), not a
  // share users browse. Keep it out of the storage selector and deep links.
  const isPrivateRoot = (root) => root.toLowerCase() === "/priv_data";

  // /api/me reports current authenticated user info
  // admin (from /api/me) lets canDelete allow permanent delete on erase roots.
  let admin = false;
  async function me() {
    const d = await reqJSON("GET", "api/me").catch(() => ({}));
    admin = !!(d && (d.admin || d.role === "admin"));
    return d;
  }

  // /api/roots returns named shares. The app uses virtual paths of the form
  // /SHARE/subdir for every API call.
  // readOnly collects the shares whose writable flag is false, so the UI can
  // hide Delete/Paste/Restore there (the server enforces 403 regardless).
  // /priv_data is the app's own store and is never surfaced to users.
  // searchable collects shares listed by search (Cloud PACS; roots[].search).
  // erasable collects read-only shares an admin may delete from permanently
  // (Cloud PACS; roots[].erase).
  const readOnly = new Set(), searchable = new Set(), erasable = new Set();
  async function roots() {
    const d = await reqJSON("GET", "api/roots");
    readOnly.clear();
    searchable.clear();
    erasable.clear();
    const visible = [];
    for (const r of d.roots || []) {
      const root = sharePath(r?.name);
      if (!root || isPrivateRoot(root)) continue;
      if (r.writable === false) readOnly.add(root);
      if (r.search) searchable.add(root);
      if (r.erase) erasable.add(root);
      visible.push(root);
    }
    return visible;
  }

  // GET JSON, retrying 429/503 (Retry-After, 1-6 s, 5 times) with abortable
  // waits. Safe reads only; never replay writes, copy or PACS send.
  async function getJSONRetry(url, signal) {
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      const res = await req("GET", url, undefined, undefined, signal);
      if ((res.status === 429 || res.status === 503) && attempt < 5) {
        const seconds = Math.min(6, Math.max(1, Number(res.headers.get("Retry-After")) || 1));
        if (res.body) await res.body.cancel();
        await retryWait(seconds * 1000, signal);
        continue;
      }
      const data = await res.json().catch(err => { if (res.ok) throw err; return {}; });
      if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
      return data;
    }
  }

  // Follow every directory page; archive search and study counts need the full
  // listing. Legacy gateways without next_cursor still return one complete page.
  // With deleted=true return the directory's
  // deleted (trashed) entries instead, each carrying original_name/deleted_at
  // while name is the on-disk trash name to use in paths.
  // filter ({StudyDate, PatientName, ...}) searches a Cloud PACS root; the
  // result array carries .truncated when OmniGate capped it (read it before
  // slicing/spreading, which drops the property). Entries are de-duplicated by name.
  async function list(path, deleted, signal, filter) {
    const entries = [], seen = new Set(), names = new Set();
    const search = Object.entries(filter || {}).map(([k, v]) => `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("");
    let cursor = "";
    do {
      const url = "api/files" + q(path) + "&limit=256" + (deleted ? "&deleted=1" : "") + search
        + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
      const d = await getJSONRetry(url, signal);
      if (!Array.isArray(d.entries || []) || (d.next_cursor != null && typeof d.next_cursor !== "string")) {
        throw new Error("invalid directory page");
      }
      for (const e of d.entries || []) if (!names.has(e.name)) { names.add(e.name); entries.push(e); }
      if (d.truncated) entries.truncated = true;
      cursor = d.next_cursor || "";
      if (cursor && seen.has(cursor)) throw new Error("directory cursor did not advance");
      // ponytail: page cap stops a server minting endless fresh cursors (~1M entries).
      if (cursor && seen.size >= 4096) throw new Error("directory listing too long");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return entries;
  }

  async function readText(path) {
    const res = await req("GET", "api/files/read" + q(path));
    if (res.ok) return res.text();
    throw new Error((await res.json().catch(() => ({}))).error || `${res.status}`);
  }

  // DICOM tags come from the gateway's DCMTK bridge (dcmdump); jail-marked
  // "in:" arg keeps the path inside the share (network-share inputs are staged
  // to a temp copy by the gateway). Needs DCMTK on the host, else 503.
  async function dicomDump(path) {
    const d = await reqJSON("POST", "api/dcmtk/dcmdump", JSON.stringify({ args: ["in:" + path], timeoutSec: 60 }), { "Content-Type": "application/json" });
    if (d.exitCode) throw new Error((d.stderr || "").trim() || `dcmdump exited ${d.exitCode}`);
    // Pixel-data items are megabytes of hex preview lines; the PixelSequence
    // header line above them already says how many frames there are.
    return (d.stdout || "").split(/\r?\n/).filter((l) => !/^\s*\(fffe,e000\)/.test(l)).join("\n");
  }

  // --- mutating endpoints ---
  async function mkdir(path) {
    return reqJSON("POST", "api/files/mkdir" + q(path));
  }
  async function del(path) {
    return reqJSON("DELETE", "api/files/delete" + q(path));
  }
  // canDelete: writable shares soft-delete (trash); an admin may also delete,
  // permanently, from an erase share. isPermanent says which applies.
  const canDelete = (root) => !readOnly.has(root) || (admin && erasable.has(root));
  const isPermanent = (root) => readOnly.has(root) && canDelete(root);
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

  // summary: a Cloud PACS root's {studies, first, last} (see S.summaryText).
  const summary = (root) => reqJSON("GET", "api/files/summary" + q(root));

  MVR.api = { me, roots, summary, readOnly, searchable, canDelete, isPermanent, list, readText, fileURL, thumbURL, thumbnail, payloadURL, mediaURL, dicomDump, dicomFrames, dicomLoadError, dicomPayloadKind, mkdir, del, restore, copy, pacs, pacsSend };
})();
