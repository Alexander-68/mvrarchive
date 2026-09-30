// Run: node test_header.js [path to an installed playwright or playwright-core]
const assert = require("assert");
const fs = require("fs");
const { chromium } = require(process.argv[2] || "playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    await page.setContent(fs.readFileSync("index.html", "utf8").replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ""));
    await page.addStyleTag({ content: fs.readFileSync("styles.css", "utf8") });
    await page.evaluate(() => {
      window.MVR = { study: {}, api: {
        me: async () => ({ username: "Alexander" }), roots: async () => [], pacs: async () => [],
      } };
      document.querySelector("#root-select").innerHTML = "<option>NAS</option><option>A much longer storage name</option>";
      document.querySelector("#study-count").textContent = "100 studies";
    });
    await page.addScriptTag({ content: fs.readFileSync("js/ui.js", "utf8") });
    const seen = new Set();
    for (let width = 1600; width >= 600; width -= 10) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(20);
      const layout = await page.evaluate(() => {
        const header = document.querySelector(".topbar");
        const flags = ["hide-storage", "hide-user", "hide-brand", "compact-storage"].map(c => header.classList.contains(c));
        return { flags, selectWidth: document.querySelector("#root-select").offsetWidth,
          right: document.querySelector(".topbar-user").getBoundingClientRect().right,
          headerBottom: header.getBoundingClientRect().bottom,
          archiveTop: document.querySelector("#view-archive").getBoundingClientRect().top };
      });
      const stage = layout.flags.filter(Boolean).length;
      seen.add(stage);
      assert.deepEqual(layout.flags, [0, 1, 2, 3].map(i => i < stage), "Collapse order");
      assert(Math.abs(layout.headerBottom - layout.archiveTop) < 1, "Archive stays below header");
      if (stage < 4) assert(layout.right <= width - 15, "Header fits before next collapse");
      else assert(layout.selectWidth < 100, "Dropdown fits selected name, not longest option");
    }
    assert.deepEqual([...seen].sort(), [0, 1, 2, 3, 4], "Each collapse stage is exercised");
    await page.evaluate(() => {
      document.querySelector("#root-select").selectedIndex = 1;
      document.querySelector(".topbar").dispatchEvent(new Event("change"));
    });
    assert(await page.locator("#root-select").evaluate(el => el.offsetWidth > 100), "Dropdown follows changed selection");
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.waitForTimeout(50);
    assert.equal(await page.locator(".topbar").getAttribute("class"), "topbar", "Items return on expansion");
    await page.evaluate(() => { document.querySelector("#user-name").textContent = "A".repeat(180); });
    await page.waitForTimeout(50);
    assert(await page.locator(".topbar").evaluate(el => el.classList.contains("hide-user")), "Content changes trigger fitting");
    console.log("PASS: ordered header collapse, selected storage width, expansion, content updates, and archive offset.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
