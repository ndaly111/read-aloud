// Execute the real network functions with a fake clock and scripted responses.
// No requests reach production; the returned audio and text are synthetic.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const source = fs.readFileSync(path.join(__dirname, '..', 'readaloud.js'), 'utf8');
function section(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `Missing source section: ${from}`);
  return source.slice(start, end);
}
const primary = 'https://tts.read-aloud.com';
const backup = 'https://read-aloud-s4ov.onrender.com';
const voice = 'en-US-GuyNeural';
const text = 'A synthetic sentence for the selected voice.';
function harness(kind) {
  let now = 100000;
  const requests = [], events = [], timers = new Map(), replies = [];
  let timerId = 0;
  const ctx = vm.createContext({
    console: { log() {}, warn() {} }, Blob, Uint8Array, AbortController, atob,
    Date: { now: () => now },
    setTimeout(fn, delay) {
      // Resolve only retry backoffs; request deadlines remain pending until cleared.
      if (delay < 3000) { now += delay; queueMicrotask(fn); }
      const id = ++timerId;
      timers.set(id, fn);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    rateToApiFormat: rate => `+${(rate - 1) * 100}%`,
    readerDiagnostics: {
      headers: () => ({ 'X-Reading-ID': 'synthetic-reading' }),
      record: (...args) => events.push(args),
    },
    fetch: async (url, options) => {
      requests.push({ host: new URL(url).origin, body: JSON.parse(options.body) });
      assert.ok(replies.length, 'Unexpected extra network request');
      const reply = replies.shift();
      if (reply === 'abort') {
        const error = new Error('Synthetic deadline'); error.name = 'AbortError'; throw error;
      }
      const status = typeof reply === 'number' ? reply : 200;
      return {
        status, ok: status === 200,
        json: async () => status === 200 ? {
          audio: Buffer.alloc(200, 1).toString('base64'),
          engine: reply === 'substitute' ? 'backup' : 'edge',
          spoken_chars: text.length, words: [[0, 0]],
        } : { detail: 'Synthetic upstream failure' },
        blob: async () => new Blob([Buffer.alloc(200, 1)]),
      };
    },
  });
  vm.runInContext(section('const TTS_ENDPOINTS', '// One reusable <audio>'), ctx);
  vm.runInContext(section('async function fetchTimedSegment(', '// Playback and exports'), ctx);
  vm.runInContext(section('async function fetchChunkWithRetry(', '// Legacy chunked player'), ctx);
  return {
    requests, events, replies,
    advance: ms => { now += ms; },
    order: () => Array.from(ctx.ttsUrlOrder()),
    run: async () => {
      const seg = { text, start: 80 };
      if (kind === 'timed') {
        await ctx.fetchTimedSegment(seg, voice, 'test');
        assert.equal(seg.engine, 'edge');
        assert.equal(seg.words[0][1], 80, 'Preserve absolute word positions');
        return seg.blob;
      }
      return ctx.fetchChunkWithRetry(text, voice, 0, 2);
    },
    verifyRequests: () => {
      for (const request of requests) {
        assert.equal(request.body.voice, voice);
        assert.equal(request.body.text, text);
        if (kind === 'timed') assert.equal(request.body.engine, 'edge');
        else assert.equal(request.body.rate, '+100%');
      }
      assert.equal(replies.length, 0, 'Consume expected responses');
    },
  };
}

(async () => {
  for (const kind of ['timed', 'mp3']) {
    for (const failure of [504, 502, 503, 530, 429, 'abort']) {
      const h = harness(kind);
      h.replies.push(failure, 200, 200, 200, 200);
      await h.run();
      assert.deepEqual(h.requests.map(r => r.host), [primary, backup]);
      assert.equal(h.events[0][1], failure === 'abort' ? 'timeout' : `http-${failure}`);
      h.advance(29999);
      await h.run();
      assert.equal(h.requests.at(-1).host, backup, 'Briefly retain working backup');
      h.advance(1);
      await h.run();
      assert.equal(h.requests.at(-1).host, primary, 'Retry primary after 30 seconds');
      await h.run();
      assert.equal(h.requests.at(-1).host, primary, 'Stay on recovered primary');
      h.verifyRequests();
    }
    // A fast upstream 500 can recover on one retry without any Render bandwidth.
    let h = harness(kind);
    h.replies.push(500, 200);
    await h.run();
    assert.deepEqual(h.requests.map(r => r.host), [primary, primary]);
    assert.equal(h.events[0][1], 'http-500');
    h.verifyRequests();

    // If the backup fails during cooldown, the primary is still attempted.
    h = harness(kind);
    h.replies.push(504, 200, 503, 200);
    await h.run(); await h.run();
    assert.deepEqual(h.requests.map(r => r.host), [primary, backup, backup, primary]);
    assert.equal(h.order()[0], primary);
    h.verifyRequests();

    // Both hosts down: bounded attempts, reject, and let the player save position.
    h = harness(kind);
    h.replies.push(504, 504);
    await assert.rejects(h.run(), error => error.status === 504);
    assert.deepEqual(h.requests.map(r => r.host), [primary, backup]);
    h.verifyRequests();
    console.log(`PASS ${kind}: immediate timeout failover, 30-second recovery, bounded retry, exact voice and HTTP diagnostics`);
  }
  let h = harness('timed');
  h.replies.push('substitute', 'substitute', 200);
  await h.run();
  assert.deepEqual(h.requests.map(r => r.host), [primary, primary, backup]);
  h.verifyRequests();
  h = harness('timed');
  h.replies.push('substitute', 'substitute', 'substitute', 'substitute');
  await assert.rejects(h.run(), /substituted a different voice/);
  h.verifyRequests();
  h = harness('timed');
  h.replies.push(404, 404);
  await assert.rejects(h.run(), error => error.legacy === true);
  h.verifyRequests();
  console.log('PASS: substituted voices rejected and legacy endpoint detection retained');
})().catch(error => { console.error(error); process.exitCode = 1; });
