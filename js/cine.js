// Bounded, per-viewer DICOM playback. Only the current frame is decoded by the
// viewer; compressed JPEG URLs are released on close or file navigation.
(function () {
  "use strict";
  window.MVR.cine = { open };

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
        if (data.frames.length < 2) { bar.hidden = true; return; }
        for (const frame of data.frames) {
          const bytes = Uint8Array.from(atob(frame), c => c.charCodeAt(0));
          urls.push(URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" })));
        }
        bar.innerHTML = '<button type="button" class="ghost">Pause</button>' +
          '<input type="range" min="1" value="1" step="1" aria-label="DICOM frame">' +
          '<span class="cine-counter"></span>' +
          '<select aria-label="Playback speed"><option value="auto" selected>Auto</option><option value="500">2 fps</option>' +
          '<option value="250">4 fps</option><option value="125">8 fps</option>' +
          '<option value="66.667">15 fps</option><option value="33.333">30 fps</option></select>' +
          '<button type="button" class="ghost" aria-label="Previous frame" title="Previous frame (Arrow Up)" hidden>↑ Prev</button>' +
          '<button type="button" class="ghost" aria-label="Next frame" title="Next frame (Arrow Down)" hidden>Next ↓</button>';
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
        async function display(next) {
          clearTimeout(timer);
          requested = next;
          const token = ++revision;
          const started = performance.now();
          try {
            await showFrame(urls[next]);
            if (controller.signal.aborted || token !== revision) return;
            index = next;
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
})();
