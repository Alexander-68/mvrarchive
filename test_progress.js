// progress(): the shared Paste / Send to PACS batch runner.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const ui = fs.readFileSync(__dirname + "/js/ui.js", "utf8");
const src = ui.slice(ui.indexOf("  const fmtDur = "), ui.indexOf("  async function hydrateAll("));
const el = () => ({ textContent: "" });
const ctx = { el, setInterval: () => 0, clearInterval() {}, Date };
vm.runInNewContext(src + ";this.progress = progress;", ctx);
const body = { append(...n) { this.kids = n; } };

(async () => {
  // Two workers; worker 0 alone takes videos, so two videos never overlap.
  const p = ctx.progress(body);
  const files = ["a.mp4", "b.jpg", "c.mp4", "d.jpg", "bad.jpg"].map((name) => ({ name, size: 10 }));
  let videos = 0, maxVideos = 0;
  await p.run(files, { cancel: false }, {
    verb: "Sending", workers: 2, etaAfter: 10, weight: (f) => f.size,
    pick: (w, q) => (w === 0 ? 0 : q.findIndex((f) => !f.name.endsWith(".mp4"))),
    each: async (f) => {
      const v = f.name.endsWith(".mp4");
      if (v) maxVideos = Math.max(maxVideos, ++videos);
      await new Promise((r) => setImmediate(r));
      if (v) videos--;
      if (f.name === "bad.jpg") throw Error("refused");
    },
  });
  assert.equal(p.ok, 4);
  assert.deepEqual([...p.errors], ["bad.jpg: refused"]);
  assert.equal(body.kids[2].textContent, "bad.jpg: refused");
  assert.equal(body.kids[1].value, 1, "bar full when done");
  assert.equal(maxVideos, 1);

  // Cancel stops taking new files.
  const run = { cancel: false };
  const q = ctx.progress(body);
  await q.run(files, run, { verb: "Copying", workers: 1, etaAfter: 5, weight: () => 1, each: async () => { run.cancel = true; } });
  assert.equal(q.ok, 1);
  console.log("test_progress: ok");
})().catch((e) => { console.error(e); process.exit(1); });
