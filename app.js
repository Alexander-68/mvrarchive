// MVRarchive — connectivity smoke test for the OmniGate file API.
//
// Runs same-origin against the per-app gateway: the session cookie authenticates
// every call, so these are plain relative fetches with no token and no CORS.

const $ = (sel) => document.querySelector(sel);

async function apiJSON(path) {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  if (res.status === 401) {
    location.href = "/__login";
    throw new Error("session expired");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

function setCheck(name, ok, result) {
  const li = document.querySelector(`.checks li[data-check="${name}"]`);
  if (!li) return;
  li.classList.remove("ok", "fail");
  li.classList.add(ok ? "ok" : "fail");
  li.querySelector(".result").textContent = result;
}

function setOverall(state, text) {
  const b = $("#overall");
  b.className = `badge ${state}`;
  b.textContent = text;
}

function showDetail(obj) {
  const pre = $("#detail");
  pre.hidden = false;
  pre.textContent = JSON.stringify(obj, null, 2);
}

async function runChecks() {
  $("#btn-retry").disabled = true;
  setOverall("pending", "checking…");
  setCheck("roots", false, "…");
  setCheck("files", false, "…");
  $("#detail").hidden = true;

  const detail = {};
  let allOk = true;

  // Check 1: list the allowed roots.
  let roots = [];
  try {
    const data = await apiJSON("/api/roots");
    roots = data.roots || [];
    detail.roots = roots;
    setCheck("roots", true, `${roots.length} root(s)`);
  } catch (err) {
    allOk = false;
    detail.rootsError = err.message;
    setCheck("roots", false, err.message);
  }

  // Check 2: list the first root's contents.
  if (roots.length > 0) {
    try {
      const data = await apiJSON(`/api/files?path=${encodeURIComponent(roots[0])}`);
      const n = (data.entries || []).length;
      detail.firstRoot = roots[0];
      detail.entryCount = n;
      setCheck("files", true, `${n} entr${n === 1 ? "y" : "ies"}`);
    } catch (err) {
      allOk = false;
      detail.filesError = err.message;
      setCheck("files", false, err.message);
    }
  } else {
    allOk = false;
    setCheck("files", false, "skipped (no roots)");
  }

  setOverall(allOk ? "ok" : "fail", allOk ? "API works ✅" : "API error");
  showDetail(detail);
  $("#btn-retry").disabled = false;
}

$("#btn-retry").onclick = runChecks;
runChecks();
