// E2E regressions for premium playback and MP3 downloads. The mock primary
// server tries to substitute a backup voice; the reader must reject it, request
// the selected premium voice from the second server, and never change accents.
// The test also covers Stop -> MP3 and stale exports after a text edit.
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
const edgePayload = JSON.stringify({ ...JSON.parse(payload), engine: 'edge' });
const backupPayload = JSON.stringify({ ...JSON.parse(payload), engine: 'backup' });
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
  let substitutedResponses = 0;
  let renderEdgeResponses = 0;
  let forceBackupOnly = false;
  const requestedEngines = [];
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
        const body = JSON.parse(req.postData() || '{}');
        requestedEngines.push(body.engine);
        const isPrimary = u.startsWith('https://tts.read-aloud.com');
        const substitute = forceBackupOnly || isPrimary;
        if (substitute) substitutedResponses++; else renderEdgeResponses++;
        return req.respond({ status: 200, contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: substitute ? backupPayload : edgePayload });
      }
      if (u.match(/\/$/)) return req.respond({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: 'ok' });
      return req.respond({ status: 200, contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' }, body: '[]' });
    }
    if (u.includes('googletagmanager') || u.includes('googlesyndication') || u.includes('formspree') || u.includes('read-aloud-feedback') || u.includes('challenges.cloudflare.com')) return req.abort();
    req.continue();
  });
  page.on('console', m => { if (m.type() === 'error') console.log('  [page error]', m.text().slice(0, 120)); });

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
    const opt = [...sel.options].find(o => o.value === 'neural:en-GB-SoniaNeural') ||
      [...sel.options].find(o => o.value.startsWith('neural:'));
    if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    return sel.value;
  });
  console.log('voice selected:', voice);
  if (voice !== 'neural:en-GB-SoniaNeural') throw new Error('UK Sonia voice unavailable in test');

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

  await page.evaluate(() => {
    const el = document.getElementById('txt');
    el.value += ' New text.';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const afterEdit = await page.evaluate(() => ({
    dlDisabled: document.getElementById('download').disabled,
    subtitlesDisabled: document.getElementById('subtitles').disabled,
  }));
  console.log('after text edit:', JSON.stringify(afterEdit));

  const failoverConfirmed = substitutedResponses >= 2 && renderEdgeResponses >= 3 &&
    requestedEngines.every(engine => engine === 'edge');
  console.log('voice consistency:', JSON.stringify({
    substitutedResponses, renderEdgeResponses, requestedEngines,
  }));

  // If both servers try to substitute another voice, stop with the position
  // saved instead of dropping to a browser voice or changing accents.
  forceBackupOnly = true;
  await page.evaluate(() => document.getElementById('start').click());
  await page.waitForFunction(() => /Voice unavailable/.test(document.getElementById('status').textContent),
    { timeout: 20000 });
  const afterOutage = await page.evaluate(() => ({
    status: document.getElementById('status').textContent,
    error: document.getElementById('error').textContent,
    startDisabled: document.getElementById('start').disabled,
  }));
  console.log('after exact voice unavailable:', JSON.stringify(afterOutage));

  const pass = !final.dlDisabled && /MP3 ready/.test(final.status) && timedCalls >= 3 &&
    !final.error.trim() && afterEdit.dlDisabled && afterEdit.subtitlesDisabled &&
    failoverConfirmed && /selected premium voice is temporarily unavailable/i.test(afterOutage.error) &&
    !afterOutage.startDisabled;
  console.log(pass ? 'PASS: selected voice stayed consistent and MP3 lifecycle is sound'
                   : 'FAIL: premium voice or MP3 lifecycle regression');
  await browser.close(); server.close();
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('TEST ERROR:', e.message); process.exit(2); });
