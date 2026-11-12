// Minimal YAML for MVRarchive.
//
// The Android app writes study_info.yaml with a custom serializer that produces
// a predictable, mostly-flat structure: `Key: value` lines, scalar values
// (strings, ints, null), and a few block-style nested maps (e.g. AnatomicRegion:
// with indented display/code lines). This parser covers exactly that shape — it
// is intentionally small, not a general YAML implementation: no lists, flow
// collections, multi-line scalars or quoted keys. patient_info.json is
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
      if (q === '"') s = s.replace(/\\(["\\n])/g, (_, c) => (c === "n" ? "\n" : c));
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
  // tracked with a stack so nested maps (any depth) parse. Lines without a
  // colon are skipped; the schema uses no lists or flow collections.
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
    // A bare `Key:` with no indented children is an empty value, not a map.
    return (function collapse(o) {
      for (const k in o) {
        const v = o[k];
        if (v && typeof v === "object") o[k] = Object.keys(v).length ? collapse(v) : null;
      }
      return o;
    })(root);
  }

  MVR.yaml = { parse };
})();
