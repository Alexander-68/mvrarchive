const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

// dicomPayloadKind tells video/PDF/still from the payload Content-Type, so a
// .dcm with an unknown name still opens in the right viewer.
const MVR = {};
let response, request;
vm.runInNewContext(fs.readFileSync(__dirname + "/js/api.js", "utf8"), {
  window: { MVR }, location: {}, AbortSignal,
  fetch: async (url, opts) => { request = { url, opts }; if (response instanceof Error) throw response; return response; },
});

(async () => {
  const reply = (status, type) => new Response("x", { status, headers: type ? { "Content-Type": type } : {} });
  for (const [res, want] of [
    [reply(206, "video/mp4"), "video"],
    [reply(206, "application/pdf"), "pdf"],
    [reply(206, "image/jpeg"), "image"],
    [reply(415, "application/json"), "image"],
    [reply(403, "application/json"), "image"],
    [Error("offline"), "image"],
  ]) {
    response = res;
    assert.equal(await MVR.api.dicomPayloadKind("/DATA/scan42.dcm"), want);
  }
  assert.equal(request.url, "api/files/payload?path=%2FDATA%2Fscan42.dcm");
  assert.equal(request.opts.headers.Range, "bytes=0-0", "probe asks for one byte only");
  console.log("test_dicom_kind: ok");
})().catch(err => { console.error(err); process.exit(1); });
