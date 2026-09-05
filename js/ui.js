// MVRarchive UI controller: archive grid (browse + search), study detail
// (media + metadata), and the fullscreen media viewer.
//
// Navigation (no on-screen help — intuitive keys):
//   Arrows  move the focus cursor (grid: left/right within a row, up/down rows;
//           viewer: left/right = prev/next file)
//   Enter   go in   (focused study -> detail, focused media -> viewer)
//   Esc     go out  (viewer -> detail, detail -> archive; in archive clears search)
//   Space   select / unselect the focused item (Ctrl+click does the same)
//   Ctrl+A  select all visible studies / all files of the open study
//   Ctrl+C  copy the selection; Ctrl+V pastes studies into the open storage
//           or files into the open study (never into the same place)
//   Delete  delete the selection (after a confirm dialog; gateway soft-deletes)
//   Deleted (header toggle) browse deleted files: trashed study folders plus
//           live studies that hold deleted files; selection offers Restore only
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
    clip: null,          // { kind: "study" | "file", items: [{ path, name, from }] } after Copy
    pacs: [],            // PACS servers from /api/pacs; Send to PACS shows when non-empty
    deleted: false,      // Deleted toggle: browse trashed content, Restore instead of Copy/Delete/PACS
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
  let scanQueued = false;
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

    if (!scanQueued) {
      scanQueued = true;
      requestAnimationFrame(() => { scanQueued = false; scanAndScheduleLazyLoads(); });
    }

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
    if (!rect.width && !rect.height) return 0; // detached or in a hidden view
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
      // Re-check at dispatch time: the user may have scrolled past it while queued.
      if (!getElementZone(topStudy.cardEl)) continue;

      topStudy._loading = true;
      activeCardWorkers++;

      (async () => {
        try {
          await S.hydrate(topStudy);
          fillCard(topStudy);
          if (state.query) applySearch();
          scheduleResort();
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
      // Re-check at dispatch time: the user may have scrolled past it while queued.
      if (!getElementZone(topItem.media.tileEl)) continue;

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
    // The study just left (possibly reached via Prev/Next) becomes the focused
    // card, scrolled to the top row so the user lands where they were.
    const idx = state.current ? visibleStudies().indexOf(state.current) : -1;
    if (idx >= 0) state.focus = idx;
    state.current = null;
    refreshStatusRight();
    updateArchiveFocus(idx >= 0 ? "start" : "nearest");
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

    // Every subfolder is a study card: MVR-named or not, the folder may still
    // hold media or a study_info.yaml.
    const folders = entries.filter((e) => e.is_dir);
    let trashed = [];
    if (state.deleted) {
      try {
        trashed = (await api.list(root, true)).filter((e) => e.is_dir);
      } catch (e) { toast("Could not list deleted entries: " + e.message, true); }
    }

    // When storage has no subfolders (studies), go to file view mode directly!
    if (folders.length === 0 && trashed.length === 0) {
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

    // Newest study first: folder-name timestamp (or mod time) now, and again
    // via resortCards once a study's metadata StudyDate arrives.
    state.studies = folders.map((e) => S.newStudy(root, e)).sort(byDate);
    if (state.deleted) {
      // Only studies holding deleted files belong here, and that takes a
      // listing each: hydrate up front (a few at a time) rather than lazily,
      // so cards do not appear and then vanish while scrolling.
      const live = state.studies;
      let next = 0;
      const worker = async () => {
        while (next < live.length) {
          const s = live[next++];
          try { await S.hydrate(s); } catch (e) { /* card stays, hydrates lazily */ }
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
      if (state.root !== root) return; // storage changed meanwhile
      state.studies = live.filter((s) => !s.hydrated || s.media.length)
        .concat(trashed.map((e) => S.trashedStudy(root, e)))
        .sort(byDate);
    }
    state.focus = 0;
    $("#grid-empty").hidden = state.studies.length > 0;

    const total = state.studies.length;
    $("#study-count").textContent = `${total} stud${total === 1 ? "y" : "ies"}`;

    setupCardObservers();

    for (const study of state.studies) {
      study.cardEl = buildCard(study);
      study.cardEl._study = study;
      study.cardEl.classList.toggle("trashed", study.trashed);
      if (study.hydrated) fillCard(study);
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

  // ---- ordering -------------------------------------------------------------
  const byDate = (a, b) => (S.studyDate(b) || 0) - (S.studyDate(a) || 0);
  let resortTimer = null;
  function scheduleResort() {
    clearTimeout(resortTimer);
    resortTimer = setTimeout(resortCards, 300);
  }
  // resortCards re-orders the grid after hydration changed a study's date,
  // moving only the cards that are out of place and keeping the focus cursor
  // on the same study.
  function resortCards() {
    const focused = visibleStudies()[state.focus];
    state.studies.sort(byDate);
    const grid = $("#grid");
    let moved = false;
    state.studies.forEach((s, i) => {
      if (!s.cardEl || grid.children[i] === s.cardEl) return;
      grid.insertBefore(s.cardEl, grid.children[i] || null);
      moved = true;
    });
    if (!moved) return;
    if (focused) state.focus = Math.max(0, visibleStudies().indexOf(focused));
    if (state.view === "archive") { updateArchiveFocus(); scanAndScheduleLazyLoads(); }
  }

  function buildCard(study) {
    const card = el("div", "card");
    card.dataset.folder = study.folderName;
    if (isCopied(study.path)) card.classList.add("copied");

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
    card.onclick = (e) => { setArchiveFocus(visibleStudies().indexOf(study)); if (e.ctrlKey) toggleSelectArchive(); else openStudy(study); };
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
    if (state.deleted && study.deletedAt) sub.appendChild(el("span", "si deleted-at", "Deleted " + S.formatDate(new Date(study.deletedAt))));

    fillCardThumb(study);
  }

  // Large cards show four evenly spaced stills; smaller cards keep one preview.
  function fillCardThumb(study) {
    const thumb = study.cardEl && study.cardEl.querySelector(".card-thumb");
    if (!thumb) return;
    thumb.innerHTML = "";
    thumb.classList.add("loading");
    thumb.classList.remove("quad");
    const visual = study.media.filter((m) => m.kind === "image" || m.kind === "video");
    if (state.cardSize >= QUAD_CARD_SIZE && visual.length >= 4) {
      thumb.classList.add("quad");
      let remaining = 4;
      for (let i = 0; i < 4; i++) {
        const img = el("img", "thumb-img");
        thumb.appendChild(img);
        loadThumbImg(img, visual[Math.round(i * (visual.length - 1) / 3)], (ok) => {
          if (!ok) img.remove();
          if (!--remaining) thumb.classList.remove("loading");
        });
      }
      return;
    }

    const targetFile = study.thumbFile || visual[0];
    if (!targetFile) {
      thumb.classList.remove("loading");
      addPlaceholder(thumb);
      return;
    }
    const img = el("img", "thumb-img");
    loadThumbImg(img, targetFile, (ok) => {
      thumb.classList.remove("loading");
      if (ok) thumb.appendChild(img); else addPlaceholder(thumb);
    });
  }

  // loadThumbImg loads the server JPEG for an image/video; a video whose
  // thumbnail the server can't make falls back to browser frame capture.
  function loadThumbImg(img, file, done) {
    img.onload = () => done(true);
    img.onerror = () => {
      if (file.kind !== "video") return done(false);
      captureVideoFrame(api.fileURL(file.path), 400).then((data) => {
        if (!data) return done(false);
        img.onerror = () => done(false);
        img.src = data;
      });
    };
    img.src = api.thumbURL(file.path, 400);
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
    // Selections are exclusive (studies or files), so at most one term is non-zero.
    let studies = 0, files = 0;
    for (const s of state.studies) {
      if (s.marked) studies++;
      for (const m of s.media) if (m.selected) files++;
    }
    const sel = studies || files;
    const noun = (kind, n) => kind === "study" ? (n === 1 ? "study" : "studies") : (n === 1 ? "file" : "files");
    const clip = state.clip;
    const parts = [];
    if (clip) parts.push(`${clip.items.length} ${noun(clip.kind, clip.items.length)} copied`);
    if (sel) parts.push(`${sel} ${noun(studies ? "study" : "file", sel)} selected`);
    $("#free-space").textContent = parts.join(" · ");
    const d = state.deleted;
    $("#sel-copy").hidden = !sel || d;
    $("#sel-delete").hidden = !sel || d;
    $("#sel-pacs").hidden = !sel || !state.pacs.length || d;
    $("#sel-restore").hidden = !sel || !d;
    $("#sel-paste").hidden = !clip;
    $("#sel-clear").hidden = !sel && !clip;
    if (clip) {
      const why = pasteBlocker();
      $("#sel-paste").disabled = !!why;
      $("#sel-paste").dataset.tip = why || "Paste (Ctrl+V)";
    }
  }

  // ---- copy / paste ---------------------------------------------------------
  // Studies paste into another storage, files into another study. The same
  // place is refused rather than making "(copy)" duplicates. Copying with a
  // clipboard already present appends to it; Ctrl+click on a green item removes it.
  // selectedItems returns the current selection as { kind, items }, where each
  // item is { path, name, from, study } (from = the container it was picked in).
  function selectedItems() {
    const studies = state.studies.filter((s) => s.marked);
    if (studies.length) return { kind: "study", items: studies.map((s) => ({ path: s.path, name: s.folderName, from: s.root, study: s })) };
    const items = state.studies.flatMap((s) => s.media.filter((m) => m.selected).map((m) => ({ path: m.path, name: m.name, from: s.path, study: s })));
    return { kind: "file", items };
  }
  function copySelection() {
    if (state.deleted) return;
    const { kind, items } = selectedItems();
    if (!items.length) return;
    const clip = state.clip;
    if (clip && clip.kind !== kind) { toast(`Clipboard holds ${clip.kind === "study" ? "studies" : "files"}: clear it first`, true); return; }
    const fresh = clip ? items.filter((i) => !isCopied(i.path)) : items;
    state.clip = { kind, items: clip ? clip.items.concat(fresh) : items };
    deselectAll();
    markCopied();
  }
  function uncopy(path) {
    const items = state.clip.items.filter((i) => i.path !== path);
    state.clip = items.length ? { ...state.clip, items } : null;
    markCopied();
    refreshStatusRight();
  }
  // Green outline on whatever sits in the clipboard, so the user still sees what was copied.
  function isCopied(path) {
    return !!state.clip && state.clip.items.some((i) => i.path === path);
  }
  function markCopied() {
    for (const s of state.studies) {
      if (s.cardEl) s.cardEl.classList.toggle("copied", isCopied(s.path));
      for (const m of s.media) if (m.tileEl) m.tileEl.classList.toggle("copied", isCopied(m.path));
    }
  }
  function pasteBlocker() {
    const clip = state.clip;
    if (!clip) return "Nothing copied";
    if (clip.kind === "study") {
      if (state.view !== "archive") return "Studies paste into a storage: go back to the study list";
      if (clip.items.some((i) => i.from === state.root)) return "Already in this storage: switch to another one";
    } else {
      if (state.view !== "study" || !state.current) return "Files paste into a study: open one";
      if (clip.items.some((i) => i.from === state.current.path)) return "Already in this study: open another one";
    }
    return "";
  }
  async function pasteClip() {
    if (state.deleted) return;
    const why = pasteBlocker();
    if (why) { toast(why, true); return; }
    const clip = state.clip;
    const dest = clip.kind === "study" ? state.root : state.current.path;
    let ok = 0;
    const errors = [];
    for (const it of clip.items) {
      toast(`Copying ${it.name}… (${ok + 1}/${clip.items.length})`);
      try { await api.copy(it.path, MVR.path.join(dest, it.name)); ok++; }
      catch (e) { errors.push(`${it.name}: ${e.message}`); }
    }
    toast(errors.length ? `Copied ${ok}, failed ${errors.length}: ${errors[0]}` : `Copied ${ok} ${ok === 1 ? "item" : "items"}`, !!errors.length);
    if (clip.kind === "study") loadArchive(state.root);
    else { state.current.hydrated = false; openStudy(state.current); }
  }

  // ---- modal (delete confirm / PACS send) ------------------------------------
  // One <dialog> for both flows. onOk runs with a `run` token; closing the
  // dialog (Cancel/x) during work sets run.cancel so a loop stops early.
  // run.finish() swaps the buttons to a single Close once work is done.
  function openModal(title, bodyEl, okLabel, okClass, onOk) {
    const dlg = $("#modal"), ok = $("#modal-ok"), cancel = $("#modal-cancel");
    $("#modal-title").textContent = title;
    const body = $("#modal-body"); body.innerHTML = ""; body.appendChild(bodyEl);
    ok.textContent = okLabel; ok.className = okClass; ok.hidden = false; ok.disabled = false;
    cancel.textContent = "Cancel";
    const run = { cancel: false, finish() { ok.hidden = true; cancel.textContent = "Close"; } };
    ok.onclick = () => { ok.disabled = true; onOk(run); };
    dlg.onclose = () => { run.cancel = true; };
    dlg.showModal();
    return run;
  }
  function firstNames(items) {
    const ul = el("ul");
    for (const it of items.slice(0, 3)) ul.appendChild(el("li", null, it.name));
    if (items.length > 3) ul.appendChild(el("li", "muted", `... and ${items.length - 3} more`));
    return ul;
  }
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + "s")}`;

  async function hydrateAll(items) {
    await Promise.all(items.map((it) => it.study.hydrated ? null : S.hydrate(it.study).then(() => fillCard(it.study))));
  }
  // After files or studies vanish, reload what showed them.
  function reloadAfter(kind, items) {
    if (kind === "study" || state.deleted) { loadArchive(state.root); return; }
    const touched = new Set(items.map((it) => it.study));
    for (const st of touched) {
      st.hydrated = false;
      if (st !== state.current) S.hydrate(st).then(() => fillCard(st)).catch(() => {});
    }
    if (state.current && touched.has(state.current)) openStudy(state.current);
  }

  async function restoreSelection() {
    const { kind, items } = selectedItems();
    if (!items.length) return;
    let ok = 0; const errors = [];
    for (const it of items) {
      toast(`Restoring ${it.name}... (${ok + 1}/${items.length})`);
      try { await api.restore(it.path); ok++; } catch (e) { errors.push(`${it.name}: ${e.message}`); }
    }
    deselectAll();
    toast(errors.length ? `Restored ${ok}, failed ${errors.length}: ${errors[0]}` : `Restored ${plural(ok, "item")}`, !!errors.length);
    reloadAfter(kind, items);
  }

  async function deleteSelection() {
    if (state.deleted) return;
    const { kind, items } = selectedItems();
    if (!items.length) return;
    const body = el("div");
    if (kind === "study") {
      await hydrateAll(items);
      const files = items.reduce((n, it) => n + it.study.media.length, 0);
      body.appendChild(el("div", null, `${plural(items.length, "folder")}, ${plural(files, "file")}`));
    } else {
      body.appendChild(el("div", null, plural(items.length, "file")));
    }
    body.appendChild(firstNames(items));
    openModal("Delete", body, "Delete", "danger", async (run) => {
      const prog = el("div", "progress"); body.appendChild(prog);
      let ok = 0; const errors = [];
      for (const it of items) {
        if (run.cancel) break;
        prog.textContent = `Deleting ${it.name}... (${ok + 1}/${items.length})`;
        try { await api.del(it.path); ok++; } catch (e) { errors.push(`${it.name}: ${e.message}`); }
      }
      $("#modal").close();
      deselectAll();
      toast(errors.length ? `Deleted ${ok}, failed ${errors.length}: ${errors[0]}` : `Deleted ${plural(ok, "item")}`, !!errors.length);
      reloadAfter(kind, items);
    });
  }

  async function sendToPacs() {
    if (state.deleted) return;
    const { kind, items } = selectedItems();
    if (!items.length || !state.pacs.length) return;
    if (kind === "study") await hydrateAll(items);
    const all = kind === "study"
      ? items.flatMap((it) => it.study.media.map((m) => ({ path: m.path, name: m.name, study: it.study })))
      : items;
    const files = all.filter((f) => S.pacsSendable(f.name));
    const skipped = all.length - files.length;
    const body = el("div");
    const sel = el("select");
    for (const p of state.pacs) { const o = el("option", null, `${p.name} (${p.aet}@${p.host}:${p.port})`); o.value = p.name; sel.appendChild(o); }
    body.appendChild(el("div", null, "PACS server"));
    body.appendChild(sel);
    body.appendChild(el("div", null, `${plural(files.length, "file")} to send` + (skipped ? ` (${skipped} skipped: only JPEG, BMP and DICOM can be sent)` : "")));
    body.appendChild(firstNames(files));
    openModal("Send to PACS", body, "Send", "primary", async (run) => {
      sel.disabled = true;
      const prog = el("div", "progress"); body.appendChild(prog);
      const errBox = el("div", "errors"); body.appendChild(errBox);
      let ok = 0; const errors = [];
      for (const f of files) {
        if (run.cancel) break;
        prog.textContent = `Sending ${f.name}... (${ok + errors.length + 1}/${files.length})`;
        try { await api.pacsSend(sel.value, f.path, S.dicomTags(f.study)); ok++; }
        catch (e) { errors.push(`${f.name}: ${e.message}`); errBox.textContent = errors.join("\n"); }
      }
      prog.textContent = run.cancel ? `Cancelled after ${ok} sent` : `Sent ${ok} of ${files.length}` + (errors.length ? `, ${errors.length} failed` : "");
      run.finish();
    });
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
  function updateArchiveFocus(block = "nearest") {
    state.studies.forEach((s) => s.cardEl && s.cardEl.classList.remove("focused"));
    const vis = visibleStudies();
    if (!vis.length) return;
    state.focus = Math.max(0, Math.min(state.focus, vis.length - 1));
    const currentStudy = vis[state.focus];
    const elc = currentStudy.cardEl;
    elc.classList.add("focused");
    elc.scrollIntoView({ block });
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
      // Fill the card too: the lazy scheduler skips hydrated studies, so a card
      // hydrated here (Prev/Next into an unseen study) would otherwise stay blank.
      try { await S.hydrate(study); fillCard(study); scheduleResort(); } catch (e) { toast(e.message, true); }
    }
    const c = study.counters;
    const bits = [];
    const dt = S.formatDate(S.studyDate(study));
    if (dt) bits.push(dt);
    bits.push(`${c.images} image${c.images === 1 ? "" : "s"}`, `${c.videos} video${c.videos === 1 ? "" : "s"}`);
    if (c.pdfs) bits.push(`${c.pdfs} report${c.pdfs === 1 ? "" : "s"}`);
    if (c.size) bits.push(S.fmtSize(c.size));
    $("#detail-sub").textContent = bits.filter(Boolean).join(" · ");

    state.mediaFocus = 0;
    refreshStatusRight();
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

      // Single compact caption: kind icon + file name.
      const iconName = m.kind === "video" ? "ic_video" : m.kind === "pdf" ? "ic_pdf" : "ic_image";
      const cap = el("span", "cap");
      cap.appendChild(icon(iconName));
      cap.appendChild(el("span", "cap-name", m.name));
      tile.appendChild(cap);
      const ic = icon(iconName, "ic");
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

      if (m.selected) tile.classList.add("selected");
      if (isCopied(m.path)) tile.classList.add("copied");
      tile.onclick = (e) => { setMediaFocus(idx); if (e.ctrlKey) toggleSelectMedia(); else openViewer(study, idx); };
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
  // Study and file selections are mutually exclusive: picking one kind clears the other.
  function setStudySelected(s, on) {
    s.marked = on;
    if (s.cardEl) s.cardEl.classList.toggle("marked", on);
  }
  function setMediaSelected(m, on) {
    m.selected = on;
    if (m.tileEl) m.tileEl.classList.toggle("selected", on);
  }
  function clearSelection() {
    state.clip = null;
    markCopied();
    deselectAll();
  }
  function deselectAll() {
    for (const s of state.studies) {
      if (s.marked) setStudySelected(s, false);
      for (const m of s.media) if (m.selected) setMediaSelected(m, false);
    }
    refreshStatusRight();
  }
  function toggleSelectArchive() {
    const s = visibleStudies()[state.focus];
    if (!s) return;
    if (isCopied(s.path)) { uncopy(s.path); return; }
    const on = !s.marked;
    if (on) for (const st of state.studies) for (const m of st.media) if (m.selected) setMediaSelected(m, false);
    setStudySelected(s, on);
    refreshStatusRight();
  }
  function toggleSelectMedia() {
    const m = state.current && state.current.media[state.mediaFocus];
    if (!m) return;
    if (isCopied(m.path)) { uncopy(m.path); return; }
    const on = !m.selected;
    if (on) for (const st of state.studies) if (st.marked) setStudySelected(st, false);
    setMediaSelected(m, on);
    refreshStatusRight();
  }
  function selectAll() {
    if (state.view === "archive") {
      for (const st of state.studies) for (const m of st.media) if (m.selected) setMediaSelected(m, false);
      for (const s of visibleStudies()) setStudySelected(s, true);
    } else if (state.current) {
      for (const st of state.studies) if (st.marked) setStudySelected(st, false);
      for (const m of state.current.media) setMediaSelected(m, true);
    }
    refreshStatusRight();
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
    if (m.size) parts.push(S.fmtSize(m.size));
    if (m.kind === "image" || m.kind === "video") {
      if (m.width && m.height) parts.push(`${m.width} x ${m.height}`);
      parts.push(`zoom ${Math.round(state.viewer.scale * 100)}%`);
    }
    return `${parts.join("  ·  ")}  ${counter}`;
  }
  function updateViewerName() {
    const m = state.viewer.media[state.viewer.index];
    if (m) $("#viewer-name").textContent = viewerLabel(m);
    updateViewerSelect();
  }
  // Select button and stage frame mirror the tile: yellow selected, green copied.
  function updateViewerSelect() {
    const m = state.viewer.media[state.viewer.index];
    if (!m) return;
    const st = m.selected ? "selected" : isCopied(m.path) ? "copied" : "";
    $("#viewer").className = "viewer" + (st ? " " + st : "");
    $("#viewer-select").textContent = st === "selected" ? "Selected ✓" : st === "copied" ? "Copied ✓" : "Select";
  }
  function viewerToggleSelect() {
    setMediaFocus(state.viewer.index);
    toggleSelectMedia();
    updateViewerSelect();
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

    // DICOM is rendered server-side by DCMTK (thumbnail endpoint): the pixel
    // data needs windowing/decompression a browser cannot do, and a multiframe
    // instance shows its middle frame. Both image- and video-prefixed .dcm end
    // up as one still. The endpoint returns the source resolution (bounded to
    // 4096 px per side) for DICOM, so no w hint is sent.
    const ext = MVR.path.extname(m.name);
    const isDicom = ext === "dcm" || ext === "dicom";
    $("#viewer-info").hidden = !isDicom;
    if (isDicom) return showImage(m, stage, api.thumbURL(m.path));
    if (m.kind === "image") return showImage(m, stage);

    // Heavy media: stream straight from the read URL (Range-capable), so video
    // seeks natively and PDFs render with their real content-type.
    clearStage();
    if (m.kind === "video") {
      const v = document.createElement("video");
      v.src = api.fileURL(m.path); v.controls = true; v.autoplay = true; v.playsInline = true; v.loop = true;
      v.onloadedmetadata = () => { m.width = v.videoWidth; m.height = v.videoHeight; if (state.viewer.img === v) updateViewerName(); };
      stage.appendChild(v);
      // Video zooms with the same wheel/pinch machinery as images; it starts fit
      // to the stage (CSS max-width/height) at 100%.
      state.viewer.img = v;
      resetZoomVars();
      applyZoom();
    } else if (m.kind === "pdf") {
      const f = document.createElement("iframe");
      f.src = api.fileURL(m.path); stage.appendChild(f);
    }
  }

  // showImage decodes the next image off-DOM, then swaps it in over the current
  // one instantly (no blank stage, no fade). A sequence token guards against
  // out-of-order loads during fast stepping; zoom/pan carry over.
  async function showImage(m, stage, url) {
    const seq = ++state.viewer.seq;
    const oldImg = state.viewer.img;
    let placeholder = null;
    if (!oldImg) { clearStage(); placeholder = el("div", "msg", "Loading…"); stage.appendChild(placeholder); }

    const img = document.createElement("img");
    img.draggable = false;
    try {
      await decodeImg(img, url || api.fileURL(m.path));
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

  async function showDicomTags() {
    const m = state.viewer.media[state.viewer.index];
    if (!m) return;
    $("#dicom-title").textContent = m.name;
    $("#dicom-tags").textContent = "Loading…";
    $("#dicom-dialog").showModal();
    try {
      $("#dicom-tags").textContent = (await api.dicomDump(m.path)).trim() || "No tags returned.";
    } catch (e) {
      $("#dicom-tags").textContent = "Could not read DICOM tags: " + e.message;
    }
  }

  // At 1x a video keeps its native controls, so pointer/touch drags are left
  // alone; once zoomed, dragging pans it like an image.
  function zoomTargetGrabs() {
    const v = state.viewer;
    return !!v.img && (v.img.tagName !== "VIDEO" || v.scale !== 1);
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
    if (!v.open || !zoomTargetGrabs()) return;
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

    if (document.querySelector("dialog[open]")) return; // dialogs handle their own Esc
    if (state.viewer.open) {
      if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
      else if (e.key === "Escape") { closeViewer(); }
      else if (e.key === "Enter") { resetZoomVars(); applyZoom(); } // re-fit
      else if (e.key === " ") { e.preventDefault(); viewerToggleSelect(); }
      else if (e.ctrlKey && (e.key === "c" || e.key === "C")) { copySelection(); updateViewerSelect(); }
      return;
    }

    const arrows = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

    if (e.ctrlKey && (e.key === "a" || e.key === "A")) { e.preventDefault(); selectAll(); return; }
    if (e.ctrlKey && (e.key === "c" || e.key === "C")) { copySelection(); return; }
    if (e.ctrlKey && (e.key === "v" || e.key === "V")) { pasteClip(); return; }
    if (e.key === "Delete") { deleteSelection(); return; }

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
      if (zoomTargetGrabs()) {
        v.touch = { mode: "pan", x: t.clientX, y: t.clientY, tx: v.tx, ty: v.ty };
        e.preventDefault();
      } else if (v.img) {
        v.touch = null;   // let native video controls take the tap
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
    $("#viewer-select").onclick = viewerToggleSelect;
    $("#viewer-info").onclick = showDicomTags;
    $("#dicom-close").onclick = () => $("#dicom-dialog").close();
    $("#viewer-back").onclick = closeViewer;
    $("#viewer-prev").onclick = () => step(-1);
    $("#viewer-next").onclick = () => step(1);

    const search = $("#search");
    search.oninput = () => { state.query = search.value; applySearch(); };
    $("#sel-copy").onclick = copySelection;
    $("#sel-paste").onclick = pasteClip;
    $("#sel-clear").onclick = clearSelection;
    $("#sel-delete").onclick = deleteSelection;
    $("#sel-restore").onclick = restoreSelection;
    $("#btn-deleted").onclick = () => {
      state.deleted = S.showDeleted = !state.deleted;
      $("#btn-deleted").setAttribute("aria-pressed", String(state.deleted));
      $("#btn-deleted").dataset.tip = state.deleted ? "Show current files" : "Show deleted files";
      clearSelection();
      loadArchive(state.root);
    };
    $("#sel-pacs").onclick = sendToPacs;
    $("#modal-close").onclick = $("#modal-cancel").onclick = () => $("#modal").close();
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
      const [roots, pacs] = await Promise.all([api.roots(), api.pacs()]);
      state.pacs = pacs;
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
