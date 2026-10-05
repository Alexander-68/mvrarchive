// Run: node test_preview_recovery.js [path to installed Playwright]
const { chromium } = require(process.argv[2] || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
    const errors = [], attempts = new Map(), videoReads = [];
    let broken = true;
    page.on('pageerror', err => errors.push(err.message));
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
          ? ['many', 'videos'].map(name => ({ name, is_dir: true }))
          : folder.endsWith('/videos')
            ? Array.from({ length: 8 }, (_, i) => ({ name: `video${i}.mp4`, size: 1234 }))
            : Array.from({ length: 320 }, (_, i) => ({ name: `image${String(i).padStart(3, '0')}.jpg`, size: 1234 }));
        const offset = Number(url.searchParams.get('cursor') || 0);
        return route.fulfill({ json: { entries: entries.slice(offset, offset + 256), next_cursor: entries.length > offset + 256 ? String(offset + 256) : '' } });
      }
      if (url.pathname === '/api/files/thumbnail') {
        const file = url.searchParams.get('path');
        const attempt = (attempts.get(file) || 0) + 1; attempts.set(file, attempt);
        if (broken && file.endsWith('image001.jpg')) return route.fulfill({ status: 422, json: { error: 'test decode failure' } });
        if (attempt <= 2) return route.fulfill({ status: attempt === 1 ? 503 : 429, headers: { 'Retry-After': '0.1' }, json: { error: 'busy' } });
        return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="green"/></svg>' });
      }
      if (url.pathname === '/api/files/read') {
        videoReads.push(url.searchParams.get('path'));
        return route.fulfill({ status: 404 });
      }
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      return route.fulfill({ contentType: file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript', body: await fs.readFile(path.join(__dirname, file)) });
    });
    await page.goto('http://mvr.test/');
    await page.waitForFunction(() => [...document.querySelectorAll('.card-thumb')].length === 2 && [...document.querySelectorAll('.card-thumb')].every(c => c.querySelector('img')?.naturalWidth > 0));
    assert.deepEqual(videoReads, [], 'temporary video poster failures must not download full videos');
    await page.locator('#grid').evaluate(grid => {
      for (let i = 0; i < 7; i++) grid.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => document.querySelectorAll('.card-thumb.quad img').length === 8 && [...document.querySelectorAll('.card-thumb.quad img')].every(img => img.naturalWidth > 0));
    assert.deepEqual(videoReads, [], 'all four video card posters recover without browser fallback');
    await page.locator('.card').filter({ hasText: 'many' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.media-tile').length === 320);
    const retry = page.locator('.media-tile').filter({ hasText: 'image001.jpg' }).getByRole('button', { name: 'Retry preview' });
    await retry.waitFor();
    broken = false;
    await retry.click();
    const visibleComplete = () => {
      const wrap = document.querySelector('.media-wrap').getBoundingClientRect();
      const tiles = [...document.querySelectorAll('.media-tile')].filter(t => { const r = t.getBoundingClientRect(); return r.bottom > wrap.top && r.top < wrap.bottom; });
      return tiles.length > 0 && tiles.every(t => t.querySelector('img')?.naturalWidth > 0);
    };
    await page.waitForFunction(visibleComplete, null, { timeout: 10000 });
    await page.locator('.media-wrap').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.waitForFunction(visibleComplete, null, { timeout: 10000 });
    await page.locator('.media-wrap').evaluate(el => { el.scrollTop = 0; });
    await page.waitForFunction(visibleComplete);
    assert.equal(await page.locator('.media-tile .preview-retry').count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS: 320-image pagination, 429/503 recovery, video card posters, visible tiles after scrolling, explicit retry after decode failure');
  } finally { await browser.close(); }
})().catch(err => { console.error(err); process.exitCode = 1; });
