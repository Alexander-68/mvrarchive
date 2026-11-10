// Cloud PACS delete: only an admin sees Delete on an erase root, and it is permanent there.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const MVR = {};
let responses = [];
vm.runInNewContext(fs.readFileSync(__dirname + "/js/api.js", "utf8"), {
  window: { MVR }, location: {},
  fetch: async () => responses.shift(),
});
const json = (o) => new Response(JSON.stringify(o));

(async () => {
  const api = MVR.api;
  responses = [json({ roots: [
    { name: "DATA", writable: true },
    { name: "NAS", writable: false },
    { name: "Cloud", writable: false, remote: true, search: true, erase: true },
  ] })];
  await api.roots();

  responses = [json({ username: "u", role: "user", admin: false })];
  await api.me();
  assert.ok(api.canDelete("/DATA") && !api.isPermanent("/DATA"), "writable share soft-deletes");
  assert.ok(!api.canDelete("/NAS"), "read-only share: no delete");
  assert.ok(!api.canDelete("/Cloud"), "non-admin: no cloud delete");

  responses = [json({ username: "a", role: "user", admin: true })];
  await api.me();
  assert.ok(api.canDelete("/Cloud") && api.isPermanent("/Cloud"), "admin: permanent cloud delete");
  assert.ok(!api.canDelete("/NAS"), "admin still cannot delete on a plain read-only share");
  assert.ok(!api.isPermanent("/DATA"));

  responses = [json({ username: "a", role: "admin" })];
  await api.me();
  assert.ok(api.canDelete("/Cloud") && api.isPermanent("/Cloud"), "role admin: permanent cloud delete");

  console.log("test_cloud_delete: ok");
})().catch((e) => { console.error(e); process.exit(1); });
