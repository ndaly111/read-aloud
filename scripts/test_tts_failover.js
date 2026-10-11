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
function harness(kind, inputText = text) {
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
      requests.push({ host: new URL(url).origin, body: JSON.parse(options.body), headers: options.headers });
      assert.ok(replies.length, 'Unexpected extra network request');
      const reply = replies.shift();
      if (reply === 'abort') {
        const error = new Error('Synthetic deadline'); error.name = 'AbortError'; throw error;
      }
      if (reply === 'network') throw new TypeError('Synthetic network failure');
      const status = typeof reply === 'number' ? reply : 200;
      return {
        status, ok: status === 200,
        json: async () => {
          if (reply === 'bad-json') throw new SyntaxError('Synthetic malformed JSON');
          if (reply && typeof reply === 'object') return reply;
          return status === 200 ? {
          audio: Buffer.alloc(200, 1).toString('base64'),
          engine: reply === 'substitute' ? 'backup' : 'edge',
          spoken_chars: Array.from(inputText).length, words: [[0, 0]],
        } : { detail: 'Synthetic upstream failure' };
        },
        blob: async () => new Blob([Buffer.alloc(200, 1)]),
      };
    },
  });
  vm.runInContext(section('const TTS_ENDPOINTS', '// One reusable <audio>'), ctx);
  vm.runInContext(section('async function fetchTimedSegment(', '// Playback and exports'), ctx);
  vm.runInContext(section('async function fetchChunkWithRetry(', '// Legacy chunked player'), ctx);
  return {
    requests, events, replies, ctx,
    advance: ms => { now += ms; },
    order: () => Array.from(ctx.ttsUrlOrder()),
    run: async () => {
      const seg = { text: inputText, start: 80 };
      if (kind === 'timed') {
        await ctx.fetchTimedSegment(seg, voice, 'test');
        assert.equal(seg.engine, 'edge');
        assert.equal(seg.words[0][1], 80, 'Preserve absolute word positions');
        return seg.blob;
      }
      return ctx.fetchChunkWithRetry(inputText, voice, 0, 2, 80);
    },
    verifyRequests: () => {
      for (const request of requests) {
        assert.equal(request.body.voice, voice);
        assert.equal(request.body.text, inputText);
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

  // Execute the real decoder against old and new server contracts. Neither may
  // silently skip text, misalign highlights, or poison the segment cache.
  const unicode = '🚀 Hello 𠮷 world';
  const audio = Buffer.alloc(200, 1).toString('base64');
  for (const modern of [false, true]) {
    h = harness('timed', unicode);
    const payload = { audio, engine: 'edge', spoken_chars: modern ? unicode.length : Array.from(unicode).length,
      words: modern ? [[100, 3], [900, 12]] : [[100, 2], [900, 10]] };
    if (modern) payload.text_units = 'utf16';
    h.replies.push(payload);
    const seg = { text: unicode, start: 80 };
    await h.ctx.fetchTimedSegment(seg, voice, 'unicode');
    assert.deepEqual(JSON.parse(JSON.stringify(seg.words)), [[0.1, 83], [0.9, 92]]);
    assert.equal(seg.blob.size, 200);
    assert.equal(h.requests.length, 1, 'Unicode must not require retries');
    assert.equal(h.events.length, 0, 'Successful primary requests do not flood diagnostics');
    h.verifyRequests();
  }
  const valid = { audio, engine: 'edge', text_units: 'utf16', spoken_chars: text.length, words: [[0, 0]] };
  for (const [reply, code, stage] of [
    [{ ...valid, spoken_chars: text.length - 1 }, 'incomplete-audio', 'validation'],
    [{ ...valid, audio: '%%%invalid' }, 'invalid-audio', 'decode'],
    [{ ...valid, audio: 'YQ==' }, 'audio-too-small', 'decode'],
    [{ ...valid, words: [[0, text.length]] }, 'invalid-response', 'validation'],
    [{ ...valid, text_units: 'unknown' }, 'invalid-response', 'validation'],
    ['bad-json', 'invalid-response', 'response'],
    ['network', 'network', 'network'],
  ]) {
    h = harness('timed');
    h.replies.push(reply, reply, reply, reply);
    const seg = { text, start: 12043 };
    await assert.rejects(h.ctx.fetchTimedSegment(seg, voice, 'bad'), error => h.ctx.ttsFailureCode(error) === code);
    assert.equal(seg.blob, undefined, 'A failed response cannot leave cached audio');
    assert.equal(h.events.length, 4);
    h.events.forEach((event, i) => {
      assert.equal(event[1], code);
      assert.equal(event[3].request_id, 1);
      assert.equal(event[3].attempt, i + 1);
      assert.equal(event[3].request_start, 12043, 'Track fetched position, not currently playing position');
      assert.equal(event[3].stage, stage);
      assert.equal(event[3].endpoint, i < 2 ? 'primary' : 'render');
      assert.equal(h.requests[i].headers['X-TTS-Request-ID'], '1');
      assert.equal(h.requests[i].headers['X-TTS-Attempt'], String(i + 1));
    });
    h.verifyRequests();
  }
  h = harness('timed');
  h.replies.push(504, 200);
  await h.run();
  const recovery = h.events.find(event => event[0] === 'fetch_recovered');
  assert.ok(recovery);
  assert.equal(recovery[3].endpoint, 'render');
  assert.equal(recovery[3].attempt, 2);
  assert.equal(recovery[3].http_status, 200);
  assert.equal(recovery[3].stage, 'complete');
  console.log('PASS: Unicode compatibility, accurate anchors, strict validation, uncached failures and correlated recovery diagnostics');
})().catch(error => { console.error(error); process.exitCode = 1; });
