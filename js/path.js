// Path helpers for OmniGate virtual share paths: /SHARE/subdir, always
// slash-separated (see HOW_TO_MAKE_OMNIGATE_WEB_APPS.md).
(function () {
  "use strict";
  const MVR = (window.MVR = window.MVR || {});

  // Trailing slashes off, but "/" stays "/".
  const trim = (p) => String(p || "").replace(/(.)\/+$/, "$1");

  function join(base, name) {
    const child = String(name || "").replace(/^[\\/]+/g, "");
    if (!base) return "/" + child;
    return base.endsWith("/") ? base + child : base + "/" + child;
  }

  function basename(p) {
    const t = trim(p);
    return t.slice(t.lastIndexOf("/") + 1);
  }

  function parentOf(p) {
    const t = trim(p);
    const i = t.lastIndexOf("/");
    return i <= 0 ? t : t.slice(0, i);
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

  MVR.path = { join, basename, parentOf, normalizeVirtual, extname };
})();
