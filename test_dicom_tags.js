// node test_dicom_tags.js — study metadata -> DICOM tags for Send to PACS.
const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const ctx = { window: {}, crypto: require("crypto").webcrypto };
ctx.window.MVR = {};
for (const f of ["js/path.js", "js/study.js"]) vm.runInNewContext(fs.readFileSync(f, "utf8"), ctx);
const S = ctx.window.MVR.study;

const study = {
  folderName: "20250905_101500_P001_SN1",
  info: { PatientLastName: "Doe", PatientFirstName: "Jane", PatientGender: "Female",
    PatientBirthYear: 1980, PatientBirthMonth: 3, PatientBirthDay: 7, StudyID: "P001",
    StudyDate: new Date(2025, 8, 5, 10, 15, 0).getTime(), AccessionNumber: "ACC1", Notes: "" },
};
const t = S.dicomTags(study);
assert.strictEqual(t.PatientName, "Doe^Jane");
assert.strictEqual(t.PatientID, "P001");
assert.strictEqual(t.PatientBirthDate, "19800307");
assert.strictEqual(t.PatientSex, "F");
assert.strictEqual(t.StudyDate, "20250905");
assert.strictEqual(t.StudyTime, "101500");
assert.strictEqual(t.AccessionNumber, "ACC1");
assert.match(t.StudyInstanceUID, /^2\.25\.\d+$/);
assert.ok(t.StudyInstanceUID.length <= 64);
assert.strictEqual(S.dicomTags(study).StudyInstanceUID, t.StudyInstanceUID, "UID stable per study");

// No metadata at all: nothing is invented from the folder name.
const bare = { folderName: "20250905_101500_P777_SN1", info: null };
const bt = S.dicomTags(bare);
assert.deepStrictEqual(Object.keys(bt), ["StudyInstanceUID"]);
// patient_info.json may carry PatientID directly; it wins over StudyID.
assert.strictEqual(S.dicomTags({ folderName: "x", info: { PatientID: "MRN9", StudyID: "S1" } }).PatientID, "MRN9");

assert.strictEqual(S.mediaKind("V0001.dcm"), "video");
assert.strictEqual(S.mediaKind("VLp.X.1.2.276.0.7230010.903.dcm"), "image");
assert.strictEqual(S.mediaKind("MRBRAIN.DCM"), "image");
assert.ok(S.pacsSendable("I0001.jpg") && S.pacsSendable("I0002.dcm") && !S.pacsSendable("V0001.mp4"));
console.log("ok");
