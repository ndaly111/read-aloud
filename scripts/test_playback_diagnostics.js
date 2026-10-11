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
  URL, location: { origin: 'https://read-aloud.com', href: 'https://read-aloud.com/?private=query' },
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
assert.equal(requests.at(-1).data.seq, 100);
d.feedback();
assert.equal(requests.at(-1).data.seq, 101, 'Reserve a feedback report even after error slots are exhausted');
assert.equal(requests.at(-1).data.report.kind, 'feedback');
callbacks.pagehide();
assert.equal(timers.size, 0);
assert.equal(Object.keys(d.headers()).length, 0);

failFetch = false;
state = { ...state, speaking: true, paused: false, phase: 'playing', loop_on: true,
  loop_gap_sec: 180, loop_gap_active: false, loop_remaining_ms: 0, selected_voice: 'en-US-GuyNeural', selected_language: 'en' };
ctx.document.visibilityState = 'visible';
d.begin('premium', 'en-US-AriaNeural', 'en', () => state, '20261011reports1');
const reportId = d.readingId();
d.record('loop_change');
state.loop_on = false;
d.record('loop_change'); // do not deduplicate a distinct setting within five seconds
const error = { name: 'TypeError', message: 'private text private@example.com',
  stack: 'TypeError: private text\n at privateFunction (https://read-aloud.com/readaloud.js?private=query:123:45)\n' +
    'at secret (https://tracking.example/script.js:5:6)\n at reader (https://read-aloud.com/index.html:10:2)' };
callbacks.error({ error, filename: 'https://read-aloud.com/readaloud.js?private=query', lineno: 123, colno: 45 });
let report = requests.at(-1).data;
assert.equal(report.event, 'runtime_error');
assert.equal(report.reading_id, reportId);
assert.equal(report.report.error_name, 'TypeError');
assert.equal(report.report.frames.length, 2);
assert.equal(report.report.frames[0].file, 'readaloud.js');
assert.equal(report.report.frames[0].line, 123);
assert.equal(report.selected_voice, 'en-US-GuyNeural');
assert.equal(report.loop_gap_sec, 180);
assert.deepEqual(Array.from(report.report.breadcrumbs.filter(b => b.event === 'loop_change'), b => b.loop_on), [true, false]);
count = requests.length;
callbacks.error({ error, filename: 'https://third-party.example/readaloud.js', lineno: 1 });
// The error stack still has our frames, so use an entirely third-party stack.
callbacks.error({ error: { name: 'Error', stack: 'at https://third-party.example/readaloud.js:1:2' }, filename: 'https://third-party.example/readaloud.js' });
assert.equal(requests.length, count);
now += 6000;
callbacks.unhandledrejection({ reason: error });
assert.equal(requests.at(-1).data.report.kind, 'unhandled-rejection');
callbacks.error({ target: { src: 'https://read-aloud.com/readaloud.js?private=query' } });
assert.equal(requests.at(-1).data.report.kind, 'resource-error');
for (let i = 0; i < 20; i++) { now += 6000; d.record('seek'); }
d.end('finish');
d.capture('export_error', error, reportId, { export_type: 'mp3', code: 'network', text: 'private text' });
report = requests.at(-1).data;
assert.equal(report.report.kind, 'export-error');
assert.equal(report.export_type, 'mp3');
assert.equal(report.report.breadcrumbs.length, 12);
assert(report.report.breadcrumbs.some(b => b.event === 'finish'));
assert.equal(Object.keys(d.headers()).length, 0);
d.feedback();
assert.equal(requests.at(-1).data.report.kind, 'feedback');
assert.equal(requests.at(-1).data.reading_id, reportId);
for (const privateValue of ['private text', 'private@example.com', 'private=query', 'privateFunction', 'tracking.example', 'third-party.example']) {
  assert(!JSON.stringify(requests.slice(-30)).includes(privateValue), privateValue);
}
assert(requests.every(r => Buffer.byteLength(r.options.body) <= 8192));

// A dead clock reports once at 90 seconds; deliberate pauses/gaps/background do not.
d.begin('premium', 'en-US-AriaNeural', 'en', () => state);
const pulse = () => { now += 15000; [...timers.values()][0](); };
count = requests.filter(r => r.data.event === 'no_progress').length;
for (let i = 0; i < 7; i++) pulse();
assert.equal(requests.filter(r => r.data.event === 'no_progress').length, count + 1);
state.loop_gap_active = true; state.phase = 'loop-gap'; state.loop_remaining_ms = 160000;
for (let i = 0; i < 8; i++) pulse();
state.loop_gap_active = false; state.phase = 'paused'; state.paused = true;
for (let i = 0; i < 8; i++) pulse();
state.paused = false; state.phase = 'playing'; ctx.document.visibilityState = 'hidden';
for (let i = 0; i < 8; i++) pulse();
assert.equal(requests.filter(r => r.data.event === 'no_progress').length, count + 1);

// Pre-Start initialization errors receive a page ID, even if the reader snapshot throws.
ctx.playbackDiagnosticState = () => { throw new Error('private snapshot failure'); };
vm.runInContext(source, ctx);
callbacks.error({ error, filename: 'https://read-aloud.com/readaloud.js', lineno: 123, colno: 45 });
assert.equal(requests.at(-1).data.source, 'page');
assert.equal(requests.at(-1).data.report.kind, 'uncaught-error');
assert.equal(Object.keys(ctx.readerDiagnostics.headers()).length, 0);
ctx.readerDiagnostics.feedback();
assert.equal(requests.at(-1).data.report.kind, 'feedback');
console.log('PASS crash locations, action history, loop state, pre-Start and post-Stop errors, feedback, no-progress detection, privacy and bounded transport');

(async () => {
  // Pending reports are bounded in memory and retry once under their original ID.
  const oldPageId = ctx.readerDiagnostics.readingId();
  await new Promise(resolve => setImmediate(resolve));
  ctx.readerDiagnostics.begin('browser', 'device', 'en', () => state);
  const newReadingId = ctx.readerDiagnostics.readingId();
  await new Promise(resolve => setImmediate(resolve));
  const before = requests.length;
  ctx.fetch = (url, options) => {
    requests.push({ url, options, data: JSON.parse(options.body) });
    return Promise.resolve({ ok: true });
  };
  callbacks.online();
  const retried = requests.slice(before).filter(r => r.data.report);
  assert(retried.length > 0 && retried.length <= 4);
  assert(retried.some(r => r.data.reading_id === oldPageId));
  assert.equal(ctx.readerDiagnostics.headers()['X-Reading-ID'], newReadingId);
  await new Promise(resolve => setImmediate(resolve));
  const retryCount = requests.filter(r => r.data.report && r.data.reading_id === oldPageId).length;
  callbacks.online();
  assert.equal(requests.filter(r => r.data.report && r.data.reading_id === oldPageId).length, retryCount);
  console.log('PASS one bounded in-memory retry preserves original report correlation');
})().catch(error => { console.error(error); process.exitCode = 1; });
