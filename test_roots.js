const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const MVR = {}, location = {}, requests = [];
let responses = [];
vm.runInNewContext(fs.readFileSync(__dirname + "/js/api.js", "utf8"), {
  window: { MVR }, location,
  fetch: async (url) => {
    requests.push(url);
    assert.ok(responses.length, "unexpected extra request");
    return responses.shift();
  },
});
const rootPage = (roots) => new Response(JSON.stringify({ roots }));

(async () => {
  requests.length = 0;
  responses = [rootPage([
    { name: "DATA", writable: true },
    { name: "priv_data", writable: true },
    { name: "PRIV_DATA", writable: true },
    { name: "NAS", writable: false },
  ])];
  assert.deepEqual([...await MVR.api.roots()], ["/DATA", "/NAS"], "private app store omitted");
  assert.ok(MVR.api.readOnly.has("/NAS"), "read-only share still reported");
  assert.deepEqual(requests, ["api/roots"]);

  // Legacy gateways may report absolute paths; hide the private store there too.
  responses = [rootPage([
    "C:\\store\\priv_data",
    "C:\\store\\studies",
    "/priv_data",
  ])];
  assert.deepEqual([...await MVR.api.roots()], ["C:\\store\\studies"]);

  responses = [rootPage([{ name: "priv_data", writable: true }])];
  assert.deepEqual([...await MVR.api.roots()], [], "only the private store means no browsable roots");

  responses = [rootPage(null)];
  assert.deepEqual([...await MVR.api.roots()], [], "missing roots list tolerated");
  assert.equal(MVR.api.readOnly.size, 0, "stale read-only state cleared");

  console.log("Storage roots: passed (private app store hidden, read-only shares preserved)");
})().catch(error => { console.error(error); process.exitCode = 1; });