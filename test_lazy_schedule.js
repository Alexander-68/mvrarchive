const assert = require("assert");
const fs = require("fs");

const ui = fs.readFileSync("js/ui.js", "utf8");
assert.match(ui, /function onScroll\(\)[\s\S]*?scanAndScheduleLazyLoads\(\);/);
assert.match(ui, /function scanAndScheduleLazyLoads\(\)[\s\S]*?cardQueue\.length = 0;[\s\S]*?enqueueCard\(study, zone, false\);[\s\S]*?pumpCardQueue\(\);/);
assert.match(ui, /mediaQueue\.length = 0;[\s\S]*?enqueueMedia\(m\.tileEl\._queueItem, zone, false\);[\s\S]*?pumpMediaQueue\(\);/);
assert.match(ui, /function zoomCards\(deltaPx\)[\s\S]*?applyCardSize\(\);/);
assert.match(ui, /function scheduleCardScan\(\)[\s\S]*?setTimeout\(scanAndScheduleLazyLoads, 130\)/);
assert.match(ui, /minmax\(min\(100%, \$\{state\.cardSize\}px\), \$\{state\.cardSize\}px\)/);
assert.match(ui, /minmax\(min\(100%, \$\{state\.tileSize\}px\), \$\{state\.tileSize\}px\)/);
assert.match(ui, /images\[Math\.round\(i \* \(images\.length - 1\) \/ 3\)\]/);
assert.doesNotMatch(ui, /quad-grid/);

// Dispatch-time zone re-check: items scrolled out of range are dropped, not loaded.
assert.match(ui, /cardQueue\.shift\(\);[\s\S]*?if \(!getElementZone\(topStudy\.cardEl\)\) continue;/);
assert.match(ui, /mediaQueue\.shift\(\);[\s\S]*?if \(!getElementZone\(topItem\.media\.tileEl\)\) continue;/);
assert.match(ui, /if \(!rect\.width && !rect\.height\) return 0;/);
