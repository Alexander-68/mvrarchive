// Run: node test_viewer_focus.js [path to installed Playwright]
// Viewer focus/inert on open and close; a failed reload after delete still drops the deleted file.
const { chromium } = require(process.argv[2] || 'playwright');
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const ROOT = __dirname;
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
    const errors = []; let deleted = false;
    page.on('pageerror', e => errors.push(e.message));
    await page.route('http://mvr.test/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/__omnigate/app-session.js') return route.fulfill({ body: '' });
      if (url.pathname === '/api/roots') return route.fulfill({ json: { roots: [{ name: 'share', writable: true }] } });
      if (url.pathname === '/api/me') return route.fulfill({ json: { username: 't' } });
      if (url.pathname === '/api/pacs') return route.fulfill({ json: { servers: [] } });
      if (url.pathname === '/api/platform') return route.fulfill({ json: { theme: 'dark' } });
      if (url.pathname === '/api/files/delete') { deleted = true; return route.fulfill({ json: { deleted: true } }); }
      if (url.pathname === '/api/files') {
        const folder = url.searchParams.get('path');
        if (folder === '/share') return route.fulfill({ json: { entries: [{ name: 'study', is_dir: true }] } });
        if (deleted) return route.fulfill({ status: 500, json: { error: 'listing down' } });
        return route.fulfill({ json: { entries: ['a.jpg', 'b.jpg', 'c.jpg'].map(name => ({ name, size: 10 })) } });
      }
      if (url.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>' });
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const type = { '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'text/javascript';
      try { return route.fulfill({ contentType: type, body: await fs.readFile(path.join(ROOT, file)) }); } catch { return route.fulfill({ status: 404 }); }
    });
    await page.goto('http://mvr.test/');
    await page.locator('.card').first().click();
    await page.waitForFunction(() => document.querySelectorAll('.media-tile').length === 3);
    await page.locator('.media-tile').nth(1).click();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'viewer', 'focus moves into the viewer');
    assert.ok(await page.evaluate(() => document.querySelector('header').inert && document.querySelector('#view-study').inert), 'backdrop inert');
    await page.keyboard.press('Escape');
    assert.ok(await page.evaluate(() => document.querySelector('#viewer').hidden && !document.querySelector('header').inert), 'closed, backdrop live');
    assert.ok(await page.evaluate(() => !document.activeElement.closest('#viewer')), 'focus leaves the hidden viewer');
    // select b.jpg (focused tile) and delete; the reload listing then fails
    await page.keyboard.press(' ');
    await page.keyboard.press('Delete');
    await page.locator('#modal-ok').click();
    await page.waitForFunction(() => document.querySelectorAll('.media-tile').length === 2);
    const names = await page.locator('.media-tile').allTextContents();
    assert.ok(!names.some(n => n.includes('b.jpg')), 'deleted tile gone though reload failed');
    assert.deepEqual(errors, []);
    console.log('PASS: viewer focus/inert/restore; failed reload drops deleted file');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
