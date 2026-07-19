// E2E regression test for the MP3 download (reader feedback 2026-07-18:
// "The download doesnt work"). Scenario: paste a 3-segment text, Listen with a
// premium voice, Stop mid-first-segment, click MP3.
//   Expected: button stays enabled and the file assembles on demand, fetching
//   the segments playback never reached.
//   Pre-2026-07-19 behavior (the bug): Stop disabled the button until a full
//   end-to-end playback, so most readers could never download.
//
// Run:   npm i puppeteer-core   (one-off; not checked in)
//        node scripts/e2e_download_test.js
//        node scripts/e2e_download_test.js --old   # serve HEAD's readaloud.js to prove the test catches the bug
//
// The TTS endpoints are mocked (real MP3 bytes in timed_payload.json so audio
// genuinely plays); no traffic reaches production. Needs Edge on Windows.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
// puppeteer-core is not checked in — resolve it from wherever you ran `npm i puppeteer-core`
const puppeteer = require(require.resolve('puppeteer-core', { paths: [process.cwd(), __dirname, path.join(__dirname, '..')] }));

const REPO = path.join(__dirname, '..');
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 8931;
const OLD = process.argv.includes('--old');
const payload = fs.readFileSync(path.join(__dirname, 'timed_payload.json'), 'utf8');
const oldJs = OLD ? execSync('git show HEAD:readaloud.js', { cwd: REPO }).toString() : null;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  if (p === '/readaloud.js' && OLD) {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end(oldJs);
  }
  fs.readFile(path.join(REPO, p), (err, data) => {
    if (err) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(data);
  });
});

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new',
    args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--no-first-run'],
  });
  const page = await browser.newPage();

  let timedCalls = 0;
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();
    if (u.startsWith('https://tts.read-aloud.com') || u.includes('onrender.com')) {
      if (req.method() === 'OPTIONS') {
        return req.respond({ status: 204, headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }, body: '' });
      }
      if (u.endsWith('/api/tts/timed')) {
        timedCalls++;
        return req.respond({ status: 200, contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' }, body: payload });
      }
      if (u.match(/\/$/)) return req.respond({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: 'ok' });
      return req.respond({ status: 200, contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' }, body: '[]' });
    }
    if (u.includes('googletagmanager') || u.includes('googlesyndication') || u.includes('formspree')) return req.abort();
    req.continue();
  });
  page.on('console', m => { if (m.type() === 'error') console.log('  [page error]', m.text().slice(0, 120)); });

  // Headless Edge never fires onend for the silent iOS-kick utterance, which
  // hangs the site's init. Stub speak() so init proceeds (real browsers fire it).
  await page.evaluateOnNewDocument(() => {
    const ss = window.speechSynthesis;
    if (ss) ss.speak = u => setTimeout(() => { if (u.onend) u.onend(); }, 10);
  });

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const sel = document.getElementById('voice');
    return sel && [...sel.options].some(o => o.value.startsWith('neural:'));
  }, { timeout: 15000 });

  // 3-segment text (SEGMENT_CHARS=1200)
  const sentence = 'This is a plain test sentence that fills space in the reader. ';
  const text = sentence.repeat(45);
  await page.evaluate(t => {
    const el = document.getElementById('txt');
    el.value = t;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);

  const voice = await page.evaluate(() => {
    const sel = document.getElementById('voice');
    const opt = [...sel.options].find(o => o.value.startsWith('neural:'));
    if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    return sel.value;
  });
  console.log('voice selected:', voice);
  if (!voice.startsWith('neural:')) throw new Error('no neural voice available in test');

  await page.evaluate(() => document.getElementById('start').click());
  await page.waitForFunction(() => /Playing/.test(document.getElementById('status').textContent), { timeout: 20000 });
  await new Promise(r => setTimeout(r, 1200)); // mid-segment-1

  await page.evaluate(() => document.getElementById('stop').click());
  await new Promise(r => setTimeout(r, 400));

  const afterStop = await page.evaluate(() => ({
    status: document.getElementById('status').textContent,
    dlDisabled: document.getElementById('download').disabled,
  }));
  console.log('after Stop:', JSON.stringify(afterStop), '| timed fetches so far:', timedCalls);

  if (afterStop.dlDisabled) {
    console.log(OLD ? 'OLD BUILD: MP3 button dead after Stop — bug reproduced (test correctly FAILS here)'
                    : 'FAIL: MP3 button still disabled after Stop');
    await browser.close(); server.close();
    process.exit(1);
  }

  await page.evaluate(() => document.getElementById('download').click());
  await page.waitForFunction(() => /MP3 ready|Ready/.test(document.getElementById('status').textContent), { timeout: 30000 });

  const final = await page.evaluate(() => ({
    status: document.getElementById('status').textContent,
    dlDisabled: document.getElementById('download').disabled,
    error: (document.getElementById('error') || {}).textContent || '',
  }));
  console.log('after MP3 click:', JSON.stringify(final), '| total timed fetches:', timedCalls);

  const pass = !final.dlDisabled && /MP3 ready/.test(final.status) && timedCalls >= 3 && !final.error.trim();
  console.log(pass ? 'PASS: MP3 assembled on demand after Stop' : 'FAIL: on-demand MP3 did not complete');
  await browser.close(); server.close();
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('TEST ERROR:', e.message); process.exit(2); });
