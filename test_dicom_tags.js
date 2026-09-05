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

// No metadata at all: identity still comes from the folder name.
const bare = { folderName: "CASE0042", info: null };
assert.strictEqual(S.dicomTags(bare).PatientName, "CASE0042");
assert.strictEqual(S.dicomTags(bare).PatientID, "CASE0042");

assert.ok(S.pacsSendable("I0001.jpg") && S.pacsSendable("I0002.dcm") && !S.pacsSendable("V0001.mp4"));
console.log("ok");
