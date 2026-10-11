// Exercise the actual splitter and playback entry, with no production traffic.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert/strict');
const source = fs.readFileSync(path.join(__dirname, '..', 'readaloud.js'), 'utf8');
const start = source.indexOf('const SEGMENT_CHARS');
const end = source.indexOf('// Fetch one complete timed segment', start);
const ctx = vm.createContext({});
vm.runInContext(source.slice(start, end), ctx);

const fixtures = [
  '  The first sentence has a few words. The next one finishes here. '.repeat(30),
  ('An oversized sentence must be split without dropping a word or moving its display position ').repeat(50),
  '長い文章でも文字を飛ばさず正確な位置で読み上げます'.repeat(80),
  'a'.repeat(2000),
  'a'.repeat(399) + '\u{1F680}' + 'b'.repeat(1800),
  ('\u{1F680}\u{1D400}\u{20BB7}').repeat(700),
];
for (const voice of ['en-GB-SoniaNeural', 'vi-VN-HoaiMyNeural', 'en-US-AriaNeural', 'en-US-GuyNeural']) {
  const maxLen = ctx.segmentCharsForVoice(voice);
  for (const text of fixtures) {
    const segments = ctx.segmentTextWithOffsets(text, maxLen);
    assert.ok(segments.length > 1);
    let previousEnd = 0;
    for (const segment of segments) {
      assert.ok(segment.text.length <= maxLen, `${voice}: oversized section`);
      assert.equal(segment.text, text.slice(segment.start, segment.end));
      assert.ok(!/[\uD800-\uDBFF]$/.test(segment.text), 'No trailing half-surrogate');
      assert.ok(!/^[\uDC00-\uDFFF]/.test(segment.text), 'No leading half-surrogate');
      assert.ok(segment.start >= previousEnd);
      assert.match(text.slice(previousEnd, segment.start), /^\s*$/);
      previousEnd = segment.end;
    }
    assert.match(text.slice(previousEnd), /^\s*$/);
    assert.equal(segments.map(s => s.text.replace(/\s/g, '')).join(''), text.replace(/\s/g, ''));
  }
}
assert.equal(ctx.segmentCharsForVoice('en-US-AriaNeural'), 1200);
assert.equal(ctx.segmentCharsForVoice('en-US-GuyNeural'), 1200);
assert.equal(ctx.segmentCharsForVoice('en-GB-SoniaNeural'), 400);
assert.equal(ctx.segmentCharsForVoice('vi-VN-HoaiMyNeural'), 400);

// The player must actually use the chosen limit; downloads share these sections.
const nodes = {};
Object.assign(ctx, {
  txt: {value: fixtures[0]}, rateSlider: {value: '1'}, volSlider: {value: '1'},
  timedCache: null, lastRead: null, timed: null, isSpeaking: false, isPaused: false,
  $: id => nodes[id] || (nodes[id] = {disabled: false}),
  setStatus(){}, updateControls(){}, setupMediaSession(){}, setMediaPlaybackState(){},
  resetPlaybackClock(){}, updateExportControls(){}, loadPosition(){return 0;},
  startProgressLoop(){}, ensureTimedSegment(){return new Promise(() => {});},
});
const playerStart = source.indexOf('async function useTimedNeuralSpeech(');
const playerEnd = source.indexOf('// Play one fetched segment', playerStart);
vm.runInContext(source.slice(playerStart, playerEnd), ctx);
ctx.useTimedNeuralSpeech('en-GB-SoniaNeural');
assert.ok(ctx.timed.segments.every(s => s.text.length <= 400));
assert.equal(ctx.lastRead.segments, ctx.timed.segments);
const cached = ctx.timed.segments;
ctx.useTimedNeuralSpeech('en-GB-SoniaNeural');
assert.equal(ctx.timed.segments, cached);
ctx.useTimedNeuralSpeech('en-US-AriaNeural');
assert.ok(ctx.timed.segments.some(s => s.text.length > 400));
assert.equal(ctx.timed.voiceId, 'en-US-AriaNeural');
console.log('PASS: voice limits, full text coverage, absolute offsets, playback and export sections, and Stop/restart cache');
