const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const timers = new Map(), shown = [], revoked = [];
let nextTimer = 0, nextURL = 0, signal;
const MVR = { api: { dicomFrames: async (path, s) => { signal = s; return { frames: ["YQ==", "Yg==", "Yw=="] }; } } };
vm.runInNewContext(fs.readFileSync(__dirname + "/js/cine.js", "utf8"), {
  window: { MVR }, AbortController, Uint8Array, atob, Blob, performance: { now: () => 0 },
  URL: { createObjectURL: () => "blob:" + nextURL++, revokeObjectURL: url => revoked.push(url) },
  setTimeout: (fn, ms) => { timers.set(++nextTimer, { fn, ms }); return nextTimer; },
  clearTimeout: id => timers.delete(id),
});
const flush = () => new Promise(resolve => setImmediate(resolve));
const bar = () => ({ children: [{}, { value: 1 }, {}, { value: "auto", options: [{}] }] });
async function tick() {
  assert.equal(timers.size, 1);
  const [id, timer] = [...timers][0]; timers.delete(id); timer.fn(); await flush();
}

(async () => {
  const controls = bar();
  const stop = MVR.cine.open("cine.dcm", controls, async url => { shown.push(url); });
  await flush();
  const [button, slider, counter, speed] = controls.children;
  assert.equal(counter.textContent, "Frame 1 / 3");
  assert.equal([...timers.values()][0].ms, 125);
  assert.equal(speed.options[0].textContent, "Auto (8 fps)");
  await tick(); await tick(); await tick();
  assert.deepEqual(shown, ["blob:0", "blob:1", "blob:2", "blob:0"]);
  button.onclick(); assert.equal(button.textContent, "Play"); assert.equal(timers.size, 0);
  slider.value = 3; slider.oninput(); await flush();
  assert.equal(counter.textContent, "Frame 3 / 3"); assert.equal(timers.size, 0);
  speed.value = "125"; speed.onchange(); button.onclick();
  assert.equal([...timers.values()][0].ms, 125);
  stop(); assert.equal(signal.aborted, true); assert.equal(timers.size, 0);
  assert.deepEqual(revoked, ["blob:0", "blob:1", "blob:2"]); assert.equal(controls.hidden, true);

  let resolve;
  MVR.api.dicomFrames = () => new Promise(r => { resolve = r; });
  const pending = bar();
  const cancel = MVR.cine.open("slow.dcm", pending, () => { throw Error("stale frame displayed"); });
  cancel(); resolve({ frames: ["YQ==", "Yg=="] }); await flush();
  assert.equal(nextURL, 3); assert.equal(pending.hidden, true);

  MVR.api.dicomFrames = async () => ({ frames: ["YQ==", "Yg==", "Yw=="], frameTimesMs: [40, 80, 80] });
  const timed = bar();
  const stopTimed = MVR.cine.open("timed.dcm", timed, async () => {}); await flush();
  assert.equal([...timers.values()][0].ms, 40);
  assert.equal(timed.children[3].options[0].textContent, "Auto (25 fps)");
  await tick(); assert.equal([...timers.values()][0].ms, 80);
  assert.equal(timed.children[3].options[0].textContent, "Auto (12.5 fps)");
  timed.children[3].value = "500"; timed.children[3].onchange();
  assert.equal([...timers.values()][0].ms, 500);
  assert.equal(timed.children[3].options[0].textContent, "Auto (12.5 fps)");
  timed.children[3].value = "auto"; timed.children[3].onchange();
  assert.equal([...timers.values()][0].ms, 80);
  await tick(); await tick(); assert.equal([...timers.values()][0].ms, 40);
  assert.equal(timed.children[3].options[0].textContent, "Auto (25 fps)");
  stopTimed();

  for (const bad of [0, -1, null, "40", Infinity, NaN, 1e99]) {
    MVR.api.dicomFrames = async () => ({ frames: ["YQ==", "Yg=="], frameTimesMs: [bad, bad] });
    const stopBad = MVR.cine.open("bad-timing.dcm", bar(), async () => {}); await flush();
    assert.equal([...timers.values()][0].ms, 125); stopBad();
  }

  MVR.api.dicomFrames = async () => ({ frames: [] });
  const single = bar(); MVR.cine.open("single.dcm", single, () => assert.fail()); await flush();
  assert.equal(single.hidden, true);
  MVR.api.dicomFrames = async () => { throw Error("unsupported codec"); };
  const failed = bar(); MVR.cine.open("bad.dcm", failed, () => assert.fail()); await flush();
  assert.match(failed.textContent, /unsupported codec/);
  console.log("Cine playback: loop, pause, seek, speed, cancellation, cleanup and fallback passed.");
})().catch(e => { console.error(e); process.exitCode = 1; });
