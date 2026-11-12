const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const MVR = {};
vm.runInNewContext(fs.readFileSync(__dirname + "/js/yaml.js", "utf8"), { window: { MVR } });
const y = MVR.yaml.parse("PatientName: Doe\nAnatomicRegion:\n  display: Knee\n  code: 'T-1'\nNotes:\nAge: 42\n");
assert.equal(y.PatientName, "Doe");
assert.deepEqual({ ...y.AnatomicRegion }, { display: "Knee", code: "T-1" });
assert.equal(y.Notes, null, "bare key is an empty value, not {}");
assert.equal(y.Age, 42);
console.log("YAML subset: passed");
