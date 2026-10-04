// Real browser callbacks and actual reader code; all service calls are mocked.
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
const audio = JSON.parse(fs.readFileSync(path.join(__dirname, 'timed_payload.json'), 'utf8'));
const samples = [];
const ttsIds = [];
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.join(root, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(root + path.sep)) { res.writeHead(404).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(data);
  });
});
(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      headless: true, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage();
    await page.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.hostname === 'tts.read-aloud.com' || url.hostname.endsWith('.onrender.com')) {
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        if (url.pathname === '/api/diagnostics') {
          samples.push(request.postDataJSON());
          return route.fulfill({ status: 204, headers: cors });
        }
        if (url.pathname === '/api/tts/timed') {
          ttsIds.push(request.headers()['x-reading-id']);
          const requestBody = request.postDataJSON();
          // Real synthesis is asynchronous; let the gesture-unlock clip's
          // initial events drain before binding the segment's handlers.
          await new Promise(resolve => setTimeout(resolve, 200));
          return route.fulfill({ status: 200, headers: cors, contentType: 'application/json',
            body: JSON.stringify({ ...audio, engine: 'edge', spoken_chars: requestBody.text.length }) });
        }
        return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: '[]' });
      }
      if (url.hostname !== '127.0.0.1') return route.abort();
      return route.continue();
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.selectOption('#voice', 'neural:en-US-AriaNeural');
    await page.fill('#txt', 'Private passage must never appear in diagnostics. '.repeat(10));
    await page.click('#start');
    await page.waitForFunction(() => currentAudio && !currentAudio.paused && currentAudio.currentTime > 0.1);
    await page.evaluate(() => currentAudio.pause());
    await new Promise(resolve => setTimeout(resolve, 150));
    assert(samples.some(s => s.event === 'unexpected_pause' && s.media_paused && !s.paused));
    const id = samples.find(s => s.event === 'start').reading_id;
    assert(ttsIds.every(value => value === id));
    assert(!JSON.stringify(samples).includes('Private passage'));
    await page.click('#stop');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert(samples.some(s => s.event === 'stop'));
    assert.equal(await page.evaluate(() => readerDiagnostics.readingId()), id);
    // Python validates these exact browser payloads against the server schema.
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(samples));
    console.log('PASS real browser Start, TTS correlation, unexpected pause, Stop and diagnostic privacy');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
