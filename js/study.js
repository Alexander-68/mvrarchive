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
  const VIDEO_EXT = new Set(["mp4", "mov", "webm", "mkv", "m4v"]);
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
    if (IMAGE_EXT.has(ext)) return "image";
    if (VIDEO_EXT.has(ext)) return "video";
    if (ext === "pdf") return "pdf";
    if (ext === "dcm") {
      // DICOM can wrap either; disambiguate by the MVR filename prefix.
      const c = name[0] && name[0].toUpperCase();
      return c === "V" || c === "W" ? "video" : "image";
    }
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

  async function loadInfo(studyPath, entries) {
    const names = new Set(entries.filter((e) => !e.is_dir).map((e) => e.name.toLowerCase()));
    if (names.has("study_info.yaml")) {
      try {
        const text = await api.readText(path.join(studyPath, "study_info.yaml"));
        const obj = MVR.yaml.parse(text);
        if (obj && Object.keys(obj).length) return obj;
      } catch (e) { /* fall through to JSON */ }
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
  async function hydrate(study) {
    const entries = await api.list(study.path);
    const media = [];
    let images = 0, videos = 0, pdfs = 0, size = 0;
    for (const e of entries) {
      if (e.is_dir) continue;
      const kind = mediaKind(e.name);
      if (!kind) continue;
      size += e.size || 0;
      if (kind === "image") images++;
      else if (kind === "video") videos++;
      else if (kind === "pdf") pdfs++;
      media.push({ name: e.name, kind, size: e.size, path: path.join(study.path, e.name) });
    }
    media.sort((a, b) => a.name.localeCompare(b.name));
    study.media = media;
    study.counters = { images, videos, pdfs, size };
    study.thumbFile = media.find((m) => m.kind === "image") || null;
    study.info = await loadInfo(study.path, entries);
    study.hydrated = true;
    return study;
  }

  function newStudy(root, entry) {
    return {
      root,
      folderName: entry.name,
      path: path.join(root, entry.name),
      modTime: entry.mod_time ? Date.parse(entry.mod_time) : 0,
      hydrated: false,
      info: null,
      media: [],
      counters: { images: 0, videos: 0, pdfs: 0, size: 0 },
      thumbFile: null,
      marked: false,
    };
  }

  // searchText builds the lowercased haystack a study is matched against.
  function searchText(study) {
    const i = study.info || {};
    return [
      study.folderName, i.StudyID, fullName(i),
      i.PatientFirstName, i.PatientLastName, i.AnimalName,
      i.AccessionNumber, formatDOB(i),
      formatDate(studyDate(study)),
    ].filter(Boolean).join("  ").toLowerCase();
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

  MVR.study = {
    isStudyFolder, mediaKind, parseStampName, newStudy, hydrate,
    displayName, studyDate, fullName, formatDOB, formatDate, fmtSize,
    matches, FIELD_GROUPS, KNOWN_KEYS, fieldValue,
  };
})();
