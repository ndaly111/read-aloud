// Real homepage + reader + consent code; all external requests are intercepted.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep)) return res.writeHead(404).end();
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end();
    res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' :
      file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(data);
  });
});
const goal = () => ({ ready: true, experiment_active: true, experiment_id: 'support_goal_2026_10',
  currency: 'USD', data_scope: 'verified_one_time_usd_donations', goals_cents: { B: 5000, C: 10000 },
  raised_cents: 4250, month_label: new Intl.DateTimeFormat('en-US', {
    month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date()),
  as_of: new Date().toISOString(), launch_at: new Date(Date.now() - 86400000).toISOString() });

(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true,
      executablePath: process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
    const url = `http://127.0.0.1:${server.address().port}/`;
    async function scenario({ variant = 'B', consent = 'rejected', payload = goal(), width = 1280, blocked = false, slow = false, seed = true, rejectByte = false } = {}) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(({ variant, consent, blocked, seed, rejectByte }) => {
        window.testEvents = [];
        window.gtag = (...args) => window.testEvents.push(args);
        // Deterministic allocation if storage is unavailable.
        const fill = ['A', 'B', 'C'].indexOf(variant);
        let first = true;
        Object.defineProperty(window.crypto, 'getRandomValues', { value: bytes => {
          bytes.fill(first && rejectByte ? 255 : fill); first = false; return bytes;
        } });
        if (blocked) {
          for (const storage of ['localStorage', 'sessionStorage']) Object.defineProperty(window, storage, {
            get() { throw new DOMException('Storage blocked', 'SecurityError'); } });
        } else {
          localStorage.setItem('ra_cookie_consent', consent);
          if (seed) sessionStorage.setItem('ra_support_exp_202610', variant);
          if (seed && consent === 'accepted') localStorage.setItem('ra_support_exp_202610', variant);
        }
      }, { variant, consent, blocked, seed, rejectByte });
      await page.route('**/*', async route => {
        const host = new URL(route.request().url()).hostname;
        if (host === 'read-aloud-donation-goal.ndaly111.workers.dev') {
          if (slow) { await new Promise(resolve => setTimeout(resolve, 4500)); return route.abort().catch(() => {}); }
          return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(payload) });
        }
        if (host !== '127.0.0.1') return route.abort();
        return route.continue();
      });
      await page.goto(url);
      return { page, context, errors };
    }
    const a = await scenario({ variant: 'A' });
    await a.page.waitForFunction(() => document.querySelector('#supportBar').dataset.donationVariant === 'A');
    const original = await a.page.locator('#supportBar .msg').textContent();
    assert(original.startsWith('No ads, no tracking'));
    assert.equal(await a.page.locator('.support-goal').count(), 0);
    assert.equal(await a.page.locator('.coffeeBtn').textContent(), 'Buy me a coffee');
    const b = await scenario({ consent: 'accepted' });
    await b.page.waitForFunction(() => document.querySelector('progress')?.value === 4250);
    assert((await b.page.locator('.support-goal__totals').textContent()).startsWith('$42.50 of $50'));
    assert.equal(await b.page.locator('.support-goal__progress').getAttribute('max'), '5000');
    assert.equal(await b.page.locator('.coffeeBtn').getAttribute('href'), 'https://coff.ee/readaloud');
    assert.equal(await b.page.evaluate(() => localStorage.getItem('ra_support_exp_202610')), 'B');
    assert.equal((await b.page.evaluate(() => testEvents.filter(event => event[1] === 'donation_experiment_view'))).length, 1);
    await b.page.locator('.coffeeBtn').dispatchEvent('click');
    assert.equal((await b.page.evaluate(() => testEvents.filter(event => event[1] === 'donation_experiment_click'))).length, 1);
    await b.page.evaluate(() => {
      localStorage.setItem('ra_cookie_consent', 'rejected');
      window.dispatchEvent(new CustomEvent('ra-consent-change', { detail: 'rejected' }));
    });
    assert.equal(await b.page.evaluate(() => localStorage.getItem('ra_support_exp_202610')), null);
    assert.equal(await b.page.evaluate(() => sessionStorage.getItem('ra_support_exp_202610')), 'B');
    await b.page.evaluate(() => {
      localStorage.setItem('ra_cookie_consent', 'accepted');
      window.dispatchEvent(new CustomEvent('ra-consent-change', { detail: 'accepted' }));
    });
    assert.equal(await b.page.evaluate(() => localStorage.getItem('ra_support_exp_202610')), 'B');
    await b.page.evaluate(() => {
      localStorage.removeItem('ra_cookie_consent');
      window.dispatchEvent(new StorageEvent('storage', { key: 'ra_cookie_consent' }));
    });
    assert.equal(await b.page.evaluate(() => localStorage.getItem('ra_support_exp_202610')), null);
    // The existing reader remains usable with the challenger present.
    await b.page.fill('#txt', 'Reading still works while the support goal is displayed.');
    assert.equal(await b.page.locator('#start').isEnabled(), true);
    assert.deepEqual(b.errors, []);
    const desktopScreenshot = process.env.DONATION_SCREENSHOT_DIR;
    if (desktopScreenshot) {
      fs.mkdirSync(desktopScreenshot, { recursive: true });
      await b.page.locator('#supportBar').screenshot({ path: path.join(desktopScreenshot, 'donation-desktop.png') });
    }
    await a.context.close(); await b.context.close();
    const c = await scenario({ variant: 'C', consent: 'accepted' });
    await c.page.waitForFunction(() => document.querySelector('#supportBar').dataset.donationVariant === 'C');
    assert((await c.page.locator('.support-goal__totals').textContent()).startsWith('$42.50 of $100'));
    assert.equal(await c.page.locator('.support-goal__progress').getAttribute('max'), '10000');
    assert.equal(await c.page.evaluate(() => localStorage.getItem('ra_support_exp_202610')), 'C');
    assert.equal((await c.page.evaluate(() => testEvents.find(event => event[1] === 'donation_experiment_view')))[2].variant_id, 'C');
    assert.deepEqual(c.errors, []);
    if (desktopScreenshot) await c.page.locator('#supportBar').screenshot({ path: path.join(desktopScreenshot, 'donation-100-desktop.png') });
    await c.context.close();
    for (const variant of ['A', 'B', 'C']) {
      const random = await scenario({ variant, seed: false, rejectByte: variant === 'C' });
      await random.page.waitForFunction(expected => document.querySelector('#supportBar').dataset.donationVariant === expected, variant);
      assert.deepEqual(random.errors, []);
      await random.context.close();
    }
    for (const variant of ['B', 'C']) {
      const funded = await scenario({ variant, width: 375, payload: { ...goal(), raised_cents: 7500 } });
      await funded.page.waitForFunction(() => !!document.querySelector('.support-goal'));
      assert.equal(await funded.page.locator('.support-goal__progress').getAttribute('value'), variant === 'B' ? '5000' : '7500');
      assert((await funded.page.locator('.support-goal__totals').textContent()).startsWith(variant === 'B' ? '$75 of $50' : '$75 of $100'));
      assert.equal(await funded.page.locator('#supportBar').evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
      await funded.context.close();
    }
    for (const width of [320, 375, 768]) {
      const mobile = await scenario({ width });
      await mobile.page.waitForFunction(() => !!document.querySelector('.support-goal'));
      const overflow = await mobile.page.locator('#supportBar').evaluate(el => el.scrollWidth > el.clientWidth + 1);
      assert.equal(overflow, false, `support bar overflow at ${width}px`);
      if (desktopScreenshot && width === 375) await mobile.page.locator('#supportBar').screenshot({ path: path.join(desktopScreenshot, 'donation-mobile.png') });
      assert.deepEqual(mobile.errors, []);
      await mobile.context.close();
    }
    for (const payload of [{ ready: false }, { ...goal(), experiment_active: false },
      { ...goal(), as_of: '2020-01-01T00:00:00Z' }, { ...goal(), month_label: 'January 2020' },
      { ...goal(), raised_cents: -1 }, { ...goal(), goals_cents: { B: 0, C: 10000 } },
      { ...goal(), goals_cents: { B: 5000 } }, { ...goal(), goals_cents: { B: 5000, C: 5000 } }, null]) {
      const inactive = await scenario({ payload });
      await inactive.page.waitForLoadState('networkidle');
      assert.equal(await inactive.page.locator('#supportBar .msg').textContent(), original);
      assert.equal(await inactive.page.locator('#supportBar').getAttribute('data-donation-variant'), null);
      assert.equal((await inactive.page.evaluate(() => testEvents.filter(event => event[0] === 'event'))).length, 0);
      assert.deepEqual(inactive.errors, []);
      await inactive.context.close();
    }
    const blocked = await scenario({ blocked: true });
    await blocked.page.waitForFunction(() => !!document.querySelector('.support-goal'));
    await blocked.page.locator('[data-consent="accept"]').click();
    assert.equal(await blocked.page.locator('.cookie-banner').count(), 0);
    assert.deepEqual(blocked.errors, []);
    await blocked.context.close();
    const slow = await scenario({ slow: true });
    await slow.page.waitForTimeout(4200);
    assert.equal(await slow.page.locator('#supportBar').getAttribute('data-donation-variant'), null);
    assert.equal(await slow.page.locator('#supportBar .msg').textContent(), original);
    assert.deepEqual(slow.errors, []);
    await slow.context.close();
    console.log('Homepage control/$50/$100, random allocation, consent changes, overfunding, mobile layouts and fallbacks passed.');
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
