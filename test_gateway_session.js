const assert = require("node:assert/strict");
const fs = require("node:fs");

const html = fs.readFileSync("index.html", "utf8");
const head = html.split("</head>")[0];
const css = fs.readFileSync("styles.css", "utf8");

assert.match(head, /<script src="__omnigate\/app-session\.js"><\/script>/);
assert.match(html, /<form[^>]*method="post"[^>]*action="__logout"/);
assert.match(css, /html\[data-theme="light"\]/);
console.log("OmniGate theme and inactivity integration OK");
