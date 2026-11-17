// Browser check for video frame stepping. Needs ffmpeg on PATH and Playwright
// (PLAYWRIGHT env overrides the default install path).
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs"), http = require("node:http"), os = require("node:os"), path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT || "C:/Alex/mvr_annotate/node_modules/playwright");

// 25 fps, 25 frames; luma = 16 + 8 * frame number so the shown frame is checkable.
const clip = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mvr-step-")), "clip.webm");
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=black:s=64x64:r=25:d=1",
  "-vf", "format=yuv420p,geq=lum='16+8*N':cb=128:cr=128", "-c:v", "libvpx-vp9", "-crf", "10", "-b:v", "0", clip]);

const page = `<div id="bar"></div><video id="v" muted autoplay loop></video><canvas id="c" width="1" height="1"></canvas>
<script>window.MVR = {};</script><script src="/cine.js"></script>
<script>fetch("/clip.webm").then(r => r.blob()).then(b => { v.src = URL.createObjectURL(b); }); // blob: seekable without Range
stop = MVR.cine.video(v, bar);
red = () => { const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(v, 0, 0, 1, 1); return x.getImageData(0, 0, 1, 1).data[0]; };</script>`;
const server = http.createServer((req, res) => {
  if (req.url === "/clip.webm") return res.end(fs.readFileSync(clip));
  if (req.url === "/cine.js") return res.end(fs.readFileSync(path.join(__dirname, "js/cine.js")));
  res.setHeader("content-type", "text/html"); res.end(page);
}).listen(0);

(async () => {
  const browser = await chromium.launch();
  try {
    const p = await browser.newPage();
    await p.goto(`http://127.0.0.1:${server.address().port}/`);
    await p.waitForFunction(() => v.currentTime > 0.3); // rVFC has measured fps by now
    const shown = () => p.evaluate(() => new Promise(r => {
      const done = () => r({ text: bar.children[1].textContent, frame: Math.round(red() * 219 / 255 / 8) });
      v.seeking ? v.addEventListener("seeked", done, { once: true }) : done();
    }));
    await p.keyboard.press("ArrowDown"); // playing: pause only
    assert.equal(await p.evaluate(() => v.paused), true);
    await p.waitForTimeout(200); // last presented-frame callback lands just after pause
    const start = await shown();
    const n = Number(start.text.match(/Frame (\d+) \/ 25/)[1]);
    assert.equal(start.frame, n - 1);
    await p.keyboard.press("ArrowDown");
    assert.deepEqual(await shown(), { text: `Frame ${n + 1} / 25`, frame: n });
    await p.click("button[aria-label='Previous frame']");
    await p.click("button[aria-label='Previous frame']");
    assert.deepEqual(await shown(), { text: `Frame ${n - 1} / 25`, frame: n - 2 });
    await p.click("button[aria-label='Next frame']");
    assert.deepEqual(await shown(), { text: `Frame ${n} / 25`, frame: n - 1 });
    // Right after a pause, two clicks before the first seek's events fire must step twice.
    await p.evaluate(() => v.play());
    await p.waitForTimeout(200);
    await p.keyboard.press("ArrowDown");
    await p.waitForTimeout(200);
    const m = Number((await shown()).text.match(/Frame (\d+)/)[1]);
    await p.evaluate(() => { bar.children[2].click(); bar.children[2].click(); });
    assert.deepEqual(await shown(), { text: `Frame ${m + 2} / 25`, frame: m + 1 });
    // Clamped at both ends.
    await p.evaluate(() => { v.currentTime = 0.01; });
    await p.keyboard.press("ArrowUp");
    assert.deepEqual(await shown(), { text: "Frame 1 / 25", frame: 0 });
    await p.evaluate(() => { v.currentTime = 0.99; });
    await p.keyboard.press("ArrowDown");
    assert.deepEqual(await shown(), { text: "Frame 25 / 25", frame: 24 });
    await p.evaluate(() => stop());
    assert.equal(await p.evaluate(() => bar.hidden && bar.textContent === ""), true);
    console.log("Video frame stepping: fps detection, pause, step, clamp and cleanup passed.");
  } finally { await browser.close(); server.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
