const assert = require("assert");
const fs = require("fs");

const ui = fs.readFileSync("js/ui.js", "utf8");
assert.match(ui, /function onScroll\(\)[\s\S]*?scanAndScheduleLazyLoads\(\);/);
assert.match(ui, /function scanAndScheduleLazyLoads\(\)[\s\S]*?cards\.items\.length = 0;[\s\S]*?cards\.enqueue\(s, zone, false\);[\s\S]*?cards\.pump\(\);/);
assert.match(ui, /tiles\.items\.length = 0;[\s\S]*?tiles\.enqueue\(m, zone, false\);[\s\S]*?tiles\.pump\(\);/);
assert.match(ui, /bindGridZoom\(\$\("#grid"\), "archive", "cardSize"[\s\S]*?applyCardSize\(\);[\s\S]*?scheduleCardScan\(\);/);
assert.match(ui, /function scheduleCardScan\(\)[\s\S]*?setTimeout\(scanAndScheduleLazyLoads, 130\)/);
assert.match(ui, /minmax\(min\(100%, \$\{px\}px\), \$\{px\}px\)/);
assert.match(ui, /gridColumns\(state\.cardSize\)/);
assert.match(ui, /gridColumns\(state\.tileSize\)/);
assert.match(ui, /visual\[Math\.round\(i \* \(visual\.length - 1\) \/ 3\)\]/);
assert.doesNotMatch(ui, /quad-grid/);

// Dispatch-time zone re-check: items scrolled out of range are dropped, not loaded.
assert.match(ui, /items\.shift\(\);[\s\S]*?if \(o\.skip\(item\) \|\| !o\.inRange\(item\)\) continue;/);
assert.match(ui, /inRange: \(s\) => state\.query \|\| getElementZone\(s\.cardEl\)/);
assert.match(ui, /inRange: \(m\) => getElementZone\(m\.tileEl\)/);
assert.match(ui, /if \(!rect\.width && !rect\.height\) return 0;/);
