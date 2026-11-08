const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

// syncDeletedToggle hides "Show 🗑" on read-only storage (NAS, Cloud PACS) and
// leaves deleted mode there; writable storage keeps the toggle and its state.
const ui = fs.readFileSync(__dirname + "/js/ui.js", "utf8");
const src = ui.slice(ui.indexOf("  function syncDeletedToggle("), ui.indexOf("  async function loadArchive("));
const btn = { hidden: false, dataset: { tip: "Show current files" }, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
const ctx = {
  $: () => btn,
  api: { readOnly: new Set(["/CloudPACS"]) },
  S: { showDeleted: true },
  state: { deleted: true },
};
vm.runInNewContext(src, ctx);

ctx.syncDeletedToggle("/DATA");
assert.equal(btn.hidden, false);
assert.equal(ctx.state.deleted, true, "writable root keeps deleted mode");

ctx.syncDeletedToggle("/CloudPACS");
assert.equal(btn.hidden, true);
assert.equal(ctx.state.deleted, false);
assert.equal(ctx.S.showDeleted, false);
assert.equal(btn.attrs["aria-pressed"], "false");
assert.equal(btn.dataset.tip, "Show deleted files");

ctx.syncDeletedToggle("/DATA");
assert.equal(btn.hidden, false, "toggle returns on writable root");
assert.equal(ctx.state.deleted, false);
console.log("test_deleted_toggle: ok");
