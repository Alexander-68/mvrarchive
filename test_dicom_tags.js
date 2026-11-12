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
assert.deepStrictEqual(Object.keys(bt).sort(), ["StudyDate", "StudyInstanceUID", "StudyTime"]);
assert.strictEqual(bt.StudyDate + bt.StudyTime, "20250905101500");
// patient_info.json may carry PatientID directly; it wins over StudyID.
assert.strictEqual(S.dicomTags({ folderName: "x", info: { PatientID: "MRN9", StudyID: "S1" } }).PatientID, "MRN9");

// Modality mapping: single valid code string maps; slash strings (ModalitiesInStudy) are skipped.
// ScheduledModality (PascalCase and camelCase) is supported; ENDO is normalized to ES.
assert.strictEqual(S.dicomTags({ folderName: "x", info: { Modality: "ES" } }).Modality, "ES");
assert.strictEqual(S.dicomTags({ folderName: "x", info: { Modality: "GM" } }).Modality, "GM");
assert.strictEqual(S.dicomTags({ folderName: "x", info: { scheduledModality: "SC" } }).Modality, "SC");
assert.strictEqual(S.dicomTags({ folderName: "x", info: { ScheduledModality: "ENDO" } }).Modality, "ES");
assert.strictEqual(S.dicomTags({ folderName: "x", info: { scheduledModality: "ENDO" } }).Modality, "ES");
assert.strictEqual(S.dicomTags({ folderName: "x", info: { ScheduledModality: "ES" } }).Modality, "ES");
assert.strictEqual(S.dicomTags({ folderName: "x", info: { Modality: "ES/XC" } }).Modality, undefined);
assert.strictEqual(S.dicomTags({ folderName: "x", info: { ModalitiesInStudy: "ES/XC" } }).Modality, undefined);

assert.strictEqual(S.mediaKind("V0001.dcm"), "video");
assert.strictEqual(S.mediaKind("VLp.X.1.2.276.0.7230010.903.dcm"), "image");
assert.strictEqual(S.mediaKind("VVp.X.1.2.276.0.7230010.903.dcm"), "video", "storescp Video Photographic");
assert.strictEqual(S.mediaKind("VVe.2.25.1.dcm"), "video", "storescp Video Endoscopic");
assert.strictEqual(S.mediaKind("VVm.2.25.1.dcm"), "video", "storescp Video Microscopic");
assert.strictEqual(S.mediaKind("MRBRAIN.DCM"), "image");
assert.ok(S.pacsSendable("I0001.jpg") && S.pacsSendable("I0002.dcm") && S.pacsSendable("V0001.mp4") && S.pacsSendable("R0001.pdf") && !S.pacsSendable("V0001.mov"));
console.log("ok");

// Card preview: thumbnail, else first image/video, else page 1 of a PDF.
const pdf = { kind: "pdf", name: "R0001.pdf" }, img = { kind: "image", name: "I0001.jpg" };
assert.strictEqual(S.cardPreview({ media: [pdf] }), pdf, "PDF-only study previews its report");
assert.strictEqual(S.cardPreview({ media: [pdf, img] }), img, "image wins over PDF");
assert.strictEqual(S.cardPreview({ media: [] }), null);
assert.ok(S.previewGone(pdf, 415) && S.previewGone(pdf, 404), "no renderer is final");
assert.ok(S.previewGone({ kind: "video" }, 404), "Cloud PACS 404 is final for videos too");
assert.ok(!S.previewGone(pdf, 503) && !S.previewGone(img, 503) && !S.previewGone({ kind: "video" }, 415), "busy, or video 415 (browser poster), keeps retry");
assert.ok(S.previewGone({ kind: "image", name: "a.heic" }, 415), "image 415 (no ffmpeg for HEIC/WebP) is final");
assert.ok(S.hasPreview(pdf) && S.hasPreview(img), "media tiles preview PDFs and images");
assert.ok(!S.hasPreview({ kind: "other" }));

// Same folder name on two storages, different patients: never one study.
const uidOf = (info) => S.dicomTags({ folderName: "CASE0001", info }).StudyInstanceUID;
assert.notStrictEqual(uidOf({ PatientID: "A1" }), uidOf({ PatientID: "B2" }), "folder-name collision across patients");
assert.strictEqual(uidOf({ PatientID: "A1" }), uidOf({ PatientID: "A1" }), "a copy of the same study keeps its UID");
assert.match(uidOf({}), /^2\.25\.\d+$/);
assert.strictEqual(S.mediaKind("SCc.1.2.3.dcm"), "video", "storescp multi-frame true color SC");
assert.strictEqual(S.mediaKind("SC.1.2.3.dcm"), "image");
console.log("test_dicom_tags: uid/scc ok");
