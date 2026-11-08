// node test_cloud_study.js — cloud study_info.yaml -> DICOM tags, series numbers, yaml escapes.
const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const ctx = { window: {}, crypto: require("crypto").webcrypto };
ctx.window.MVR = {};
for (const f of ["js/path.js", "js/yaml.js", "js/study.js"]) vm.runInNewContext(fs.readFileSync(f, "utf8"), ctx);
const MVR = ctx.window.MVR, S = MVR.study;

const info = MVR.yaml.parse(fs.readFileSync("references/fixtures/cloud_study_info.yaml", "utf8"));
const study = { folderName: "20240315_143052_PID-20417_MUSTERMANN-ERIKA_0123456789ab", info };
const t = S.dicomTags(study);
assert.strictEqual(t.PatientID, "PID-20417");
assert.strictEqual(t.StudyDate, "20240315");
assert.strictEqual(t.StudyTime, "143052");
assert.strictEqual(t.StudyInstanceUID, "1.2.826.0.1.3680043.8.498.10293847561234");
assert.strictEqual(t.PatientBirthDate, "19760412");
assert.strictEqual(t.PatientSex, "F");
assert.strictEqual(t.StudyDescription, 'Gastroscopy, biopsy "antrum"');
assert.strictEqual(info.Modality, "ES/XC");

assert.strictEqual(S.seriesNumber(study, "I0001.jpg"), "101");
assert.strictEqual(S.seriesNumber(study, "x.JPEG"), "101");
assert.strictEqual(S.seriesNumber(study, "x.bmp"), "101");
assert.strictEqual(S.seriesNumber(study, "x.mp4"), "102");
assert.strictEqual(S.seriesNumber(study, "R0001.pdf"), "103");
assert.strictEqual(S.seriesNumber(study, "x.dcm"), null);
assert.strictEqual(S.seriesNumber({ info: {} }, "I0001.jpg"), null);
assert.strictEqual(S.seriesNumber({ info: null }, "I0001.jpg"), null);

// yaml escapes: single left-to-right pass (backslash built by code to dodge escaping noise).
const B = String.fromCharCode(92);
const yq = (body) => MVR.yaml.parse('k: "' + body + '"').k;
assert.strictEqual(yq("C:" + B + B + "notes"), "C:" + B + "notes");
assert.strictEqual(yq("a" + B + "nb"), "a\nb");
assert.strictEqual(yq("say " + B + '"hi' + B + '"'), 'say "hi"');
console.log("ok");
