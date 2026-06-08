// Path helpers for OmniGate virtual share paths. New gateway APIs expose
// /SHARE/subdir paths rather than server filesystem paths; older absolute
// Windows paths are still handled so mixed deployments keep working.
(function () {
  "use strict";
  const MVR = (window.MVR = window.MVR || {});

  function isWindowsAbsolute(p) {
    return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p);
  }

  function sepFor(p) {
    return isWindowsAbsolute(p) ? "\\" : "/";
  }

  function trimTrailingSep(p, sep) {
    let t = String(p || "");
    while (t.length > 1 && t.endsWith(sep)) t = t.slice(0, -1);
    return t;
  }

  function join(base, name) {
    const s = sepFor(base);
    const child = String(name || "").replace(/^[\\/]+/g, "");
    if (!base) return s === "/" ? "/" + child : child;
    return base.endsWith(s) ? base + child : base + s + child;
  }

  function basename(p) {
    const s = sepFor(p);
    const t = trimTrailingSep(p, s);
    const i = t.lastIndexOf(s);
    return i < 0 ? t : t.slice(i + 1);
  }

  function parentOf(p) {
    const s = sepFor(p);
    const t = trimTrailingSep(p, s);
    const i = t.lastIndexOf(s);
    if (i <= 0) return t;
    return t.slice(0, i);
  }

  function normalizeVirtual(p) {
    const parts = String(p || "")
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean);
    return parts.length ? "/" + parts.join("/") : "";
  }

  function extname(name) {
    const i = name.lastIndexOf(".");
    return i < 0 ? "" : name.slice(i + 1).toLowerCase();
  }

  MVR.path = { sepFor, join, basename, parentOf, normalizeVirtual, extname };
})();
