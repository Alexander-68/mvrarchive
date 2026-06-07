// Path helpers that work for both POSIX and Windows roots, since OmniGate
// reports whatever the host filesystem uses (the allow-dir may be a Windows
// path like C:\... or a POSIX mount). The separator is inferred per-path.
(function () {
  "use strict";
  const MVR = (window.MVR = window.MVR || {});

  function sepFor(p) {
    return p.includes("\\") ? "\\" : "/";
  }

  function join(base, name) {
    const s = sepFor(base);
    return base.endsWith(s) ? base + name : base + s + name;
  }

  function basename(p) {
    const s = sepFor(p);
    const t = p.replace(new RegExp(`\\${s}+$`), "");
    const i = t.lastIndexOf(s);
    return i < 0 ? t : t.slice(i + 1);
  }

  function parentOf(p) {
    const s = sepFor(p);
    const t = p.replace(new RegExp(`\\${s}+$`), "");
    const i = t.lastIndexOf(s);
    if (i <= 0) return t;
    return t.slice(0, i);
  }

  function extname(name) {
    const i = name.lastIndexOf(".");
    return i < 0 ? "" : name.slice(i + 1).toLowerCase();
  }

  MVR.path = { sepFor, join, basename, parentOf, extname };
})();
