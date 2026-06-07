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
    urls: [],            // object URLs to revoke on archive reload
    focus: 0,            // index into visible studies
    current: null,       // study open in detail view
    mediaFocus: 0,       // index into current.media
    viewer: { media: [], index: 0, url: null, open: false, img: null,
              scale: 1, tx: 0, ty: 0, drag: null, touchX: null },
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
  function trackURL(u) { state.urls.push(u); return u; }
  function revokeURLs() { state.urls.forEach(URL.revokeObjectURL); state.urls = []; }

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
    revokeURLs();
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

    // Thumbnail: first image only; nothing is drawn over it.
    const thumb = card.querySelector(".card-thumb");
    if (study.thumbFile) {
      api.objectURL(study.thumbFile.path, study.thumbFile.name).then((url) => {
        trackURL(url);
        const img = el("img", "thumb-img");
        img.src = url;
        thumb.classList.remove("loading");
        thumb.appendChild(img);
      }).catch(() => { thumb.classList.remove("loading"); addPlaceholder(thumb); });
    } else {
      thumb.classList.remove("loading");
      addPlaceholder(thumb);
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
  }

  function renderMedia(study) {
    const grid = $("#media-grid");
    grid.innerHTML = "";
    $("#media-empty").hidden = study.media.length > 0;

    study.media.forEach((m, idx) => {
      const tile = el("div", "media-tile");
      m.tileEl = tile;
      // Single compact caption, e.g. "IMAGE, I0002.jpg".
      tile.appendChild(el("span", "cap", `${m.kind.toUpperCase()}, ${m.name}`));
      if (m.kind === "image") {
        const ic = icon("ic_image", "ic");
        tile.appendChild(ic);
        api.objectURL(m.path, m.name).then((url) => {
          trackURL(url);
          const img = el("img");
          img.src = url;
          tile.insertBefore(img, tile.firstChild);
          ic.remove();
        }).catch(() => {});
      } else {
        tile.appendChild(icon(m.kind === "video" ? "ic_video" : "ic_pdf", "ic"));
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
    state.viewer.media = study.media;
    state.viewer.index = index;
    state.viewer.open = true;
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
  function clearStage() {
    if (state.viewer.url) { URL.revokeObjectURL(state.viewer.url); state.viewer.url = null; }
    state.viewer.img = null;
    resetZoomVars();
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
  async function showMedia() {
    clearStage();
    const m = state.viewer.media[state.viewer.index];
    const stage = $("#viewer-stage");
    $("#viewer-name").textContent = `${m.name}  (${state.viewer.index + 1}/${state.viewer.media.length})`;
    const hasNav = state.viewer.media.length > 1;
    $("#viewer-prev").style.visibility = hasNav ? "" : "hidden";
    $("#viewer-next").style.visibility = hasNav ? "" : "hidden";

    const ext = MVR.path.extname(m.name);
    if (ext === "dcm") {
      stage.appendChild(el("div", "msg", `DICOM files (${m.name}) are not viewable yet — a DICOM decoder is planned for a later phase.`));
      return;
    }
    const loading = el("div", "msg", "Loading…");
    stage.appendChild(loading);
    try {
      const url = (state.viewer.url = await api.objectURL(m.path, m.name));
      loading.remove();
      if (m.kind === "image") {
        const img = el("img");
        img.src = url;
        img.draggable = false;
        state.viewer.img = img;
        stage.appendChild(img);
      } else if (m.kind === "video") {
        const v = document.createElement("video");
        v.src = url; v.controls = true; v.autoplay = true; v.playsInline = true;
        stage.appendChild(v);
      } else if (m.kind === "pdf") {
        const f = document.createElement("iframe");
        f.src = url; stage.appendChild(f);
      }
    } catch (e) {
      loading.remove();
      const msg = e.message && /not found|too large|413/i.test(e.message)
        ? `Could not load ${m.name}. Files over 32 MiB can't be read through the current API (a streaming endpoint is planned).`
        : `Could not load ${m.name}: ${e.message}`;
      stage.appendChild(el("div", "msg", msg));
    }
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

  // ---- touch (viewer swipe) -------------------------------------------------
  function onTouchStart(e) {
    if (!state.viewer.open || state.viewer.scale !== 1) return;
    if (e.touches.length === 1) state.viewer.touchX = e.touches[0].clientX;
  }
  function onTouchEnd(e) {
    const v = state.viewer;
    if (!v.open || v.touchX == null) return;
    const dx = (e.changedTouches[0].clientX) - v.touchX;
    v.touchX = null;
    if (Math.abs(dx) > 50 && v.media.length > 1) step(dx < 0 ? 1 : -1);
  }

  // ---- boot -----------------------------------------------------------------
  async function boot() {
    $("#btn-refresh").onclick = () => loadArchive(state.root);
    $("#btn-back").onclick = showArchive;
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
    stage.addEventListener("touchstart", onTouchStart, { passive: true });
    stage.addEventListener("touchend", onTouchEnd, { passive: true });

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
