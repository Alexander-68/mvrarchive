// Study domain model for the MVR Archive standard.
//
// A Study is a folder under a storage root, named either `CASE####` (legacy) or
// `yyyyMMdd_HHmmss_<StudyID>_<Serial>` (Send-to-NAS / direct recording). It holds
// media files (I/J=image, V/W=video, R=report) plus metadata in study_info.yaml
// (mirrored to patient_info.json). See MVRarchive_implementation_plan.md §2.
(function () {
  "use strict";
  const MVR = (window.MVR = window.MVR || {});
  const { api, path } = MVR;

  const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "heif", "heic"]);
  const VIDEO_EXT = new Set(["mp4", "mov", "webm", "mkv", "m4v", "avi", "wmv", "flv", "mpg", "mpeg", "ts", "m2ts", "mts", "3gp", "ogv"]);
  const META_NAMES = new Set(["study_info.yaml", "patient_info.json", "patient_info.csv", "patient_info.txt", "patient_info.yaml"]);

  const STAMP_RE = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(?:_(.*))?$/;
  const CASE_RE = /^CASE\d+$/i;

  function isStudyFolder(name) {
    return CASE_RE.test(name) || STAMP_RE.test(name);
  }

  // mediaKind classifies a file as image | video | pdf | null (metadata/other).
  function mediaKind(name) {
    if (META_NAMES.has(name.toLowerCase())) return null;
    const ext = path.extname(name);
    if (ext === "dcm" || ext === "dicom") {
      // DICOM can wrap either; only the MVR video naming (V0001 / W0001) is
      // video. Other names (a PACS-style VLp.X.<uid>.dcm) are stills.
      return /^[VW]\d/i.test(name) ? "video" : "image";
    }
    if (IMAGE_EXT.has(ext)) return "image";
    if (VIDEO_EXT.has(ext)) return "video";
    if (ext === "pdf") return "pdf";
    return null;
  }

  // parseStampName extracts a Date and StudyID from a timestamp-style folder name.
  function parseStampName(name) {
    const m = STAMP_RE.exec(name);
    if (!m) return null;
    const [, y, mo, d, h, mi, s, rest] = m;
    const date = new Date(+y, +mo - 1, +d, +h, +mi, +s);
    const studyId = rest ? rest.split("_")[0] : "";
    return { date, studyId };
  }

  function fullName(info) {
    if (!info) return "";
    if (info.AnimalName) return info.AnimalName;
    const parts = [info.PatientLastName, info.PatientFirstName, info.PatientMiddleName].filter(Boolean);
    if (info.PatientLastName) {
      const first = [info.PatientFirstName, info.PatientMiddleName].filter(Boolean).join(" ");
      return first ? `${info.PatientLastName}, ${first}` : info.PatientLastName;
    }
    return parts.join(" ");
  }

  function formatDOB(info) {
    if (!info || !info.PatientBirthYear) return "";
    const y = info.PatientBirthYear;
    const mo = info.PatientBirthMonth, d = info.PatientBirthDay;
    if (mo && d) return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    return String(y);
  }

  function pad2(n) { return String(n).padStart(2, "0"); }
  function formatDate(date) {
    if (!date || isNaN(date)) return "";
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }

  function fmtSize(n) {
    if (n < 1024) return `${n} B`;
    const u = ["KB", "MB", "GB", "TB"]; let v = n / 1024, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(1)} ${u[i]}`;
  }

  // The display name shown on a card / detail header.
  function displayName(study) {
    const n = fullName(study.info);
    if (n) return n;
    if (study.info && study.info.StudyID) return study.info.StudyID;
    const parsed = parseStampName(study.folderName);
    if (parsed && parsed.studyId) return parsed.studyId;
    return study.folderName;
  }

  // The date text shown on a card: prefer StudyDate from metadata, then the
  // timestamp in the folder name, then the folder's filesystem mod time.
  function studyDate(study) {
    if (study.info && study.info.StudyDate) {
      const d = new Date(Number(study.info.StudyDate));
      if (!isNaN(d)) return d;
    }
    const parsed = parseStampName(study.folderName);
    if (parsed) return parsed.date;
    return study.modTime ? new Date(study.modTime) : null;
  }

  // Metadata lives in study_info.yaml (patient_info.yaml on older recorders),
  // with patient_info.json as the fallback when no YAML is present.
  async function loadInfo(studyPath, entries) {
    const names = new Set(entries.filter((e) => !e.is_dir).map((e) => e.name.toLowerCase()));
    for (const yaml of ["study_info.yaml", "patient_info.yaml"]) {
      if (!names.has(yaml)) continue;
      try {
        const text = await api.readText(path.join(studyPath, yaml));
        const obj = MVR.yaml.parse(text);
        if (obj && Object.keys(obj).length) return obj;
      } catch (e) { /* fall through */ }
    }
    if (names.has("patient_info.json")) {
      try {
        const text = await api.readText(path.join(studyPath, "patient_info.json"));
        return JSON.parse(text);
      } catch (e) { /* ignore */ }
    }
    return null;
  }

  // hydrate lists a study folder's contents and computes everything the UI needs:
  // media file list, counts, total size, a thumbnail candidate, and metadata.
  // In deleted mode (S.showDeleted) a live study lists only its deleted files;
  // a trashed study folder (study.trashed) lists as usual, since everything in
  // it is already deleted. Metadata always comes from the live listing.
  async function hydrate(study) {
    const entries = await api.list(study.path);
    const mediaEntries = MVR.study.showDeleted && !study.trashed ? await api.list(study.path, true) : entries;
    const media = [];
    let images = 0, videos = 0, pdfs = 0, size = 0;
    for (const e of mediaEntries) {
      if (e.is_dir) continue;
      const name = e.original_name || e.name;
      const kind = mediaKind(name);
      if (!kind) continue;
      size += e.size || 0;
      if (kind === "image") images++;
      else if (kind === "video") videos++;
      else if (kind === "pdf") pdfs++;
      media.push({ name, kind, size: e.size, path: path.join(study.path, e.name), deletedAt: e.deleted_at ? Date.parse(e.deleted_at) : 0 });
    }
    // A live study in deleted mode reports its most recent file deletion.
    if (!study.trashed) study.deletedAt = media.reduce((t, m) => Math.max(t, m.deletedAt || 0), 0);
    media.sort((a, b) => a.name.localeCompare(b.name));
    study.media = media;
    study.counters = { images, videos, pdfs, size };
    study.thumbFile = media.find((m) => m.kind === "image") || null;
    study.info = await loadInfo(study.path, entries);
    study.hydrated = true;
    return study;
  }

  function newStudy(root, entry) {
    const isRoot = entry.name === root || !entry.name;
    const folderName = isRoot ? (path.basename(root) || root) : entry.name;
    const p = isRoot ? root : path.join(root, entry.name);
    return {
      root,
      folderName,
      path: p,
      modTime: entry.mod_time ? Date.parse(entry.mod_time) : 0,
      hydrated: false,
      info: null,
      media: [],
      counters: { images: 0, videos: 0, pdfs: 0, size: 0 },
      thumbFile: null,
      marked: false,
      isDirectRoot: isRoot,
      trashed: false,
      deletedAt: 0,        // epoch ms of the folder's (or latest file's) deletion; 0 when live
    };
  }

  // trashedStudy builds a study for a deleted folder from a deleted listing:
  // the on-disk trash name goes into the path, the original name is shown.
  function trashedStudy(root, entry) {
    const s = newStudy(root, { name: entry.name, mod_time: entry.deleted_at || entry.mod_time });
    s.folderName = entry.original_name || entry.name;
    s.trashed = true;
    s.deletedAt = entry.deleted_at ? Date.parse(entry.deleted_at) : 0;
    return s;
  }

  // searchText builds the lowercased haystack a study is matched against.
  function searchText(study) {
    const i = study.info || {};
    return [
      study.folderName, i.StudyID, fullName(i),
      i.PatientFirstName, i.PatientLastName, i.AnimalName,
      i.AccessionNumber, formatDOB(i),
      formatDate(studyDate(study)),
    ].filter(Boolean).join(" \x01 ").toLowerCase();
  }

  function matches(study, query) {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return searchText(study).includes(q);
  }

  // Field groups for the detail info panel. Each entry is [yamlKey, label].
  const FIELD_GROUPS = [
    ["Patient", [
      ["__fullname", "Name"], ["__dob", "Birth date"], ["PatientGender", "Sex"],
      ["StudyID", "Patient / Study ID"],
      ["SpeciesDescription", "Species"], ["BreedCode", "Breed"],
      ["ResponsiblePerson", "Owner"], ["ResponsiblePersonRole", "Owner role"],
    ]],
    ["Study", [
      ["Type", "Type"], ["__date", "Study date"], ["Creator", "Created by"],
      ["Notes", "Notes"],
    ]],
    ["Clinical / DICOM", [
      ["AccessionNumber", "Accession #"], ["InstitutionName", "Institution"],
      ["ReferringPhysician", "Referring physician"], ["PerformingPhysician", "Performing physician"],
      ["RequestingPhysician", "Requesting physician"], ["ScheduledModality", "Modality"],
      ["RequestedProcedureDescription", "Procedure"], ["__anatomic", "Anatomic region"],
      ["StudyInstanceUID", "Study UID"],
    ]],
  ];
  const KNOWN_KEYS = new Set();
  for (const [, fields] of FIELD_GROUPS) for (const [k] of fields) if (!k.startsWith("__")) KNOWN_KEYS.add(k);

  // Resolve a (possibly synthetic) field key to a display string, or "" if absent.
  function fieldValue(info, key) {
    if (!info) return "";
    switch (key) {
      case "__fullname": return fullName(info);
      case "__dob": return formatDOB(info);
      case "__date": {
        if (info.StudyDate) { const d = new Date(Number(info.StudyDate)); if (!isNaN(d)) return formatDate(d); }
        return "";
      }
      case "__anatomic": {
        const a = info.AnatomicRegion;
        if (a && typeof a === "object") return a.display || a.code || "";
        return a || "";
      }
      default: {
        const v = info[key];
        return v === null || v === undefined ? "" : String(v);
      }
    }
  }

  // ---- Send to PACS ----------------------------------------------------------
  const PACS_EXT = new Set(["jpg", "jpeg", "bmp", "dcm", "dicom"]);
  function pacsSendable(name) { return PACS_EXT.has(path.extname(name)); }

  // UUID-derived UID (DICOM PS3.5 B.2): "2.25." + 128-bit random as decimal.
  function genUID() {
    const b = crypto.getRandomValues(new Uint8Array(16));
    let n = 0n;
    for (const x of b) n = (n << 8n) | BigInt(x);
    return "2.25." + n.toString();
  }

  // dicomTags maps study metadata (study_info / patient_info) onto the DICOM
  // tags a C-STORE should carry. Only what the metadata says is sent: nothing
  // is derived from the folder name, so a study without metadata sends no
  // patient identity at all. StudyInstanceUID is the metadata's, else one
  // generated per study and kept for the session so repeated sends land in
  // the same PACS study.
  function dicomTags(study) {
    const i = study.info || {};
    const t = {};
    const human = [i.PatientLastName, i.PatientFirstName, i.PatientMiddleName].map((v) => v || "").join("^").replace(/\^+$/, "");
    if (i.AnimalName || human) t.PatientName = String(i.AnimalName || human);
    if (i.PatientID || i.StudyID) t.PatientID = String(i.PatientID || i.StudyID);
    const dob = formatDOB(i);
    if (dob.length === 10) t.PatientBirthDate = dob.replace(/-/g, "");
    const sex = String(i.PatientGender || "").toUpperCase()[0];
    if (sex && "MFO".includes(sex)) t.PatientSex = sex;
    const d = i.StudyDate ? new Date(Number(i.StudyDate)) : null;
    if (d && !isNaN(d)) {
      t.StudyDate = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
      t.StudyTime = `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
    }
    const map = {
      AccessionNumber: "AccessionNumber", InstitutionName: "InstitutionName",
      StudyDescription: "RequestedProcedureDescription",
      ReferringPhysicianName: "ReferringPhysician", PerformingPhysicianName: "PerformingPhysician",
      ResponsiblePerson: "ResponsiblePerson", PatientSpeciesDescription: "SpeciesDescription",
      PatientBreedDescription: "BreedCode",
    };
    for (const [tag, key] of Object.entries(map)) {
      const v = i[key];
      if (v !== null && v !== undefined && typeof v !== "object" && String(v).trim()) t[tag] = String(v).trim();
    }
    if (!study.sendUID) study.sendUID = i.StudyInstanceUID || genUID();
    t.StudyInstanceUID = study.sendUID;
    return t;
  }

  MVR.study = {
    showDeleted: false,
    isStudyFolder, mediaKind, parseStampName, newStudy, trashedStudy, hydrate,
    displayName, studyDate, fullName, formatDOB, formatDate, fmtSize,
    matches, FIELD_GROUPS, KNOWN_KEYS, fieldValue, pacsSendable, dicomTags,
  };
})();
