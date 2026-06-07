// Minimal YAML for MVRarchive.
//
// The Android app writes study_info.yaml with a custom serializer that produces
// a predictable, mostly-flat structure: `Key: value` lines, scalar values
// (strings, ints, null), and a few one-level nested maps (e.g. AnatomicRegion:
// { display, code }). This parser/dumper covers exactly that shape — it is
// intentionally small, not a general YAML implementation. patient_info.json is
// read with JSON.parse as a more robust fallback (see study.js).
(function () {
  "use strict";
  const MVR = (window.MVR = window.MVR || {});

  function parseScalar(raw) {
    let s = raw.trim();
    if (s === "" || s === "~" || s === "null") return null;
    // Quoted string: strip quotes and unescape the common sequences.
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      const q = s[0];
      s = s.slice(1, -1);
      if (q === '"') s = s.replace(/\\"/g, '"').replace(/\\\\/g, "\\").replace(/\\n/g, "\n");
      else s = s.replace(/''/g, "'");
      return s;
    }
    if (/^-?\d+$/.test(s)) return parseInt(s, 10);
    if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
    if (s === "true") return true;
    if (s === "false") return false;
    return s;
  }

  // parse turns YAML text into a plain object. Indentation-based nesting is
  // tracked with a stack so nested maps (any depth) round-trip; lists and flow
  // collections are not used by the schema and are ignored.
  function parse(text) {
    const root = {};
    // stack entries: { indent, obj }
    const stack = [{ indent: -1, obj: root }];
    const lines = String(text).split(/\r?\n/);

    for (const line of lines) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const indent = line.length - line.replace(/^ +/, "").length;
      const m = line.slice(indent).match(/^([^:]+):(.*)$/);
      if (!m) continue;
      const key = m[1].trim();
      const rest = m[2];

      // Pop to the parent whose indent is less than this line's.
      while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
      const parent = stack[stack.length - 1].obj;

      if (rest.trim() === "") {
        // A nested map follows (deeper-indented lines), or an empty value.
        const child = {};
        parent[key] = child;
        stack.push({ indent, obj: child });
      } else {
        parent[key] = parseScalar(rest);
      }
    }
    // Collapse nested maps that turned out empty to null (empty value case).
    return root;
  }

  function needsQuote(s) {
    return /[:#\n"']/.test(s) || /^\s|\s$/.test(s) || s === "" ||
      /^(true|false|null|~)$/.test(s) || /^-?\d/.test(s);
  }

  function dumpValue(v) {
    if (v === null || v === undefined) return "null";
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    const s = String(v);
    return needsQuote(s) ? '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"' : s;
  }

  // dump serializes a plain object back to YAML matching the read shape.
  function dump(obj, indent) {
    indent = indent || 0;
    const pad = "  ".repeat(indent);
    let out = "";
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        out += pad + key + ":\n" + dump(v, indent + 1);
      } else {
        out += pad + key + ": " + dumpValue(v) + "\n";
      }
    }
    return out;
  }

  MVR.yaml = { parse, dump };
})();
