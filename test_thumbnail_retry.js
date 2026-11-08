const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const MVR = {};
let calls = 0, status = 502;
vm.runInNewContext(fs.readFileSync(__dirname + "/js/api.js", "utf8"), {
  window: { MVR }, location: {}, setTimeout, clearTimeout, AbortSignal,
  fetch: async () => {
    calls++;
    return status === 200 ? new Response("jpg") : new Response(JSON.stringify({ error: "x" }), { status, headers: { "Retry-After": "0.1" } });
  },
});

(async () => {
  setTimeout(() => { console.error("timeout"); process.exit(1); }, 15000).unref();
  for (const s of [502, 504, 429, 503]) {
    calls = 0; status = s;
    await assert.rejects(MVR.api.thumbnail("/a.jpg", 64), (e) => e.status === s);
    assert.equal(calls, 6, `${s}: first try + 5 retries`);
  }
  calls = 0; status = 200;
  assert.equal(await (await MVR.api.thumbnail("/a.jpg", 64)).text(), "jpg");
  console.log("ok");
})();
