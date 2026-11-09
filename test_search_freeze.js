// Run: node test_search_freeze.js [path to installed Playwright]
// Typing a search over a large archive must not lock the page up while card
// thumbnails are still loading.
const { chromium } = require(process.argv[2] || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
    const errors = [];
    let thumbs = 0;
    page.on('pageerror', err => errors.push(err.message));
    const studies = Array.from({ length: 300 }, (_, i) => `2025${String(1 + i % 12).padStart(2, '0')}${String(1 + i % 28).padStart(2, '0')}_1200${String(i % 60).padStart(2, '0')}_s${i}`);
    await page.route('http://mvr.test/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/__omnigate/app-session.js') return route.fulfill({ body: '' });
      if (url.pathname === '/api/roots') return route.fulfill({ json: { roots: [{ name: 'share', writable: true }] } });
      if (url.pathname === '/api/me') return route.fulfill({ json: { username: 'test', role: 'admin' } });
      if (url.pathname === '/api/pacs') return route.fulfill({ json: { servers: [] } });
      if (url.pathname === '/api/platform') return route.fulfill({ json: { theme: 'dark', zoom: 100 } });
      if (url.pathname === '/api/files') {
        const folder = url.searchParams.get('path');
        const entries = folder === '/share'
          ? studies.map(name => ({ name, is_dir: true }))
          : Array.from({ length: 4 }, (_, i) => ({ name: `image${i}.jpg`, size: 1234 }));
        await new Promise(r => setTimeout(r, 50));
        return route.fulfill({ json: { entries, next_cursor: '' } }).catch(() => {});
      }
      if (url.pathname === '/api/files/thumbnail') {
        thumbs++;
        await new Promise(r => setTimeout(r, 400));
        return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"/>' }).catch(() => {});
      }
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      return route.fulfill({ contentType: file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript', body: await fs.readFile(path.join(__dirname, file)) });
    });
    await page.goto('http://mvr.test/');
    await page.waitForFunction(n => document.querySelectorAll('.card').length === n, studies.length);
    await page.locator('#search').pressSequentially('25');
    // A frozen main thread never answers; give it a few seconds of hydration.
    for (let i = 0; i < 10; i++) {
      const alive = await Promise.race([
        page.evaluate(() => new Promise(r => setTimeout(() => r(true), 0))),
        new Promise(r => setTimeout(() => r(false), 3000)),
      ]);
      assert.ok(alive, `page froze after typing "25" (thumbnail requests so far: ${thumbs})`);
      await new Promise(r => setTimeout(r, 300));
    }
    assert.deepEqual(errors, []);
    console.log(`PASS: search "25" over ${studies.length} studies keeps the page responsive (${thumbs} thumbnail requests)`);
  } finally { await browser.close(); }
})().catch(err => { console.error(err); process.exitCode = 1; });
