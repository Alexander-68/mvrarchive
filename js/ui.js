// MVRarchive UI controller: archive grid (browse + search), study detail
// (media + metadata), and the fullscreen media viewer. Wired against MVR.api.
(function () {
  "use strict";
  const MVR = window.MVR;
  const { api, study: S } = MVR;
  const $ = (sel) => document.querySelector(sel);

  const state = {
    root: "",
    studies: [],        // current root's studies (sorted newest-first)
    query: "",
    urls: [],           // object URLs to revoke on archive reload
    viewer: { media: [], index: 0, url: null },
    current: null,      // study open in detail view
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

  // ---- view switching -------------------------------------------------------
  function showArchive() {
    $("#view-study").hidden = true;
    $("#view-archive").hidden = false;
    state.current = null;
  }
  function showStudy() {
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
    $("#free-space").textContent = root;

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
    $("#grid-empty").hidden = state.studies.length > 0;

    // Render skeleton cards immediately, then hydrate progressively.
    for (const study of state.studies) {
      study.cardEl = buildCard(study);
      grid.appendChild(study.cardEl);
    }
    applySearch();

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
      <div class="card-thumb loading">
        <span class="type-pill" hidden></span>
      </div>
      <div class="card-body">
        <div class="card-title">${escapeHTML(study.folderName)}</div>
        <div class="card-date muted">—</div>
        <div class="card-meta"></div>
        <div class="card-sub"></div>
      </div>`;
    card.onclick = () => openStudy(study);
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

    const pill = card.querySelector(".type-pill");
    if (i.Type) { pill.textContent = i.Type; pill.hidden = false; }

    // Thumbnail: first image, loaded lazily.
    const thumb = card.querySelector(".card-thumb");
    if (study.thumbFile) {
      api.objectURL(study.thumbFile.path, study.thumbFile.name).then((url) => {
        trackURL(url);
        const img = el("img", "thumb-img");
        img.src = url;
        thumb.classList.remove("loading");
        thumb.insertBefore(img, thumb.firstChild);
      }).catch(() => { thumb.classList.remove("loading"); addPlaceholder(thumb); });
    } else {
      thumb.classList.remove("loading");
      addPlaceholder(thumb);
    }
  }

  function addPlaceholder(thumb) {
    if (thumb.querySelector(".placeholder")) return;
    const ph = icon("ic_study", "placeholder");
    thumb.insertBefore(ph, thumb.firstChild);
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

    renderMedia(study);
    renderInfo(study);
  }

  function renderMedia(study) {
    const grid = $("#media-grid");
    grid.innerHTML = "";
    $("#media-empty").hidden = study.media.length > 0;

    study.media.forEach((m, idx) => {
      const tile = el("div", "media-tile");
      tile.appendChild(el("span", "kind", m.kind));
      tile.appendChild(el("span", "fname", m.name));
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
      } else if (m.kind === "video") {
        tile.appendChild(icon("ic_video", "ic"));
        tile.appendChild(el("span", "play", "▶"));
      } else {
        tile.appendChild(icon("ic_pdf", "ic"));
      }
      tile.onclick = () => openViewer(study, idx);
      grid.appendChild(tile);
    });
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

    // Anything else present but not in a known group — shown transparently.
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

  // ---- media viewer ---------------------------------------------------------
  function openViewer(study, index) {
    state.viewer.media = study.media;
    state.viewer.index = index;
    $("#viewer").hidden = false;
    showMedia();
  }
  function closeViewer() {
    $("#viewer").hidden = true;
    clearStage();
  }
  function clearStage() {
    if (state.viewer.url) { URL.revokeObjectURL(state.viewer.url); state.viewer.url = null; }
    $("#viewer-stage").innerHTML = "";
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
      const url = trackViewerURL(await api.objectURL(m.path, m.name));
      loading.remove();
      if (m.kind === "image") {
        const img = el("img"); img.src = url; stage.appendChild(img);
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
  function trackViewerURL(u) { state.viewer.url = u; return u; }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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

    document.addEventListener("keydown", (e) => {
      if ($("#viewer").hidden) return;
      if (e.key === "Escape") closeViewer();
      else if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
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
