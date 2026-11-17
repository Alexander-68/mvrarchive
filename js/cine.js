// Bounded, per-viewer DICOM playback. Only the current frame is decoded by the
// viewer; compressed JPEG URLs are released on close or file navigation.
(function () {
  "use strict";
  window.MVR.cine = { open, video };

  function open(path, bar, showFrame) {
    const controller = new AbortController();
    const urls = [];
    let timer, playing = false, index = 0, requested = 0, revision = 0, handleKey;
    bar.hidden = false;
    bar.textContent = "Preparing frames…";

    (async () => {
      try {
        const data = await window.MVR.api.dicomFrames(path, controller.signal);
        if (controller.signal.aborted) return;
        if (!Array.isArray(data?.frames) || data.frames.length < 2) { bar.hidden = true; return; }
        for (const frame of data.frames) {
          const bytes = Uint8Array.from(atob(frame), (c) => c.charCodeAt(0));
          urls.push(URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" })));
        }
        bar.innerHTML = '<button type="button" class="ghost">Pause</button>' +
          '<input type="range" min="1" value="1" step="1" aria-label="DICOM frame">' +
          '<span class="cine-counter"></span>' +
          '<select aria-label="Playback speed"><option value="auto" selected>Auto</option><option value="500">2 fps</option>' +
          '<option value="250">4 fps</option><option value="125">8 fps</option>' +
          '<option value="66.667">15 fps</option><option value="33.333">30 fps</option></select>' +
          '<button type="button" class="ghost" aria-label="Previous frame" title="Previous frame (Arrow Up)" hidden><strong class="cine-arrow" aria-hidden="true">↑</strong> Prev</button>' +
          '<button type="button" class="ghost" aria-label="Next frame" title="Next frame (Arrow Down)" hidden>Next <strong class="cine-arrow" aria-hidden="true">↓</strong></button>';
        const [button, slider, counter, speed, prev, next] = bar.children;
        const frameTimes = data.frameTimesMs;
        slider.max = urls.length;
        // Up/down control frames; other keys retain native control behavior.
        bar.onkeydown = e => { handleKey(e); if (e.key !== "Escape") e.stopPropagation(); };
        const schedule = (decodeMS = 0) => {
          clearTimeout(timer);
          const autoMS = frameTimes?.[index];
          const autoInterval = Number.isFinite(autoMS) && autoMS > 0 && autoMS <= 2147483647 ? autoMS : 125;
          speed.options[0].textContent = `Auto (${Number((1000 / autoInterval).toFixed(1))} fps)`;
          const interval = speed.value === "auto" ? autoInterval : Number(speed.value);
          if (playing && !controller.signal.aborted) timer = setTimeout(() => display((index + 1) % urls.length), Math.max(0, interval - decodeMS));
        };
        async function display(frame) {
          clearTimeout(timer);
          requested = frame;
          const token = ++revision;
          const started = performance.now();
          try {
            await showFrame(urls[frame]);
            if (controller.signal.aborted || token !== revision) return;
            index = frame;
            slider.value = index + 1;
            counter.textContent = `Frame ${index + 1} / ${urls.length}`;
            schedule(performance.now() - started);
          } catch (e) { if (token === revision) fail(e); }
        }
        function setPlaying(value) {
          playing = value;
          button.textContent = playing ? "Pause" : "Play";
          prev.hidden = next.hidden = playing;
          schedule();
        }
        const stepFrame = delta => display((requested + delta + urls.length) % urls.length);
        button.onclick = () => setPlaying(!playing);
        prev.onclick = () => stepFrame(-1);
        next.onclick = () => stepFrame(1);
        handleKey = e => {
          if (document.querySelector("dialog[open]") || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
          e.preventDefault();
          if (playing) setPlaying(false);
          else stepFrame(e.key === "ArrowUp" ? -1 : 1);
        };
        document.addEventListener("keydown", handleKey, { signal: controller.signal });
        slider.oninput = () => {
          setPlaying(false);
          display(Number(slider.value) - 1);
        };
        speed.onchange = () => schedule();
        setPlaying(true);
        await display(0);
      } catch (e) { fail(e); }
    })();

    function fail(e) {
      clearTimeout(timer);
      playing = false;
      if (handleKey) document.removeEventListener("keydown", handleKey);
      if (!controller.signal.aborted) bar.textContent = "Frame playback unavailable: " + e.message;
    }
    return () => {
      controller.abort();
      clearTimeout(timer);
      for (const url of urls) URL.revokeObjectURL(url);
      urls.length = 0;
      bar.hidden = true;
      bar.textContent = "";
      bar.onkeydown = null;
    };
  }

  // video adds frame stepping beside a native <video>'s own controls. HTML video
  // exposes no frame rate, so it is measured from requestVideoFrameCallback
  // (smallest mediaTime delta seen), else assumed 30 fps. After pause() Chrome's
  // currentTime trails the frame on screen, so stepping counts from the
  // presented frame's mediaTime; seeks land mid-frame so rounding never repeats
  // or skips a frame.
  function video(v, bar) {
    const controller = new AbortController();
    let dt = 1 / 30, measured = false, presented = null;
    bar.hidden = false;
    bar.innerHTML = '<button type="button" class="ghost" aria-label="Previous frame" title="Previous frame (Arrow Up)"><strong class="cine-arrow" aria-hidden="true">↑</strong> Prev</button>' +
      '<span class="cine-counter"></span>' +
      '<button type="button" class="ghost" aria-label="Next frame" title="Next frame (Arrow Down)">Next <strong class="cine-arrow" aria-hidden="true">↓</strong></button>';
    const [prev, counter, next] = bar.children;
    const frame = () => presented === null ? Math.floor(v.currentTime / dt + 0.01) : Math.round(presented / dt);
    const show = () => {
      const total = Math.round(v.duration / dt);
      counter.textContent = Number.isFinite(total) && total > 0 ? `Frame ${Math.min(frame() + 1, total)} / ${total}` : "";
    };
    const measure = (now, md) => {
      if (controller.signal.aborted) return;
      // Only consecutive presented frames are compared: seeks clear `presented`.
      const d = presented === null ? 0 : md.mediaTime - presented;
      if (d > 0.001 && (!measured || d < dt)) { dt = d; measured = true; }
      presented = md.mediaTime;
      show();
      v.requestVideoFrameCallback(measure);
    };
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(measure);
    const stepFrame = delta => {
      v.pause();
      const max = Math.max(0, Math.round(v.duration / dt) - 1) || 0;
      v.currentTime = (Math.min(max, Math.max(0, frame() + delta)) + 0.5) * dt;
      presented = null; // "seeking" fires async; a quick second step must count from the target
      show();
    };
    prev.onclick = () => stepFrame(-1);
    next.onclick = () => stepFrame(1);
    v.addEventListener("seeking", () => { presented = null; }, { signal: controller.signal });
    for (const type of ["loadedmetadata", "timeupdate", "seeked", "pause"]) v.addEventListener(type, show, { signal: controller.signal });
    document.addEventListener("keydown", e => {
      if (e.defaultPrevented || document.querySelector("dialog[open]") || (e.key !== "ArrowUp" && e.key !== "ArrowDown") ||
        /^(INPUT|SELECT|TEXTAREA)$/.test(e.target?.tagName)) return;
      e.preventDefault();
      if (!v.paused) v.pause();
      else stepFrame(e.key === "ArrowUp" ? -1 : 1);
    }, { signal: controller.signal });
    show();
    return () => {
      controller.abort();
      bar.hidden = true;
      bar.textContent = "";
    };
  }
})();
