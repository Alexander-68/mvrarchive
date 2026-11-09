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
assert.strictEqual(t.StudyTime, "143052.123"); // full DICOM TM from WlStudyTime
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
// Cloud PatientID only from PatientID, never the StudyID fallback.
assert.strictEqual(S.dicomTags({ folderName: "x", info: { CloudPACS: "C", StudyID: "S1" } }).PatientID, undefined);
assert.strictEqual(S.dicomTags({ folderName: "x", info: { CloudPACS: "C", PatientID: "P9", StudyID: "S1" } }).PatientID, "P9");
assert.strictEqual(S.dicomTags({ folderName: "x", info: { StudyID: "S1" } }).PatientID, "S1");

// PN prefix/suffix: Last^First^Middle^Prefix^Suffix, trailing empties trimmed.
const pn = (i) => S.dicomTags({ folderName: "x", info: i }).PatientName;
assert.strictEqual(pn({ PatientLastName: "DOE", PatientFirstName: "JOHN", PatientNamePrefix: "DR", PatientNameSuffix: "JR" }), "DOE^JOHN^^DR^JR");
assert.strictEqual(pn({ PatientLastName: "DOE", PatientNamePrefix: "DR" }), "DOE^^^DR");
assert.strictEqual(pn({ PatientLastName: "DOE", PatientFirstName: "JOHN" }), "DOE^JOHN");

// Never read a cloud video to make a poster (whole-video WADO download).
const vid = { kind: "video" };
assert.strictEqual(S.browserPoster(study, vid, 415), false);
assert.strictEqual(S.browserPoster(study, vid, 422), false);
assert.strictEqual(S.browserPoster({ info: {} }, vid, 415), true);
assert.strictEqual(S.browserPoster({ info: null }, vid, 422), true);
assert.strictEqual(S.browserPoster({ info: {} }, vid, 404), false);
assert.strictEqual(S.browserPoster({ info: {} }, { kind: "image" }, 415), false);
console.log("ok");

// Cloud PACS search: recent ranges end today, widen 3 -> 7 -> 30 -> 365 days.
{
  const now = new Date(2026, 10, 10); // 10 Nov 2026, local time
  assert.deepStrictEqual([...S.RECENT_DAYS], [3, 7, 30, 365]);
  assert.strictEqual(S.recentRange(3, now), "20261108-20261110");
  assert.strictEqual(S.recentRange(30, now), "20261012-20261110");
  assert.strictEqual(S.recentRange(365, now), "20251111-20261110");
  assert.strictEqual(S.recentRange(3, new Date(2026, 0, 1)), "20251230-20260101");

  const F = (form) => JSON.parse(JSON.stringify(S.cloudFilter(form, now)));
  assert.deepStrictEqual(F({}), { filter: null });
  assert.deepStrictEqual(F({ PatientName: " doe " }), { filter: { PatientName: "doe" } });
  assert.deepStrictEqual(F({ from: "2026-11-01", ModalitiesInStudy: "ES" }), { filter: { ModalitiesInStudy: "ES", StudyDate: "20261101-20261110" } });
  assert.deepStrictEqual(F({ to: "2020-01-31" }), { filter: { StudyDate: "19000101-20200131" } });
  assert.ok(F({ from: "2026-11-10", to: "2026-11-01" }).error);
  // Modality or description alone would pull the whole store.
  assert.ok(F({ ModalitiesInStudy: "ES" }).error);
  assert.ok(F({ StudyDescription: "colon" }).error);
}
