// Deterministic transport/lifecycle checks; no production requests.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert/strict');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '..', 'playback-diagnostics.js'), 'utf8');
let now = 0;
let counter = 0;
let failFetch = false;
const requests = [];
const callbacks = {};
const timers = new Map();
const ctx = {
  navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 10; PersonalDevice) Chrome/154.0.0.0', onLine: true },
  document: { visibilityState: 'visible', addEventListener(name, cb) { callbacks[name] = cb; } },
  addEventListener(name, cb) { callbacks[name] = cb; },
  Date: { now: () => now },
  crypto: { randomUUID: () => `b48e0c45-31c6-4c07-9363-${String(++counter).padStart(12, '0')}` },
  setInterval(cb) { timers.set(counter, cb); return counter; },
  clearInterval(id) { timers.delete(id); },
  fetch(url, options) {
    requests.push({ url, options, data: JSON.parse(options.body) });
    if (failFetch) throw new Error('transport unavailable');
    return Promise.reject(new Error('no network in tests'));
  },
};
vm.createContext(ctx);
vm.runInContext(source, ctx);
const d = ctx.readerDiagnostics;
let state = { position: 420, total_chars: 1200, segment: 0, media_time_ms: 30000,
  media_duration_ms: 69000, media_paused: true, media_muted: false, speaking: true,
  paused: false, speech_speaking: false, speech_pending: false, speech_paused: false,
  rate: 1, volume: 1, text: 'private text', error: 'private error', email: 'private@example.com' };
d.begin('premium', 'en-US-AriaNeural', 'en', () => state, '20261010unicode1');
assert.equal(requests[0].data.event, 'start');
assert.equal(requests[0].data.reader_build, '20261010unicode1');
const firstId = d.readingId();
assert.equal(d.headers()['X-Reading-ID'], firstId);
assert.equal(requests[0].data.browser, 'Chrome');
assert.equal(requests[0].data.browser_major, 154);
assert.equal(requests[0].data.os, 'Android');
assert.equal(requests[0].options.credentials, 'omit');
assert.equal(requests[0].options.referrerPolicy, 'no-referrer');
d.record('unexpected_pause');
assert.equal(requests[1].data.media_time_ms, 30000);
d.record('unexpected_pause');
assert.equal(requests.length, 2);
for (let attempt = 1; attempt <= 4; attempt++) {
  d.record('fetch_error', 'incomplete-audio', firstId, {
    endpoint: attempt <= 2 ? 'primary' : 'render', request_id: 7, attempt,
    request_start: 12043, request_chars: 1185, request_ms: 378, http_status: 200,
    stage: 'validation', expected_chars: 1185, returned_chars: 1184,
    text: 'private text', error: 'private error', email: 'private@example.com',
  });
}
assert.equal(requests.length, 6, 'Do not deduplicate distinct retry attempts');
assert.equal(requests.at(-1).data.request_start, 12043);
assert.equal(requests.at(-1).data.returned_chars, 1184);
d.record('fetch_recovered', '', firstId, {endpoint: 'primary', request_id: 8, attempt: 1, stage: 'complete'});
assert.equal(requests.at(-1).data.event, 'fetch_recovered');
d.record('fetch_error', 'network', firstId, {endpoint: 'private@example.com', stage: 'private error', request_ms: Infinity});
assert.equal(requests.at(-1).data.endpoint, '');
assert.equal(requests.at(-1).data.stage, '');
assert.equal(requests.at(-1).data.request_ms, 0);
now += 6000; ctx.document.visibilityState = 'hidden'; callbacks.visibilitychange();
assert.equal(requests.at(-1).data.visibility, 'hidden');
const serialized = JSON.stringify(requests);
for (const privateValue of ['private text', 'private error', 'private@example.com', 'PersonalDevice', 'Mozilla/5.0']) {
  assert(!serialized.includes(privateValue));
}
d.end('stop');
assert.equal(Object.keys(d.headers()).length, 0);
assert.equal(d.readingId(), firstId); // feedback can identify the stopped reading
assert.equal(timers.size, 0);
let count = requests.length;
d.record('audio_error');callbacks.visibilitychange();
assert.equal(requests.length, count);
d.begin('browser', 'private device voice label', 'en', () => state);
assert.equal(requests.at(-1).data.voice, 'device');
assert.equal(requests.at(-1).data.reader_build, ''); // old reader with new diagnostics
count = requests.length;
d.record('fetch_error', 'timeout', firstId);
assert.equal(requests.length, count); // a late request cannot pollute the new reading
failFetch = true;
assert.doesNotThrow(() => d.record('audio_error', 'private exception'));
assert.equal(requests.at(-1).data.code, 'unknown');
for (let i = 0; i < 100; i++) { now += 15000; [...timers.values()][0](); }
assert.equal(requests.at(-1).data.seq, 60);
d.record('voice_error', 'synthesis-failed');
assert.equal(requests.at(-1).data.seq, 61);
for (let i = 0; i < 100; i++) { now += 6000; d.record('audio_error', 'audio-3'); }
assert.equal(requests.at(-1).data.seq, 80);
callbacks.pagehide();
assert.equal(timers.size, 0);
assert.equal(Object.keys(d.headers()).length, 0);
console.log('PASS playback state, privacy, correlation, deduplication, lifecycle, limits and transport failures');
