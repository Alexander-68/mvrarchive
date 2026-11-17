// Bundle builder for MVRarchive: syncs the app version (1.0.YYMMDD) and zips
// the bundle to mvrarchive.zip with index.html at root. Zipping uses pwsh 7's
// Compress-Archive (forward-slash entry names), so the build needs PowerShell 7.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT_DIR = __dirname;
const BUNDLE_PATHS = ["index.html", "omnigate.json", "README.md", "styles.css", "js", "assets"];

const d = new Date();
const pad = (n) => String(n).padStart(2, "0");
const ver = `1.0.${String(d.getFullYear()).slice(2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;

for (const name of ["package.json", "omnigate.json"]) {
  const file = path.join(ROOT_DIR, name);
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  json.version = ver;
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
}
const htmlPath = path.join(ROOT_DIR, "index.html");
const VERSION_RE = /(<span class="app-version[^>]*>)([^<]*)(<\/span>)/;
const html = fs.readFileSync(htmlPath, "utf8");
if (!VERSION_RE.test(html)) { console.error("[build] index.html has no app-version span"); process.exit(1); }
fs.writeFileSync(htmlPath, html.replace(VERSION_RE, `$1${ver}$3`));
console.log(`[build] Version: ${ver}`);

try {
  execFileSync("pwsh", ["-NoProfile", "-Command",
    `$ErrorActionPreference = 'Stop'; Compress-Archive -Path ${BUNDLE_PATHS.join(",")} -DestinationPath mvrarchive.zip -Force`],
    { cwd: ROOT_DIR, stdio: "inherit" });
} catch (e) {
  console.error(`[build] Zip failed (needs PowerShell 7 'pwsh' on PATH): ${e.message}`);
  process.exit(1);
}
console.log(`[build] Created ${path.join(ROOT_DIR, "mvrarchive.zip")}`);
