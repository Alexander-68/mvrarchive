const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const MVR = {};
let response, request, networkError = false;
const location = {};
vm.runInNewContext(fs.readFileSync(__dirname + "/js/api.js", "utf8"), {
  window: { MVR }, location, AbortSignal,
  fetch: async (url, opts) => {
    request = { url, opts };
    if (networkError) throw Error("offline");
    return response;
  },
});
const ui = fs.readFileSync(__dirname + "/js/ui.js", "utf8");
const showImageSource = ui.slice(ui.indexOf("  async function showImage("), ui.indexOf("  async function showDicomTags("));
const stage = { children: [], appendChild(n) { this.children.push(n); } };
const state = { viewer: { seq: 0, img: null } };
let reason = "", probes = 0, probe;
const context = {
  state,
  api: { fileURL: p => p, dicomLoadError: async () => { probes++; return probe ? probe() : reason; } },
  document: { createElement: () => ({}) },
  decodeImg: async () => { throw Error("image error"); },
  clearStage: () => { stage.children = []; },
  el: (_tag, _cls, text) => ({ text, remove() { stage.children = stage.children.filter(n => n !== this); } }),
  applyZoom() {},
};
vm.runInNewContext(showImageSource, context);

(async () => {
  response = new Response(JSON.stringify({ error: "DICOM is not activated" }), { status: 403 });
  assert.equal(await MVR.api.dicomLoadError("/DATA/a b.dcm"), "DICOM is not activated");
  assert.equal(request.url, "api/files/payload?path=%2FDATA%2Fa%20b.dcm");
  assert.equal(request.opts.headers.Range, "bytes=0-0");
  for (const [status, body] of [[403, '{"error":"permission denied"}'], [403, "bad json"], [404, "missing"], [415, "unsupported"], [200, "image bytes"]]) {
    response = new Response(body, { status });
    assert.equal(await MVR.api.dicomLoadError("x.dcm"), "");
  }
  response = new Response("", { status: 401 });
  assert.equal(await MVR.api.dicomLoadError("x.dcm"), "");
  assert.equal(location.href, "__login");
  networkError = true;
  assert.equal(await MVR.api.dicomLoadError("x.dcm"), "");

  for (const name of ["scan.dcm", "SCAN.DICOM"]) {
    reason = "DICOM is not activated";
    assert.equal(await context.showImage({ name, path: name }, stage), false);
    assert.equal(stage.children.at(-1).text, `Could not load ${name}: DICOM is not activated`);
  }
  reason = "";
  await context.showImage({ name: "bad.dcm", path: "bad.dcm" }, stage);
  assert.equal(stage.children.at(-1).text, "Could not load bad.dcm");
  const before = probes;
  await context.showImage({ name: "bad.jpg", path: "bad.jpg" }, stage);
  assert.equal(probes, before);
  assert.equal(stage.children.at(-1).text, "Could not load bad.jpg");

  // A delayed error from previous image must not overwrite next image's stage.
  probe = () => { state.viewer.seq++; stage.children = []; return "DICOM is not activated"; };
  await context.showImage({ name: "old.dcm", path: "old.dcm" }, stage);
  assert.equal(stage.children.length, 0);
  console.log("DICOM activation errors: passed");
})().catch(e => { console.error(e); process.exitCode = 1; });
