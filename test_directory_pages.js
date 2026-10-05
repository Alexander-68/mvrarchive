const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const MVR = {}, location = {}, requests = [], waits = [];
let responses = [];
vm.runInNewContext(fs.readFileSync(__dirname + "/js/api.js", "utf8"), {
  window: { MVR }, location,
  setTimeout: (callback, ms) => { waits.push(ms); queueMicrotask(callback); },
  fetch: async (url, opts) => {
    requests.push({ url, opts });
    assert.ok(responses.length, "unexpected extra request");
    return responses.shift();
  },
});
const page = (entries, cursor) => new Response(JSON.stringify({ entries, next_cursor: cursor }));
function reset(items) { responses = items; requests.length = 0; waits.length = 0; }

(async () => {
  const first = Array.from({ length: 256 }, (_, i) => ({ name: `study${i}`, is_dir: true }));
  reset([page(first, "a+/= &"), page([], "after-empty"), page([{ name: "last", is_dir: true }], "")]);
  const signal = new AbortController().signal;
  const result = await MVR.api.list("/DATA/a b", false, signal);
  assert.equal(result.length, 257, "entries beyond first page retained");
  assert.equal(result.at(-1).name, "last");
  for (const { url, opts } of requests) {
    const parsed = new URL(url, "https://gateway/app/");
    assert.equal(parsed.searchParams.get("path"), "/DATA/a b");
    assert.equal(parsed.searchParams.get("limit"), "256");
    assert.equal(opts.signal, signal);
  }
  assert.equal(new URL(requests[1].url, "https://gateway/").searchParams.get("cursor"), "a+/= &");

  reset([page([{ name: ".deleted.1.old", original_name: "old" }], "next"), page([{ name: ".deleted.2.other" }], "")]);
  assert.equal((await MVR.api.list("/DATA", true)).length, 2);
  assert.ok(requests.every(({ url }) => new URL(url, "https://gateway/").searchParams.get("deleted") === "1"));

  reset([page([{ name: "legacy" }])]);
  assert.equal((await MVR.api.list("/DATA"))[0].name, "legacy");
  assert.equal(requests.length, 1, "legacy gateway compatibility");

  reset([new Response("busy", { status: 429, headers: { "Retry-After": "2" } }), new Response("busy", { status: 503 }), page([{ name: "ok" }], "")]);
  assert.equal((await MVR.api.list("/DATA"))[0].name, "ok");
  assert.deepEqual(waits, [2000, 1000]);
  assert.ok(requests.every(({ url }) => url === requests[0].url), "retry same page");

  reset(Array.from({ length: 6 }, () => new Response('{"error":"busy"}', { status: 503 })));
  await assert.rejects(MVR.api.list("/DATA"), /busy/);
  assert.equal(requests.length, 6, "retries bounded");

  reset([page([], "cycle"), page([], "cycle")]);
  await assert.rejects(MVR.api.list("/DATA"), /cursor did not advance/);
  reset([page([], 42)]);
  await assert.rejects(MVR.api.list("/DATA"), /invalid directory page/);

  reset([new Response('{"error":"denied"}', { status: 403 })]);
  await assert.rejects(MVR.api.list("/DATA"), /denied/);
  assert.equal(requests.length, 1, "permissions failure not retried");
  reset([new Response("", { status: 401 })]);
  await assert.rejects(MVR.api.list("/DATA"), /session expired/);
  assert.equal(location.href, "__login");

  reset([]);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(MVR.api.list("/DATA", false, controller.signal), { name: "AbortError" });
  assert.equal(requests.length, 0, "canceled scan sends no request");
  console.log("Directory pagination: passed (full/deleted/legacy lists, retries, cursor safety, cancellation)");
})().catch(error => { console.error(error); process.exitCode = 1; });
