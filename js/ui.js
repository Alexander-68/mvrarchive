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
    cardSize: 300,       // archive card min width (px), Ctrl+wheel/pinch adjustable
    tileSize: 160,       // detail media-tile min width (px), wheel/pinch adjustable
    cardPinch: null,     // active pinch gesture in archive grid
    pinch: null,         // active pinch gesture in the media grid
    viewer: { study: null, media: [], index: 0, open: false, img: null,
              scale: 1, tx: 0, ty: 0, drag: null, touch: null, seq: 0 },
  };
  const MIN_TILE_SIZE = 64;
  const MAX_TILE_SIZE = 440;
  const MIN_CARD_SIZE = 180;
  const MAX_CARD_SIZE = 640;
  const QUAD_CARD_SIZE = 440;
  const MIN_VIEWER_IMAGE_WIDTH = 64;
  const MAX_VIEWER_SCALE = 8;

  const CARD_HYDRATE_CONCURRENCY = 4;
  const MEDIA_PREVIEW_CONCURRENCY = 4;

  // ---- scroll tracking & multi-tier lazy load scheduler ---------------------
  let lastScrollY = window.scrollY || 0;
  let scrollDirection = "down"; // "down" | "up"
  let isScrolling = false;
  let scrollStopTimer = null;
  let cardZoomTimer = null;
  let fieldTooltip = null;
  let fieldTooltipTimer = null;

  function onScroll() {
    const currentY = window.scrollY || 0;
    if (currentY > lastScrollY + 2) {
      scrollDirection = "down";
    } else if (currentY < lastScrollY - 2) {
      scrollDirection = "up";
    }
    lastScrollY = currentY;
    isScrolling = true;

    scanAndScheduleLazyLoads();

    clearTimeout(scrollStopTimer);
    scrollStopTimer = setTimeout(() => {
      isScrolling = false;
      // When scroll stops, schedule 1.5x ahead and 1.5x behind preloads
      scanAndScheduleLazyLoads();
    }, 130);
  }

  window.addEventListener("scroll", onScroll, { passive: true });

  // Compute element zone relative to current viewport and scroll direction:
  // 1 = Visible (on screen)
  // 2 = Ahead (1.5x viewports in scroll direction)
  // 3 = Behind (1.5x viewports in opposite direction)
  // 0 = Far / outside 1.5x viewport
  function getElementZone(element) {
    if (!element || element.hidden) return 0;
    const rect = element.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight || 800;
    const top = rect.top;
    const bottom = rect.bottom;

    // 1. Visible on screen
    if (bottom >= 0 && top <= vh) {
      return 1;
    }

    const margin = 1.5 * vh;

    if (scrollDirection === "down") {
      // 2. Ahead: below screen within 1.5x vh
      if (top > vh && top <= vh + margin) return 2;
      // 3. Behind: above screen within 1.5x vh
      if (bottom < 0 && bottom >= -margin) return 3;
    } else {
      // Scrolling up:
      // 2. Ahead: above screen within 1.5x vh
      if (bottom < 0 && bottom >= -margin) return 2;
      // 3. Behind: below screen within 1.5x vh
      if (top > vh && top <= vh + margin) return 3;
    }

    return 0;
  }

  // --- Study Cards Lazy Scheduler ---
  let activeCardWorkers = 0;
  const cardQueue = []; // array of studies
  let cardVisibleObserver = null;

  function enqueueCard(study, priority, pump = true) {
    if (study.hydrated || study._loading) return;
    study._priority = Math.min(study._priority || 99, priority);
    if (!cardQueue.includes(study)) {
      cardQueue.push(study);
    }
    sortCardQueue();
    if (pump) pumpCardQueue();
  }

  function sortCardQueue() {
    cardQueue.sort((a, b) => (a._priority || 99) - (b._priority || 99));
  }

  function pumpCardQueue() {
    if (!cardQueue.length) return;

    // If currently scrolling fast, only process priority 1 (visible) items
    while (activeCardWorkers < CARD_HYDRATE_CONCURRENCY && cardQueue.length > 0) {
      sortCardQueue();
      const topStudy = cardQueue[0];
      if (!topStudy) break;

      if (isScrolling && topStudy._priority > 1) {
        // Wait for scrolling to settle before processing ahead/behind preloads
        break;
      }

      cardQueue.shift();
      if (topStudy.hydrated || topStudy._loading) continue;

      topStudy._loading = true;
      activeCardWorkers++;

      (async () => {
        try {
          await S.hydrate(topStudy);
          fillCard(topStudy);
          if (state.query) applySearch();
        } catch (e) {
          /* ignore error */
        } finally {
          topStudy._loading = false;
          activeCardWorkers--;
          pumpCardQueue();
        }
      })();
    }
  }

  function setupCardObservers() {
    if (cardVisibleObserver) cardVisibleObserver.disconnect();
    if (!window.IntersectionObserver) return;

    // Visible-on-screen observer (0px rootMargin)
    cardVisibleObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const study = entry.target._study;
          if (study && !study.hydrated) {
            study._priority = 1;
            enqueueCard(study, 1);
          }
        }
      }
    }, {
      rootMargin: "0px",
      threshold: 0.01,
    });
  }

  // --- Media Preview Tiles Lazy Scheduler ---
  let activeMediaWorkers = 0;
  const mediaQueue = []; // array of media items { media, loadFn, priority }
  let mediaVisibleObserver = null;

  function enqueueMedia(item, priority, pump = true) {
    if (item.media._previewLoaded || item.media._previewLoading) return;
    item.priority = Math.min(item.priority || 99, priority);
    if (!mediaQueue.includes(item)) {
      mediaQueue.push(item);
    }
    sortMediaQueue();
    if (pump) pumpMediaQueue();
  }

  function sortMediaQueue() {
    mediaQueue.sort((a, b) => (a.priority || 99) - (b.priority || 99));
  }

  function pumpMediaQueue() {
    if (!mediaQueue.length) return;

    while (activeMediaWorkers < MEDIA_PREVIEW_CONCURRENCY && mediaQueue.length > 0) {
      sortMediaQueue();
      const topItem = mediaQueue[0];
      if (!topItem) break;

      if (isScrolling && topItem.priority > 1) {
        break;
      }

      mediaQueue.shift();
      if (topItem.media._previewLoaded || topItem.media._previewLoading) continue;

      topItem.media._previewLoading = true;
      activeMediaWorkers++;

      (async () => {
        try {
          await topItem.loadFn();
          topItem.media._previewLoaded = true;
        } catch (e) {
          /* ignore */
        } finally {
          topItem.media._previewLoading = false;
          activeMediaWorkers--;
          pumpMediaQueue();
        }
      })();
    }
  }

  function setupMediaObservers() {
    if (mediaVisibleObserver) mediaVisibleObserver.disconnect();
    if (!window.IntersectionObserver) return;

    mediaVisibleObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const tile = entry.target;
          if (tile._queueItem && !tile._queueItem.media._previewLoaded) {
            tile._queueItem.priority = 1;
            enqueueMedia(tile._queueItem, 1);
          }
        }
      }
    }, {
      rootMargin: "0px",
      threshold: 0.01,
    });
  }

  // Scan all items in the active view to assign Priority 1 (visible),
  // Priority 2 (1.5x ahead), and Priority 3 (1.5x behind)
  function scanAndScheduleLazyLoads() {
    if (state.view === "archive") {
      // Drop stale preloads, then queue current viewport before nearby cards.
      cardQueue.length = 0;
      const vis = visibleStudies();
      for (const study of vis) {
        if (study.hydrated || study._loading || !study.cardEl) continue;
        const zone = getElementZone(study.cardEl);
        if (zone > 0) {
          study._priority = zone;
          enqueueCard(study, zone, false);
        }
      }
      pumpCardQueue();
    } else if (state.view === "study" && state.current) {
      // Drop stale preloads, then queue current viewport before nearby tiles.
      mediaQueue.length = 0;
      for (const m of state.current.media) {
        if (m._previewLoaded || m._previewLoading || !m.tileEl) continue;
        const zone = getElementZone(m.tileEl);
        if (zone > 0 && m.tileEl._queueItem) {
          m.tileEl._queueItem.priority = zone;
          enqueueMedia(m.tileEl._queueItem, zone, false);
        }
      }
      pumpMediaQueue();
    }
  }

  // ---- theme & omnigate bridge ----------------------------------------------
  function applyTheme(theme) {
    if (theme === "light" || theme === "dark") {
      document.documentElement.dataset.theme = theme;
    }
  }

  function applyZoom(zoom) {
    if (zoom) {
      document.documentElement.style.zoom = zoom + "%";
    }
  }

  async function syncPlatform() {
    try {
      const p = await api.platform();
      if (p && p.platform === "omnigate") {
        if (p.theme) applyTheme(p.theme);
        if (p.zoom) applyZoom(p.zoom);
      }
    } catch (e) { /* ignore */ }
  }

  function setupThemeBridge() {
    window.addEventListener("message", (e) => {
      if (!e.data) return;
      if (typeof e.data === "string") {
        if (e.data === "light" || e.data === "dark") applyTheme(e.data);
        return;
      }
      if (typeof e.data === "object") {
        const t = e.data.theme || (e.data.type === "theme" && e.data.value);
        if (t === "light" || t === "dark") applyTheme(t);
        if (e.data.zoom) applyZoom(e.data.zoom);
        const u = e.data.user || e.data.username;
        if (u) {
          const elName = $("#user-name");
          if (elName) elName.textContent = typeof u === "string" ? u : u.username;
        }
      }
    });
  }

  async function initUser() {
    try {
      const u = await api.me();
      const username = u && (u.username || u.name);
      if (username) {
        const elName = $("#user-name");
        if (elName) {
          elName.textContent = username;
          elName.title = u.role ? `Signed in as ${username} (${u.role})` : `Signed in as ${username}`;
        }
        return;
      }
    } catch (e) { /* fall through to URL params / storage */ }

    const urlUser = new URLSearchParams(location.search).get("user") ||
                    new URLSearchParams(location.search).get("username");
    if (urlUser) {
      const elName = $("#user-name");
      if (elName) elName.textContent = urlUser;
      return;
    }

    try {
      const stored = sessionStorage.getItem("username") || localStorage.getItem("username");
      if (stored) {
        const elName = $("#user-name");
        if (elName) elName.textContent = stored;
      }
    } catch (e) { /* ignore */ }
  }

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
  // thumbnail endpoint is tried first; when ffmpeg is absent, this browser-side
  // decoder is the fallback.
  // Resolves to a data URL, or null if anything fails.
  function captureVideoFrame(url, w) {
    return new Promise((resolve) => {
      const v = document.createElement("video");
      v.muted = true; v.preload = "metadata"; v.crossOrigin = "anonymous"; v.src = url;
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
    scanAndScheduleLazyLoads();
  }
  function showStudy() {
    state.view = "study";
    $("#view-archive").hidden = true;
    $("#view-study").hidden = false;
  }

  // ---- archive grid ---------------------------------------------------------
  async function loadArchive(root) {
    state.root = root;
    showArchive();
    const grid = $("#grid");
    grid.innerHTML = "";
    applyCardSize();
    $("#grid-empty").hidden = true;
    $("#study-count").textContent = "Loading…";
    refreshStatusRight();

    cardQueue.length = 0;

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

    // When storage has no subfolders (studies), go to file view mode directly!
    if (folders.length === 0) {
      const directStudy = S.newStudy(root, {
        name: MVR.path.basename(root) || root,
        mod_time: "",
      });
      directStudy.path = root;
      directStudy.isDirectRoot = true;
      state.studies = [directStudy];
      state.focus = 0;
      $("#study-count").textContent = "Direct file view";
      await openStudy(directStudy);
      return;
    }

    state.studies = folders.map((e) => S.newStudy(root, e));
    state.focus = 0;
    $("#grid-empty").hidden = state.studies.length > 0;

    const total = state.studies.length;
    $("#study-count").textContent = `${total} stud${total === 1 ? "y" : "ies"}`;

    setupCardObservers();

    for (const study of state.studies) {
      study.cardEl = buildCard(study);
      study.cardEl._study = study;
      grid.appendChild(study.cardEl);

      if (cardVisibleObserver) {
        cardVisibleObserver.observe(study.cardEl);
      } else {
        enqueueCard(study, 1);
      }
    }

    applySearch();
    updateArchiveFocus();
    scanAndScheduleLazyLoads();
  }

  function buildCard(study) {
    const card = el("div", "card");
    card.dataset.folder = study.folderName;

    const parsed = S.parseStampName(study.folderName);
    const initialTitle = (parsed && parsed.studyId) ? parsed.studyId : study.folderName;
    const initialDate = parsed && parsed.date ? S.formatDate(parsed.date) : (study.modTime ? S.formatDate(new Date(study.modTime)) : "—");

    card.innerHTML = `
      <div class="card-thumb loading"></div>
      <div class="card-body">
        <div class="card-title">${escapeHTML(initialTitle)}</div>
        <div class="card-date muted">${escapeHTML(initialDate)}</div>
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

    fillCardThumb(study);
  }

  // Large cards show four evenly spaced stills; smaller cards keep one preview.
  function fillCardThumb(study) {
    const thumb = study.cardEl && study.cardEl.querySelector(".card-thumb");
    if (!thumb) return;
    thumb.innerHTML = "";
    thumb.classList.add("loading");
    thumb.classList.remove("quad");
    const images = study.media.filter((m) => m.kind === "image");
    if (state.cardSize >= QUAD_CARD_SIZE && images.length >= 4) {
      thumb.classList.add("quad");
      let remaining = 4;
      for (let i = 0; i < 4; i++) {
        const img = el("img", "thumb-img");
        const done = () => { if (!--remaining) thumb.classList.remove("loading"); };
        img.onload = done;
        img.onerror = () => { img.remove(); done(); };
        img.src = api.thumbURL(images[Math.round(i * (images.length - 1) / 3)].path, 400);
        thumb.appendChild(img);
      }
      return;
    }

    // Server JPEG of first image/video; video falls back to browser frame capture.
    const targetFile = study.thumbFile || study.media.find((m) => m.kind === "video");

    if (targetFile) {
      const img = el("img", "thumb-img");
      img.onload = () => { thumb.classList.remove("loading"); thumb.appendChild(img); };
      img.onerror = () => {
        if (targetFile.kind === "video") {
          captureVideoFrame(api.fileURL(targetFile.path), 400).then((data) => {
            if (data) {
              img.onerror = () => { thumb.classList.remove("loading"); addPlaceholder(thumb); };
              img.src = data;
            } else {
              thumb.classList.remove("loading");
              addPlaceholder(thumb);
            }
          });
        } else {
          thumb.classList.remove("loading");
          addPlaceholder(thumb);
        }
      };
      img.src = api.thumbURL(targetFile.path, 400);
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
      if (show) {
        visible++;
      }
    }
    $("#search-clear").hidden = !q;
    if (q) {
      $("#grid-empty").hidden = visible > 0;
      $("#study-count").textContent = `${visible} of ${state.studies.length} match “${q}”`;
    } else {
      $("#grid-empty").hidden = state.studies.length > 0;
      $("#study-count").textContent = `${state.studies.length} stud${state.studies.length === 1 ? "y" : "ies"}`;
    }
    refreshStatusRight();
    if (state.view === "archive") {
      updateArchiveFocus();
      scanAndScheduleLazyLoads();
    }
  }

  function refreshStatusRight() {
    const sel = state.studies.filter((s) => s.marked).length;
    $("#free-space").textContent = sel ? `${sel} selected` : "";
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
    const currentStudy = vis[state.focus];
    const elc = currentStudy.cardEl;
    elc.classList.add("focused");
    elc.scrollIntoView({ block: "nearest" });
    if (!currentStudy.hydrated) {
      enqueueCard(currentStudy, 1);
    }
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
    $("#btn-prev-study").disabled = inList ? idx <= 0 : list.length <= 1;
    $("#btn-next-study").disabled = inList ? idx >= list.length - 1 : list.length <= 1;
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
    const bits = [];
    const dt = S.formatDate(S.studyDate(study));
    if (dt) bits.push(dt);
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
    $("#media-grid").style.gridTemplateColumns = `repeat(auto-fill, minmax(min(100%, ${state.tileSize}px), ${state.tileSize}px))`;
  }
  function zoomTiles(deltaPx) {
    state.tileSize = Math.max(MIN_TILE_SIZE, Math.min(MAX_TILE_SIZE, state.tileSize + deltaPx));
    applyTileSize();
  }
  function applyCardSize() {
    $("#grid").style.gridTemplateColumns = `repeat(auto-fill, minmax(min(100%, ${state.cardSize}px), ${state.cardSize}px))`;
  }
  function zoomCards(deltaPx) {
    const wasQuad = state.cardSize >= QUAD_CARD_SIZE;
    state.cardSize = Math.max(MIN_CARD_SIZE, Math.min(MAX_CARD_SIZE, state.cardSize + deltaPx));
    applyCardSize();
    if (wasQuad !== (state.cardSize >= QUAD_CARD_SIZE)) {
      state.studies.forEach((study) => { if (study.hydrated && study.cardEl) fillCardThumb(study); });
    }
  }
  function scheduleCardScan() {
    clearTimeout(cardZoomTimer);
    cardZoomTimer = setTimeout(scanAndScheduleLazyLoads, 130);
  }

  function renderMedia(study) {
    const grid = $("#media-grid");
    grid.innerHTML = "";
    applyTileSize();
    $("#media-empty").hidden = study.media.length > 0;

    mediaQueue.length = 0;
    setupMediaObservers();

    study.media.forEach((m, idx) => {
      const tile = el("div", "media-tile");
      m.tileEl = tile;
      m._previewLoaded = false;
      m._previewLoading = false;

      // Single compact caption, e.g. "IMAGE, I0002.jpg".
      tile.appendChild(el("span", "cap", `${m.kind.toUpperCase()}, ${m.name}`));
      const ic = icon(m.kind === "video" ? "ic_video" : m.kind === "pdf" ? "ic_pdf" : "ic_image", "ic");
      tile.appendChild(ic);

      const loadPreview = async () => {
        if (m.kind === "image" || m.kind === "video") {
          return new Promise((resolve) => {
            const img = el("img");
            img.onload = () => {
              tile.insertBefore(img, tile.firstChild);
              ic.remove();
              resolve();
            };
            img.onerror = () => {
              if (m.kind === "video") {
                captureVideoFrame(api.fileURL(m.path), 400).then((data) => {
                  if (data) {
                    img.onerror = null;
                    img.src = data;
                  }
                  resolve();
                });
              } else {
                resolve();
              }
            };
            img.src = api.thumbURL(m.path, 400);
          });
        }
      };

      const queueItem = { media: m, loadFn: loadPreview, priority: 1 };
      tile._queueItem = queueItem;

      if (mediaVisibleObserver) {
        mediaVisibleObserver.observe(tile);
      } else {
        enqueueMedia(queueItem, 1);
      }

      tile.onclick = () => { setMediaFocus(idx); openViewer(study, idx); };
      grid.appendChild(tile);
    });

    scanAndScheduleLazyLoads();
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
    const currentMedia = media[state.mediaFocus];
    const t = currentMedia.tileEl;
    if (t) {
      t.classList.add("focused");
      t.scrollIntoView({ block: "nearest" });
      if (t._queueItem && !t._queueItem.media._previewLoaded) {
        enqueueMedia(t._queueItem, 1);
      }
    }
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
    const body = panel.closest(".detail-body");
    panel.innerHTML = "";
    panel.hidden = true;
    body.classList.add("no-info");
    const info = study.info;
    if (!info) return;

    panel.appendChild(el("h3", null, "Study information"));

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
    panel.hidden = panel.childElementCount === 1;
    body.classList.toggle("no-info", panel.hidden);
  }
  function infoRow(label, value) {
    const row = el("div", "info-row");
    row.dataset.tooltip = `${label}: ${value}`;
    row.setAttribute("aria-label", row.dataset.tooltip);
    row.appendChild(el("span", "k", label));
    row.appendChild(el("span", "v", value));
    return row;
  }

  function hideFieldTooltip() {
    clearTimeout(fieldTooltipTimer);
    fieldTooltipTimer = null;
    if (fieldTooltip) fieldTooltip.remove();
    fieldTooltip = null;
  }
  function showFieldTooltip(row) {
    hideFieldTooltip();
    const tip = el("div", "field-tooltip", row.dataset.tooltip);
    tip.role = "tooltip";
    document.body.appendChild(tip);
    const rect = row.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - tip.offsetWidth - margin));
    const offset = Math.max(12, rect.height * 0.8);
    const top = Math.max(margin, rect.top - tip.offsetHeight - offset);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    fieldTooltip = tip;
  }
  function setupFieldTooltips() {
    document.addEventListener("pointerover", (e) => {
      if (e.pointerType === "touch") return;
      const row = e.target.closest && e.target.closest(".info-row[data-tooltip]");
      if (!row || (e.relatedTarget && row.contains(e.relatedTarget))) return;
      hideFieldTooltip();
      fieldTooltipTimer = setTimeout(() => showFieldTooltip(row), 500);
    });
    document.addEventListener("pointerout", (e) => {
      const row = e.target.closest && e.target.closest(".info-row[data-tooltip]");
      if (row && (!e.relatedTarget || !row.contains(e.relatedTarget))) hideFieldTooltip();
    });
    document.addEventListener("touchstart", (e) => {
      const row = e.target.closest && e.target.closest(".info-row[data-tooltip]");
      if (!row) return;
      hideFieldTooltip();
      fieldTooltipTimer = setTimeout(() => showFieldTooltip(row), 500);
    }, { passive: true });
    document.addEventListener("touchend", hideFieldTooltip, { passive: true });
    document.addEventListener("touchmove", hideFieldTooltip, { passive: true });
    document.addEventListener("touchcancel", hideFieldTooltip, { passive: true });
  }

  function syncDetailStickyOffset() {
    const topbar = $(".topbar");
    if (topbar) document.documentElement.style.setProperty("--topbar-height", `${topbar.offsetHeight}px`);
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
    if (m.kind === "image") {
      if (m.width && m.height) parts.push(`${m.width} x ${m.height}`);
      parts.push(`zoom ${Math.round(state.viewer.scale * 100)}%`);
    }
    return `${parts.join("  ·  ")}  ${counter}`;
  }
  function updateViewerName() {
    const m = state.viewer.media[state.viewer.index];
    if (m) $("#viewer-name").textContent = viewerLabel(m);
  }
  function decodeImg(img, url) {
    return new Promise((res, rej) => { img.onload = () => res(); img.onerror = rej; img.src = url; });
  }

  async function showMedia() {
    const m = state.viewer.media[state.viewer.index];
    const stage = $("#viewer-stage");
    updateViewerName();
    const hasNav = state.viewer.media.length > 1;
    $("#viewer-prev").style.visibility = hasNav ? "" : "hidden";
    $("#viewer-next").style.visibility = hasNav ? "" : "hidden";

    if (m.kind === "image") return showImage(m, stage);

    // Heavy media: stream straight from the read URL (Range-capable), so video
    // seeks natively and PDFs render with their real content-type.
    clearStage();
    const ext = MVR.path.extname(m.name);
    if (ext === "dcm" || ext === "dicom") {
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

    m.width = img.naturalWidth || 0;
    m.height = img.naturalHeight || 0;
    if (placeholder) placeholder.remove();
    stage.appendChild(img);
    state.viewer.img = img;
    applyZoom();                  // carry over zoom/pan
    if (oldImg) oldImg.remove();  // instant swap
  }

  function applyZoom() {
    const v = state.viewer;
    if (!v.img) return;
    v.scale = clampViewerScale(v.scale);
    v.img.style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${v.scale})`;
    v.img.classList.toggle("zoomed", v.scale !== 1);
    updateViewerName();
  }
  function minViewerScale() {
    const img = state.viewer.img;
    if (!img) return 1;
    const baseWidth = img.offsetWidth || img.naturalWidth || MIN_VIEWER_IMAGE_WIDTH;
    return Math.min(1, MIN_VIEWER_IMAGE_WIDTH / Math.max(1, baseWidth));
  }
  function clampViewerScale(scale) {
    return Math.max(minViewerScale(), Math.min(MAX_VIEWER_SCALE, scale));
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
    v.scale = clampViewerScale(v.scale * factor);
    const k = v.scale / prev;
    v.tx = mx * (1 - k) + k * v.tx;
    v.ty = my * (1 - k) + k * v.ty;
    applyZoom();
  }
  function onPointerDown(e) {
    const v = state.viewer;
    if (e.pointerType === "touch") return; // touch handled by touch events below
    if (!v.open || !v.img) return;
    e.preventDefault();
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
  // One finger: pan images at any zoom; non-image media still swipe.
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
      if (v.img) {
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
      const nextScale = clampViewerScale(v.touch.scale * (pinchDist(e.touches) / v.touch.dist));
      const k = nextScale / v.touch.scale;
      v.scale = nextScale;
      const mid = stageCenterPoint(...midpointXY(e.touches));
      v.tx = mid.x - k * (mid.x - v.touch.tx);
      v.ty = mid.y - k * (mid.y - v.touch.ty);
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

  // ---- startup path ---------------------------------------------------------
  function shareRootOf(p) {
    const path = MVR.path.normalizeVirtual(p);
    const i = path.indexOf("/", 1);
    return i < 0 ? path : path.slice(0, i);
  }

  function startTarget(roots) {
    const fallback = { share: roots[0], archivePath: roots[0], studyPath: "" };
    const raw = new URLSearchParams(location.search).get("path");
    if (!raw) return fallback;

    const want = MVR.path.normalizeVirtual(raw);
    const share = shareRootOf(want);
    if (!want || !roots.includes(share)) return fallback;

    const isStudy = want !== share && S.isStudyFolder(MVR.path.basename(want));
    return {
      share,
      archivePath: isStudy ? MVR.path.parentOf(want) : want,
      studyPath: isStudy ? want : "",
    };
  }

  function rootLabel(root) {
    return root.startsWith("/") ? root.slice(1) : root;
  }

  // ---- boot -----------------------------------------------------------------
  async function boot() {
    setupThemeBridge();
    await syncPlatform();
    await initUser();
    syncDetailStickyOffset();
    setupFieldTooltips();

    $("#btn-refresh").onclick = () => loadArchive(state.root);
    $("#btn-back").onclick = showArchive;
    $("#btn-prev-study").onclick = () => navStudy(-1);
    $("#btn-next-study").onclick = () => navStudy(1);
    $("#viewer-close").onclick = closeViewer;
    $("#viewer-back").onclick = closeViewer;
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
    const grid = $("#grid");
    grid.addEventListener("wheel", (e) => {
      if (state.view !== "archive" || !e.ctrlKey) return;
      e.preventDefault();
      zoomCards(e.deltaY < 0 ? 24 : -24);
      scheduleCardScan();
    }, { passive: false });
    grid.addEventListener("touchstart", (e) => {
      if (state.view !== "archive" || e.touches.length !== 2) return;
      state.cardPinch = { dist: pinchDist(e.touches), size: state.cardSize };
    }, { passive: true });
    grid.addEventListener("touchmove", (e) => {
      if (!state.cardPinch || e.touches.length !== 2) return;
      const ratio = pinchDist(e.touches) / state.cardPinch.dist;
      state.cardSize = Math.max(MIN_CARD_SIZE, Math.min(MAX_CARD_SIZE, Math.round(state.cardPinch.size * ratio)));
      applyCardSize();
    }, { passive: true });
    grid.addEventListener("touchend", () => { state.cardPinch = null; scheduleCardScan(); });

    const mgrid = $("#media-grid");
    mgrid.addEventListener("wheel", (e) => {
      if (state.view !== "study" || state.viewer.open) return;
      if (!e.ctrlKey) return;
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
      state.tileSize = Math.max(MIN_TILE_SIZE, Math.min(MAX_TILE_SIZE, Math.round(state.pinch.size * ratio)));
      applyTileSize();
    }, { passive: true });
    mgrid.addEventListener("touchend", () => { state.pinch = null; });

    // Re-flow the focus cursor and scheduler when the grid wraps to a new column count.
    window.addEventListener("resize", () => {
      syncDetailStickyOffset();
      if (state.view === "archive") updateArchiveFocus();
      scanAndScheduleLazyLoads();
    });

    const sel = $("#root-select");
    sel.onchange = () => loadArchive(sel.value);

    try {
      const roots = await api.roots();
      if (!roots.length) { toast("No storage roots are configured.", true); return; }
      sel.innerHTML = "";
      for (const r of roots) {
        const opt = el("option", null, rootLabel(r));
        opt.value = r;
        sel.appendChild(opt);
      }
      const start = startTarget(roots);
      sel.value = start.share;
      await loadArchive(start.archivePath);
      if (start.studyPath) {
        const idx = state.studies.findIndex((s) => s.path === start.studyPath);
        if (idx >= 0) {
          setArchiveFocus(idx);
          await openStudy(state.studies[idx]);
        }
      }
    } catch (e) {
      toast("Startup failed: " + e.message, true);
    }
  }

  boot();
})();
