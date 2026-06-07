// MVRarchive UI controller: archive grid (browse + search), study detail
// (media + metadata), and the fullscreen media viewer.
//
// Navigation (no on-screen help — intuitive keys):
//   Arrows  move the focus cursor (grid: left/right within a row, up/down rows;
//           viewer: left/right = prev/next file)
//   Enter   go in   (focused study -> detail, focused media -> viewer)
//   Esc     go out  (viewer -> detail, detail -> archive; in archive clears search)
//   Space   select / unselect the focused item
//   Mouse   click to focus+open; wheel zooms the viewer image; drag pans it
//   Touch   tap to open; swipe left/right in the viewer changes file
(function () {
  "use strict";
  const MVR = window.MVR;
  const { api, study: S } = MVR;
  const $ = (sel) => document.querySelector(sel);

  const state = {
    view: "archive",     // "archive" | "study"
    root: "",
    studies: [],         // current root's studies (sorted newest-first)
    query: "",
    focus: 0,            // index into visible studies
    current: null,       // study open in detail view
    mediaFocus: 0,       // index into current.media
    tileSize: 160,       // detail media-tile min width (px), wheel/pinch adjustable
    pinch: null,         // active pinch gesture in the media grid
    viewer: { study: null, media: [], index: 0, open: false, img: null,
              scale: 1, tx: 0, ty: 0, drag: null, touch: null, seq: 0 },
  };

  // ---- small DOM helpers ----------------------------------------------------
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function icon(name, cls) {
    const img = el("img", cls || "");
    img.src = `assets/icons/${name}.svg`;
    img.alt = "";
    return img;
  }
  // captureVideoFrame grabs a poster frame from a video by streaming just enough
  // of it (read honours Range), seeking ~1s in, and drawing to a canvas. The
  // thumbnail endpoint is images-only, so this is how video tiles get a preview.
  // Resolves to a data URL, or null if anything fails.
  function captureVideoFrame(url, w) {
    return new Promise((resolve) => {
      const v = document.createElement("video");
      v.muted = true; v.preload = "metadata"; v.src = url;
      let settled = false;
      const finish = (val) => { if (settled) return; settled = true; v.removeAttribute("src"); resolve(val); };
      v.onloadeddata = () => { try { v.currentTime = Math.min(1, (v.duration || 2) / 2); } catch (e) { finish(null); } };
      v.onseeked = () => {
        try {
          if (!v.videoWidth) return finish(null);
          const cw = w || 400, ch = Math.round(cw * (v.videoHeight / v.videoWidth));
          const c = document.createElement("canvas"); c.width = cw; c.height = ch;
          c.getContext("2d").drawImage(v, 0, 0, cw, ch);
          finish(c.toDataURL("image/jpeg", 0.8));
        } catch (e) { finish(null); }
      };
      v.onerror = () => finish(null);
      setTimeout(() => finish(null), 8000);
    });
  }

  let toastTimer = null;
  function toast(msg, isError) {
    const t = $("#toast");
    t.textContent = msg;
    t.className = "toast" + (isError ? " error" : "");
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3500);
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---- view switching -------------------------------------------------------
  function showArchive() {
    state.view = "archive";
    $("#view-study").hidden = true;
    $("#view-archive").hidden = false;
    state.current = null;
    updateArchiveFocus();
  }
  function showStudy() {
    state.view = "study";
    $("#view-archive").hidden = true;
    $("#view-study").hidden = false;
  }

  // ---- concurrency pool -----------------------------------------------------
  async function pool(items, limit, worker) {
    let i = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try { await worker(items[idx], idx); } catch (e) { /* keep going */ }
      }
    });
    await Promise.all(runners);
  }

  // ---- archive grid ---------------------------------------------------------
  async function loadArchive(root) {
    state.root = root;
    showArchive();
    const grid = $("#grid");
    grid.innerHTML = "";
    $("#grid-empty").hidden = true;
    $("#study-count").textContent = "Loading…";
    refreshStatusRight();

    let entries;
    try {
      entries = await api.list(root);
    } catch (e) {
      $("#study-count").textContent = "";
      toast("Could not list storage: " + e.message, true);
      return;
    }

    const folders = entries
      .filter((e) => e.is_dir && S.isStudyFolder(e.name))
      .sort((a, b) => (Date.parse(b.mod_time) || 0) - (Date.parse(a.mod_time) || 0));

    state.studies = folders.map((e) => S.newStudy(root, e));
    state.focus = 0;
    $("#grid-empty").hidden = state.studies.length > 0;

    for (const study of state.studies) {
      study.cardEl = buildCard(study);
      grid.appendChild(study.cardEl);
    }
    applySearch();
    updateArchiveFocus();

    let done = 0;
    const total = state.studies.length;
    const tick = () => ($("#study-count").textContent =
      `${total} stud${total === 1 ? "y" : "ies"}` + (done < total ? ` · loading ${done}/${total}…` : ""));
    tick();

    await pool(state.studies, 4, async (study) => {
      await S.hydrate(study);
      fillCard(study);
      done++; tick();
      applySearch();
    });
  }

  function buildCard(study) {
    const card = el("div", "card");
    card.dataset.folder = study.folderName;
    card.innerHTML = `
      <div class="card-thumb loading"></div>
      <div class="card-body">
        <div class="card-title">${escapeHTML(study.folderName)}</div>
        <div class="card-date muted">—</div>
        <div class="card-meta"></div>
        <div class="card-sub"></div>
      </div>`;
    card.onclick = () => { setArchiveFocus(visibleStudies().indexOf(study)); openStudy(study); };
    return card;
  }

  function metaItem(iconName, value) {
    const s = el("span", "mi");
    s.appendChild(icon(iconName));
    s.appendChild(el("span", null, String(value)));
    return s;
  }
  function subItem(iconName, value) {
    const s = el("span", "si");
    s.appendChild(icon(iconName));
    s.appendChild(el("span", null, String(value)));
    return s;
  }

  function fillCard(study) {
    const card = study.cardEl;
    if (!card) return;
    card.querySelector(".card-title").textContent = S.displayName(study);
    card.querySelector(".card-date").textContent = S.formatDate(S.studyDate(study)) || "";

    const c = study.counters;
    const meta = card.querySelector(".card-meta");
    meta.innerHTML = "";
    meta.appendChild(metaItem("ic_image", c.images));
    meta.appendChild(metaItem("ic_video", c.videos));
    if (c.pdfs) meta.appendChild(metaItem("ic_pdf", c.pdfs));
    if (c.size) meta.appendChild(el("span", "mi", S.fmtSize(c.size)));

    const sub = card.querySelector(".card-sub");
    sub.innerHTML = "";
    const i = study.info || {};
    const sid = i.StudyID || (S.parseStampName(study.folderName) || {}).studyId;
    if (sid) sub.appendChild(subItem("ic_id", sid));
    const dob = S.formatDOB(i);
    if (dob) sub.appendChild(subItem("ic_birthday", dob));

    // Thumbnail: server JPEG of the first image; if the study has only video,
    // capture a poster frame. Nothing is drawn over it.
    const thumb = card.querySelector(".card-thumb");
    const setThumb = (src) => {
      const img = el("img", "thumb-img");
      img.src = src;
      img.onload = () => { thumb.classList.remove("loading"); thumb.appendChild(img); };
      img.onerror = () => { thumb.classList.remove("loading"); addPlaceholder(thumb); };
    };
    if (study.thumbFile) {
      setThumb(api.thumbURL(study.thumbFile.path, 400));
    } else {
      const vid = study.media.find((m) => m.kind === "video");
      if (vid) {
        captureVideoFrame(api.fileURL(vid.path), 400).then((data) => {
          if (data) setThumb(data); else { thumb.classList.remove("loading"); addPlaceholder(thumb); }
        });
      } else {
        thumb.classList.remove("loading");
        addPlaceholder(thumb);
      }
    }
  }

  function addPlaceholder(thumb) {
    if (thumb.querySelector(".placeholder")) return;
    thumb.appendChild(icon("ic_study", "placeholder"));
  }

  // ---- search ---------------------------------------------------------------
  function applySearch() {
    const q = state.query;
    let visible = 0;
    for (const study of state.studies) {
      if (!study.cardEl) continue;
      const show = S.matches(study, q);
      study.cardEl.hidden = !show;
      if (show) visible++;
    }
    $("#search-clear").hidden = !q;
    if (q) {
      $("#grid-empty").hidden = visible > 0;
      $("#study-count").textContent = `${visible} of ${state.studies.length} match “${q}”`;
    } else {
      $("#grid-empty").hidden = state.studies.length > 0;
    }
    refreshStatusRight();
    if (state.view === "archive") updateArchiveFocus();
  }

  function refreshStatusRight() {
    const sel = state.studies.filter((s) => s.marked).length;
    $("#free-space").textContent = sel ? `${sel} selected` : state.root;
  }

  // ---- archive focus cursor -------------------------------------------------
  function visibleStudies() {
    return state.studies.filter((s) => s.cardEl && !s.cardEl.hidden);
  }
  function columnCount(els) {
    if (els.length < 2) return 1;
    const top = els[0].offsetTop;
    let n = 1;
    while (n < els.length && Math.abs(els[n].offsetTop - top) < 2) n++;
    return n;
  }
  function setArchiveFocus(i) {
    const vis = visibleStudies();
    if (!vis.length) { state.focus = 0; return; }
    state.focus = Math.max(0, Math.min(i, vis.length - 1));
    updateArchiveFocus();
  }
  function updateArchiveFocus() {
    state.studies.forEach((s) => s.cardEl && s.cardEl.classList.remove("focused"));
    const vis = visibleStudies();
    if (!vis.length) return;
    state.focus = Math.max(0, Math.min(state.focus, vis.length - 1));
    const elc = vis[state.focus].cardEl;
    elc.classList.add("focused");
    elc.scrollIntoView({ block: "nearest" });
  }
  function moveArchiveFocus(dir) {
    const vis = visibleStudies();
    if (!vis.length) return;
    const cols = columnCount(vis.map((s) => s.cardEl));
    let i = state.focus;
    if (dir === "left") i--;
    else if (dir === "right") i++;
    else if (dir === "up") i -= cols;
    else if (dir === "down") i += cols;
    if (i < 0 || i >= vis.length) return;
    state.focus = i;
    updateArchiveFocus();
  }

  // ---- study detail ---------------------------------------------------------

  // The prev/next set is the studies visible after search; if more than one
  // study is selected, navigation is confined to the selection instead (a
  // single selection is ignored, so it behaves like "all visible").
  function studyNavList() {
    const vis = visibleStudies();
    const sel = vis.filter((s) => s.marked);
    return sel.length > 1 ? sel : vis;
  }
  function navStudy(dir) {
    const list = studyNavList();
    if (!list.length) return;
    let idx = list.indexOf(state.current);
    if (idx === -1) idx = dir > 0 ? -1 : list.length; // not in list: enter at an end
    const ni = idx + dir;
    if (ni < 0 || ni >= list.length) return;
    openStudy(list[ni]);
  }
  function updateStudyNavButtons() {
    const list = studyNavList();
    const idx = list.indexOf(state.current);
    const inList = idx >= 0;
    $("#btn-prev-study").disabled = inList ? idx <= 0 : list.length === 0;
    $("#btn-next-study").disabled = inList ? idx >= list.length - 1 : list.length === 0;
  }

  async function openStudy(study) {
    state.current = study;
    showStudy();
    $("#detail-title").textContent = S.displayName(study);

    if (!study.hydrated) {
      $("#detail-sub").textContent = "Loading…";
      try { await S.hydrate(study); } catch (e) { toast(e.message, true); }
    }
    const c = study.counters;
    const bits = [S.formatDate(S.studyDate(study))];
    bits.push(`${c.images} image${c.images === 1 ? "" : "s"}`, `${c.videos} video${c.videos === 1 ? "" : "s"}`);
    if (c.pdfs) bits.push(`${c.pdfs} report${c.pdfs === 1 ? "" : "s"}`);
    $("#detail-sub").textContent = bits.filter(Boolean).join(" · ");

    state.mediaFocus = 0;
    renderMedia(study);
    renderInfo(study);
    updateMediaFocus();
    updateStudyNavButtons();
  }

  function applyTileSize() {
    $("#media-grid").style.gridTemplateColumns = `repeat(auto-fill, minmax(${state.tileSize}px, 1fr))`;
  }
  function zoomTiles(deltaPx) {
    state.tileSize = Math.max(96, Math.min(440, state.tileSize + deltaPx));
    applyTileSize();
  }

  function renderMedia(study) {
    const grid = $("#media-grid");
    grid.innerHTML = "";
    applyTileSize();
    $("#media-empty").hidden = study.media.length > 0;

    study.media.forEach((m, idx) => {
      const tile = el("div", "media-tile");
      m.tileEl = tile;
      // Single compact caption, e.g. "IMAGE, I0002.jpg".
      tile.appendChild(el("span", "cap", `${m.kind.toUpperCase()}, ${m.name}`));
      const ic = icon(m.kind === "video" ? "ic_video" : m.kind === "pdf" ? "ic_pdf" : "ic_image", "ic");
      tile.appendChild(ic);
      const setTilePreview = (src) => {
        const img = el("img");
        img.src = src;
        img.onload = () => { tile.insertBefore(img, tile.firstChild); ic.remove(); };
      };
      if (m.kind === "image") {
        setTilePreview(api.thumbURL(m.path, 400));
      } else if (m.kind === "video") {
        captureVideoFrame(api.fileURL(m.path), 400).then((data) => { if (data) setTilePreview(data); });
      }
      tile.onclick = () => { setMediaFocus(idx); openViewer(study, idx); };
      grid.appendChild(tile);
    });
  }

  function setMediaFocus(i) {
    const n = state.current ? state.current.media.length : 0;
    if (!n) return;
    state.mediaFocus = Math.max(0, Math.min(i, n - 1));
    updateMediaFocus();
  }
  function updateMediaFocus() {
    const media = state.current ? state.current.media : [];
    media.forEach((m) => m.tileEl && m.tileEl.classList.remove("focused"));
    if (!media.length) return;
    state.mediaFocus = Math.max(0, Math.min(state.mediaFocus, media.length - 1));
    const t = media[state.mediaFocus].tileEl;
    if (t) { t.classList.add("focused"); t.scrollIntoView({ block: "nearest" }); }
  }
  function moveMediaFocus(dir) {
    const media = state.current ? state.current.media : [];
    if (!media.length) return;
    const cols = columnCount(media.map((m) => m.tileEl));
    let i = state.mediaFocus;
    if (dir === "left") i--;
    else if (dir === "right") i++;
    else if (dir === "up") i -= cols;
    else if (dir === "down") i += cols;
    if (i < 0 || i >= media.length) return;
    state.mediaFocus = i;
    updateMediaFocus();
  }

  function renderInfo(study) {
    const panel = $("#info-panel");
    panel.innerHTML = "";
    panel.appendChild(el("h3", null, "Study information"));
    const info = study.info;
    if (!info) {
      panel.appendChild(el("p", "muted", "No metadata file (study_info.yaml) in this study."));
      return;
    }

    const used = new Set(["PatientFirstName", "PatientMiddleName", "PatientLastName",
      "PatientBirthYear", "PatientBirthMonth", "PatientBirthDay", "AnimalName", "AnatomicRegion"]);

    for (const [groupName, fields] of S.FIELD_GROUPS) {
      const rows = [];
      for (const [key, label] of fields) {
        const val = S.fieldValue(info, key);
        if (!val) continue;
        if (!key.startsWith("__")) used.add(key);
        rows.push([label, val]);
      }
      if (!rows.length) continue;
      panel.appendChild(el("div", "info-section-title", groupName));
      for (const [label, val] of rows) panel.appendChild(infoRow(label, val));
    }

    const extra = Object.keys(info).filter((k) => !used.has(k) && !S.KNOWN_KEYS.has(k))
      .filter((k) => { const v = info[k]; return v !== null && v !== undefined && typeof v !== "object" && String(v) !== ""; });
    if (extra.length) {
      panel.appendChild(el("div", "info-section-title", "Additional"));
      for (const k of extra) panel.appendChild(infoRow(k, String(info[k])));
    }
  }
  function infoRow(label, value) {
    const row = el("div", "info-row");
    row.appendChild(el("span", "k", label));
    row.appendChild(el("span", "v", value));
    return row;
  }

  // ---- selection ------------------------------------------------------------
  function toggleSelectArchive() {
    const vis = visibleStudies();
    const s = vis[state.focus];
    if (!s) return;
    s.marked = !s.marked;
    s.cardEl.classList.toggle("marked", s.marked);
    refreshStatusRight();
  }
  function toggleSelectMedia() {
    const m = state.current && state.current.media[state.mediaFocus];
    if (!m || !m.tileEl) return;
    m.selected = !m.selected;
    m.tileEl.classList.toggle("selected", m.selected);
  }

  // ---- media viewer (zoom / pan / swipe) ------------------------------------
  function openViewer(study, index) {
    state.viewer.study = study;
    state.viewer.media = study.media;
    state.viewer.index = index;
    state.viewer.open = true;
    resetZoomVars();           // fresh open starts unzoomed
    $("#viewer").hidden = false;
    showMedia();
  }
  function closeViewer() {
    state.viewer.open = false;
    $("#viewer").hidden = true;
    clearStage();
    // keep detail focus in sync with where we were
    setMediaFocus(state.viewer.index);
  }
  // clearStage tears down the current media but preserves zoom/pan, so stepping
  // between images keeps the same magnification and position.
  function clearStage() {
    state.viewer.img = null;
    $("#viewer-stage").innerHTML = "";
  }
  function resetZoomVars() {
    state.viewer.scale = 1; state.viewer.tx = 0; state.viewer.ty = 0; state.viewer.drag = null;
  }
  function step(delta) {
    const n = state.viewer.media.length;
    state.viewer.index = (state.viewer.index + delta + n) % n;
    showMedia();
  }
  function viewerLabel(m) {
    const study = state.viewer.study;
    const counter = `(${state.viewer.index + 1}/${state.viewer.media.length})`;
    // patient · folder · file (counter); patient dropped when it would just
    // repeat the folder name (study with no metadata).
    const parts = [];
    if (study) {
      const patient = S.displayName(study);
      if (patient && patient !== study.folderName) parts.push(patient);
      parts.push(study.folderName);
    }
    parts.push(m.name);
    return `${parts.join("  ·  ")}  ${counter}`;
  }
  function decodeImg(img, url) {
    return new Promise((res, rej) => { img.onload = () => res(); img.onerror = rej; img.src = url; });
  }

  async function showMedia() {
    const m = state.viewer.media[state.viewer.index];
    const stage = $("#viewer-stage");
    $("#viewer-name").textContent = viewerLabel(m);
    const hasNav = state.viewer.media.length > 1;
    $("#viewer-prev").style.visibility = hasNav ? "" : "hidden";
    $("#viewer-next").style.visibility = hasNav ? "" : "hidden";

    if (m.kind === "image") return showImage(m, stage);

    // Heavy media: stream straight from the read URL (Range-capable), so video
    // seeks natively and PDFs render with their real content-type.
    clearStage();
    const ext = MVR.path.extname(m.name);
    if (ext === "dcm") {
      stage.appendChild(el("div", "msg", `DICOM files (${m.name}) are not viewable yet — a DICOM decoder is planned for a later phase.`));
      return;
    }
    if (m.kind === "video") {
      const v = document.createElement("video");
      v.src = api.fileURL(m.path); v.controls = true; v.autoplay = true; v.playsInline = true;
      stage.appendChild(v);
    } else if (m.kind === "pdf") {
      const f = document.createElement("iframe");
      f.src = api.fileURL(m.path); stage.appendChild(f);
    }
  }

  // showImage decodes the next image off-DOM, then swaps it in over the current
  // one instantly (no blank stage, no fade). A sequence token guards against
  // out-of-order loads during fast stepping; zoom/pan carry over.
  async function showImage(m, stage) {
    const seq = ++state.viewer.seq;
    const oldImg = state.viewer.img;
    let placeholder = null;
    if (!oldImg) { clearStage(); placeholder = el("div", "msg", "Loading…"); stage.appendChild(placeholder); }

    const img = document.createElement("img");
    img.draggable = false;
    try {
      await decodeImg(img, api.fileURL(m.path));
    } catch (e) {
      if (seq === state.viewer.seq) { if (placeholder) placeholder.remove(); stage.appendChild(el("div", "msg", `Could not load ${m.name}`)); }
      return;
    }
    if (seq !== state.viewer.seq) return; // superseded by a newer step

    if (placeholder) placeholder.remove();
    stage.appendChild(img);
    state.viewer.img = img;
    applyZoom();                  // carry over zoom/pan
    if (oldImg) oldImg.remove();  // instant swap
  }

  function applyZoom() {
    const v = state.viewer;
    if (!v.img) return;
    v.img.style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${v.scale})`;
    v.img.classList.toggle("zoomed", v.scale > 1);
  }
  function onWheel(e) {
    const v = state.viewer;
    if (!v.open || !v.img) return;
    e.preventDefault();
    const rect = $("#viewer-stage").getBoundingClientRect();
    const mx = e.clientX - rect.left - rect.width / 2;   // cursor relative to centre
    const my = e.clientY - rect.top - rect.height / 2;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const prev = v.scale;
    v.scale = Math.max(1, Math.min(8, v.scale * factor));
    const k = v.scale / prev;
    if (v.scale === 1) { v.tx = 0; v.ty = 0; }
    else { v.tx = mx * (1 - k) + k * v.tx; v.ty = my * (1 - k) + k * v.ty; }
    applyZoom();
  }
  function onPointerDown(e) {
    const v = state.viewer;
    if (e.pointerType === "touch") return; // touch handled by touch events below
    if (!v.open || !v.img || v.scale === 1) return;
    v.drag = { x: e.clientX, y: e.clientY, tx: v.tx, ty: v.ty };
    v.img.classList.add("dragging");
  }
  function onPointerMove(e) {
    const v = state.viewer;
    if (!v.drag) return;
    v.tx = v.drag.tx + (e.clientX - v.drag.x);
    v.ty = v.drag.ty + (e.clientY - v.drag.y);
    applyZoom();
  }
  function onPointerUp() {
    const v = state.viewer;
    if (v.drag && v.img) v.img.classList.remove("dragging");
    v.drag = null;
  }

  // ---- keyboard -------------------------------------------------------------
  function onKeydown(e) {
    // Don't hijack typing in the search box (except Esc to clear it).
    if (e.target && e.target.tagName === "INPUT") {
      if (e.key === "Escape") { e.target.value = ""; state.query = ""; applySearch(); e.target.blur(); }
      return;
    }

    if (state.viewer.open) {
      if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
      else if (e.key === "Escape") { closeViewer(); }
      else if (e.key === "Enter") { resetZoomVars(); applyZoom(); } // re-fit
      return;
    }

    const arrows = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

    if (state.view === "archive") {
      if (arrows[e.key]) { e.preventDefault(); moveArchiveFocus(arrows[e.key]); }
      else if (e.key === "Enter") { const s = visibleStudies()[state.focus]; if (s) openStudy(s); }
      else if (e.key === " ") { e.preventDefault(); toggleSelectArchive(); }
      else if (e.key === "Escape") { if (state.query) { $("#search").value = ""; state.query = ""; applySearch(); } }
      return;
    }

    if (state.view === "study") {
      if (arrows[e.key]) { e.preventDefault(); moveMediaFocus(arrows[e.key]); }
      else if (e.key === "Enter") { if (state.current && state.current.media.length) openViewer(state.current, state.mediaFocus); }
      else if (e.key === " ") { e.preventDefault(); toggleSelectMedia(); }
      else if (e.key === "Escape") { showArchive(); }
    }
  }

  function pinchDist(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }

  // ---- touch (viewer: pinch-zoom, pan, swipe) -------------------------------
  // One finger: pan when zoomed, else horizontal swipe to change file.
  // Two fingers: pinch to zoom (anchored on the gesture midpoint).
  function stageCenterPoint(cx, cy) {
    const rect = $("#viewer-stage").getBoundingClientRect();
    return { x: cx - rect.left - rect.width / 2, y: cy - rect.top - rect.height / 2 };
  }
  function onViewerTouchStart(e) {
    const v = state.viewer;
    if (!v.open) return;
    if (e.touches.length === 2 && v.img) {
      v.touch = { mode: "pinch", dist: pinchDist(e.touches), scale: v.scale, tx: v.tx, ty: v.ty };
      e.preventDefault();
    } else if (e.touches.length === 1) {
      const t = e.touches[0];
      if (v.img && v.scale > 1) {
        v.touch = { mode: "pan", x: t.clientX, y: t.clientY, tx: v.tx, ty: v.ty };
        e.preventDefault();
      } else {
        v.touch = { mode: "swipe", x: t.clientX };
      }
    }
  }
  function onViewerTouchMove(e) {
    const v = state.viewer;
    if (!v.touch) return;
    if (v.touch.mode === "pinch" && e.touches.length === 2) {
      e.preventDefault();
      const k = (Math.max(1, Math.min(8, v.touch.scale * (pinchDist(e.touches) / v.touch.dist)))) / v.touch.scale;
      v.scale = v.touch.scale * k;
      const mid = stageCenterPoint(...midpointXY(e.touches));
      if (v.scale <= 1.001) { v.scale = 1; v.tx = 0; v.ty = 0; }
      else { v.tx = mid.x - k * (mid.x - v.touch.tx); v.ty = mid.y - k * (mid.y - v.touch.ty); }
      applyZoom();
    } else if (v.touch.mode === "pan" && e.touches.length === 1) {
      e.preventDefault();
      const t = e.touches[0];
      v.tx = v.touch.tx + (t.clientX - v.touch.x);
      v.ty = v.touch.ty + (t.clientY - v.touch.y);
      applyZoom();
    }
  }
  function onViewerTouchEnd(e) {
    const v = state.viewer;
    if (!v.touch) return;
    if (v.touch.mode === "swipe") {
      const dx = e.changedTouches[0].clientX - v.touch.x;
      if (Math.abs(dx) > 50 && v.media.length > 1) step(dx < 0 ? 1 : -1);
    }
    if (e.touches.length === 0) v.touch = null;
  }
  function midpointXY(touches) {
    return [(touches[0].clientX + touches[1].clientX) / 2, (touches[0].clientY + touches[1].clientY) / 2];
  }

  // ---- boot -----------------------------------------------------------------
  async function boot() {
    $("#btn-refresh").onclick = () => loadArchive(state.root);
    $("#btn-back").onclick = showArchive;
    $("#btn-prev-study").onclick = () => navStudy(-1);
    $("#btn-next-study").onclick = () => navStudy(1);
    $("#viewer-close").onclick = closeViewer;
    $("#viewer-prev").onclick = () => step(-1);
    $("#viewer-next").onclick = () => step(1);

    const search = $("#search");
    search.oninput = () => { state.query = search.value; applySearch(); };
    $("#search-clear").onclick = () => { search.value = ""; state.query = ""; applySearch(); search.focus(); };

    document.addEventListener("keydown", onKeydown);

    // Viewer zoom / pan / swipe.
    const stage = $("#viewer-stage");
    stage.addEventListener("wheel", onWheel, { passive: false });
    stage.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    stage.addEventListener("touchstart", onViewerTouchStart, { passive: false });
    stage.addEventListener("touchmove", onViewerTouchMove, { passive: false });
    stage.addEventListener("touchend", onViewerTouchEnd, { passive: true });

    // Study detail: wheel / pinch resizes the preview tiles.
    const mgrid = $("#media-grid");
    mgrid.addEventListener("wheel", (e) => {
      if (state.view !== "study" || state.viewer.open) return;
      e.preventDefault();
      zoomTiles(e.deltaY < 0 ? 24 : -24);
    }, { passive: false });
    mgrid.addEventListener("touchstart", (e) => {
      if (state.view !== "study" || e.touches.length !== 2) return;
      state.pinch = { dist: pinchDist(e.touches), size: state.tileSize };
    }, { passive: true });
    mgrid.addEventListener("touchmove", (e) => {
      if (!state.pinch || e.touches.length !== 2) return;
      const ratio = pinchDist(e.touches) / state.pinch.dist;
      state.tileSize = Math.max(96, Math.min(440, Math.round(state.pinch.size * ratio)));
      applyTileSize();
    }, { passive: true });
    mgrid.addEventListener("touchend", () => { state.pinch = null; });

    // Re-flow the focus cursor when the grid wraps to a new column count.
    window.addEventListener("resize", () => {
      if (state.view === "archive") updateArchiveFocus();
    });

    const sel = $("#root-select");
    sel.onchange = () => loadArchive(sel.value);

    try {
      const roots = await api.roots();
      if (!roots.length) { toast("No storage roots are configured.", true); return; }
      sel.innerHTML = "";
      for (const r of roots) {
        const opt = el("option", null, r);
        opt.value = r;
        sel.appendChild(opt);
      }
      await loadArchive(roots[0]);
    } catch (e) {
      toast("Startup failed: " + e.message, true);
    }
  }

  boot();
})();
