/* ========== CONFIG ========== */
const CHUNK_SIZE = 900; // Character slice size
const LANGS = { en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', zh: 'Chinese', ja: 'Japanese', ko: 'Korean' };
const $ = (id) => document.getElementById(id);

// Edge TTS API endpoints, in priority order.
// Self-hosted via Cloudflare Tunnel from the mini PC. The old Render fallback
// was retired 2026-04 — leaving it here made every mid-read hiccup burn up to
// a minute of retries against a dead host before recovering.
const TTS_ENDPOINTS = [
  'https://tts.read-aloud.com',
];
let activeTtsUrl = TTS_ENDPOINTS[0];

// Billing + Studio (ElevenLabs) premium voices live only on the self-hosted mini PC,
// never on the Render fallback — so these calls always target the primary endpoint.
const BILLING_URL = TTS_ENDPOINTS[0];
const LICENSE_KEY_LS = 'ra_license_key';
let license = null;        // {key, plan, status, char_cap, char_used, char_remaining}
let studioVoices = [];     // [{id, name, labels}] — Studio voice catalog
let previewAudio = null;   // currently-playing Studio preview sample
let lastPlaybackType = ''; // 'browser' | 'neural' | 'studio' — drives the finish nudge

// One reusable <audio> element for ALL neural chunks. A fresh element per
// chunk breaks hands-free listening: once the screen locks, iOS/Android only
// allow play() on an element the user's tap originally unlocked. Reusing the
// unlocked element (plus Media Session below) keeps multi-chunk reads going
// with the phone in a pocket.
let sharedAudio = null;
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

function initSharedAudio() {
  if (sharedAudio) return;
  sharedAudio = new Audio();
  sharedAudio.preload = 'auto';
  // Unlock inside the user's gesture so later chunks may start screen-off.
  sharedAudio.src = SILENT_WAV;
  sharedAudio.play().catch(() => {});
}

// Strip every per-chunk event handler off the shared element before it's reused
// for the next chunk. Without this, a finished chunk's closures stay bound and
// fire against the next chunk's media — a stale `timeupdate` rewinds the meter,
// a stale stall-retry restarts playback — which is the skip/rewind/loop bug that
// appeared once all chunks moved onto one reused <audio> element.
function detachChunkHandlers(a) {
  if (!a) return;
  a.ontimeupdate = null;
  a.onended = null;
  a.onerror = null;
  a.onstalled = null;
  a.onwaiting = null;
  a.oncanplaythrough = null;
}

// Lock-screen / notification media controls. Without this the OS treats the
// page as a silent tab and suspends it between chunks.
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  try {
    const firstWords = txt.value.trim().split(/\s+/).slice(0, 8).join(' ');
    navigator.mediaSession.metadata = new MediaMetadata({
      title: firstWords || 'Read-Aloud',
      artist: 'Read-Aloud',
    });
    navigator.mediaSession.setActionHandler('play', resumeSpeak);
    navigator.mediaSession.setActionHandler('pause', pauseSpeak);
    navigator.mediaSession.setActionHandler('stop', stopAll);
  } catch (e) { /* MediaMetadata unsupported — fine */ }
}

function setMediaPlaybackState(state) {
  if (!('mediaSession' in navigator)) return;
  try { navigator.mediaSession.playbackState = state; } catch (e) {}
}

// Premium Neural Voices - simplified list (best voices only)
const NEURAL_VOICES = {
  en: [
    { id: 'en-US-AriaNeural', name: 'Aria (US)', gender: 'Female' },
    { id: 'en-US-GuyNeural', name: 'Guy (US)', gender: 'Male' },
    { id: 'en-GB-SoniaNeural', name: 'Sonia (UK)', gender: 'Female' },
  ],
  es: [
    { id: 'es-MX-DaliaNeural', name: 'Dalia', gender: 'Female' },
    { id: 'es-ES-AlvaroNeural', name: 'Alvaro', gender: 'Male' },
  ],
  fr: [
    { id: 'fr-FR-DeniseNeural', name: 'Denise', gender: 'Female' },
    { id: 'fr-FR-HenriNeural', name: 'Henri', gender: 'Male' },
  ],
  de: [
    { id: 'de-DE-KatjaNeural', name: 'Katja', gender: 'Female' },
    { id: 'de-DE-ConradNeural', name: 'Conrad', gender: 'Male' },
  ],
  it: [
    { id: 'it-IT-ElsaNeural', name: 'Elsa', gender: 'Female' },
    { id: 'it-IT-DiegoNeural', name: 'Diego', gender: 'Male' },
  ],
  pt: [
    { id: 'pt-BR-FranciscaNeural', name: 'Francisca', gender: 'Female' },
    { id: 'pt-BR-AntonioNeural', name: 'Antonio', gender: 'Male' },
  ],
  zh: [
    { id: 'zh-CN-XiaoxiaoNeural', name: 'Xiaoxiao', gender: 'Female' },
    { id: 'zh-CN-YunxiNeural', name: 'Yunxi', gender: 'Male' },
  ],
  ja: [
    { id: 'ja-JP-NanamiNeural', name: 'Nanami', gender: 'Female' },
    { id: 'ja-JP-KeitaNeural', name: 'Keita', gender: 'Male' },
  ],
  ko: [
    { id: 'ko-KR-SunHiNeural', name: 'SunHi', gender: 'Female' },
    { id: 'ko-KR-InJoonNeural', name: 'InJoon', gender: 'Male' },
  ],
};

/* ========== DOM ELEMENTS ========== */
const txt = $('txt');
const langSel = $('lang');
const voiceSel = $('voice');
const rateSlider = $('rate');
const rateValue = $('rv');
const volSlider = $('vol');
const volValue = $('vv');
const progressBar = $('bar');
const elapsedLabel = $('ela');
const remainingLabel = $('rem');
const meterPercent = $('meter').firstElementChild;
const startBtn = $('start');
const pauseBtn = $('pause');
const resumeBtn = $('resume');
const stopBtn = $('stop');
const disp = $('disp');
const statusEl = $('status');
const errorEl = $('error');
const wordCount = $('wordcount');

function updateWordCount() {
  if (!wordCount || !txt) return;
  const trimmed = txt.value.trim();
  const n = trimmed ? trimmed.split(/\s+/).length : 0;
  wordCount.textContent = n === 1 ? '1 word' : n + ' words';
}

/* ========== GLOBALS ========== */
let browserVoices = [];
let currentAudio = null;
let queue = [];
let utter = null;
let progChar = 0;
let totalChars = 0;
let startTime = 0;
let isSpeaking = false;
let boundarySeen = false;
let isPaused = false;
let useNeuralTTS = true; // Prefer neural voices
let apiAvailable = false;
let downloadBlobs = []; // Collect MP3 chunks for download
let keepAliveTimer = null; // Chrome speech synthesis keep-alive
let currentVoiceIndex = '-1'; // Saved so keep-alive can restart stalled browser TTS
let currentChunk = ''; // Current browser TTS chunk, saved so stall recovery can re-speak it
let currentChunkStart = 0; // Absolute char offset where current browser TTS chunk began
let chunkSpokenAt = 0;     // when the current utterance was handed to speechSynthesis
let lastBoundaryAt = 0;    // last onboundary event for the current utterance (0 = none yet)
let neuralChunkStart = 0;  // absolute char offset of the neural chunk now playing
let neuralChunkLen = 0;    // its length — progressLoop maps audio time onto these
let audioResolve = null; // Exposed resolve for playAudioBlob — lets stopAll() unblock it
let volChangeTimer = null; // Debounce for live volume changes that re-trigger browser TTS
let rateChangeTimer = null; // Debounce for live rate changes that re-trigger browser TTS
let timed = null;        // active timed-neural session (see useTimedNeuralSpeech)
let timedCache = null;   // {key, segments} — fetched audio survives Stop for instant restart
let lastPosSaveAt = 0;   // throttle for saving the reading position

/* ========== INIT ========== */
(async function init() {
  // Populate language dropdown
  Object.entries(LANGS).forEach(([code, name]) => langSel.add(new Option(name, code)));
  langSel.value = (navigator.language || 'en').slice(0, 2);

  // Event listeners
  langSel.onchange = () => populateVoiceSel();
  rateSlider.oninput = () => {
    rateValue.textContent = rateSlider.value;
    // Timed neural playback: tempo is a live playbackRate change (pitch is
    // preserved by the browser) — takes effect mid-word, no re-synthesis.
    if (timed && currentAudio) currentAudio.playbackRate = +rateSlider.value;
    // Browser TTS: utterance.rate is locked once speak() runs — restart the
    // remainder, same as the volume slider does. Debounced against dragging.
    if (isSpeaking && !isPaused && !currentAudio && !timed &&
        (speechSynthesis.speaking || speechSynthesis.pending)) {
      clearTimeout(rateChangeTimer);
      rateChangeTimer = setTimeout(restartBrowserSpeech, 250);
    }
  };
  volSlider.oninput = () => {
    volValue.textContent = Math.round(+volSlider.value * 100);
    // Neural TTS: HTMLAudioElement.volume is live-mutable.
    if (currentAudio) currentAudio.volume = +volSlider.value;
    // Browser TTS: utterance.volume is locked once speak() is called, so the only
    // way to apply a new volume mid-playback is to cancel and re-speak the
    // remainder. Debounce so dragging the slider doesn't churn restarts.
    if (isSpeaking && !isPaused && !currentAudio &&
        (speechSynthesis.speaking || speechSynthesis.pending)) {
      clearTimeout(volChangeTimer);
      volChangeTimer = setTimeout(restartBrowserSpeech, 150);
    }
  };
  // iOS/iPadOS ignore writes to HTMLMediaElement.volume (Apple reserves
  // loudness for the hardware buttons), so the slider silently does nothing
  // there. Detect it by writing and reading back, and swap the dead control
  // for an honest note.
  (function checkVolumeAdjustable() {
    const probe = document.createElement('audio');
    probe.volume = 0.5;
    if (Math.abs(probe.volume - 0.5) > 0.01) {
      const ctl = $('volControl');
      const note = $('volNote');
      if (ctl) ctl.hidden = true;
      if (note) note.hidden = false;
    }
  })();

  startBtn.onclick = startSpeak;
  pauseBtn.onclick = pauseSpeak;
  resumeBtn.onclick = resumeSpeak;
  stopBtn.onclick = stopAll;
  $('download').onclick = downloadMp3;

  // Premium / Studio voices wiring
  const upBtn = $('upgradeBtn');
  if (upBtn) upBtn.onclick = openUpgrade;
  const upClose = $('upgradeClose');
  if (upClose) upClose.onclick = closeUpgrade;
  const keyApply = $('keyApply');
  if (keyApply) keyApply.onclick = applyKey;
  const recoverToggle = $('recoverToggle');
  if (recoverToggle) recoverToggle.onclick = () => {
    const b = $('recoverBox');
    if (b) b.hidden = !b.hidden;
  };
  const recoverBtn = $('recoverBtn');
  if (recoverBtn) recoverBtn.onclick = recoverKey;
  const previewBtn = $('previewBtn');
  if (previewBtn) previewBtn.onclick = togglePreview;
  const modalSampleBtn = $('modalSampleBtn');
  if (modalSampleBtn) modalSampleBtn.onclick = togglePreview;

  // Manual scrolling in the reading pane pauses highlight auto-follow briefly.
  ['wheel', 'touchmove'].forEach((ev) =>
    disp.addEventListener(ev, () => { userScrolledAt = Date.now(); }, { passive: true }));

  // Click any word to jump the reading there (timed neural playback only —
  // word timestamps make the seek exact).
  disp.addEventListener('click', (e) => {
    const span = e.target && e.target.closest ? e.target.closest('#disp > span') : null;
    if (!span || span.dataset.off == null) return;
    seekToChar(+span.dataset.off);
  });

  // The progress bar is a scrubber during timed playback.
  progressBar.addEventListener('click', (e) => {
    if (!totalChars) return;
    const r = progressBar.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    seekToChar(Math.floor(frac * totalChars));
  });
  const modal = $('upgradeModal');
  if (modal) modal.addEventListener('click', (e) => {
    if (e.target === modal) closeUpgrade();
  });

  txt.addEventListener('input', () => {
    // Editing the text mid-read desyncs every offset the player relies on —
    // stop cleanly instead of highlighting the wrong words.
    if (isSpeaking) stopAll();
    clearError();
    buildDisplay();
    updateWordCount();
  });
  updateWordCount();
  window.addEventListener('resize', autoSize);
  window.addEventListener('keydown', handleShortcuts);

  // Load browser voices, then show premium voices optimistically while
  // the API check runs in the background. Render free tier can take 30-60s
  // to cold-start, so we don't block the UI waiting for it.
  setStatus('Loading voices...');
  await loadBrowserVoices();
  apiAvailable = true; // optimistic — removed if background check fails
  populateVoiceSel();

  buildDisplay();
  autoSize();
  updateControls();
  setStatus('Ready');

  // Background check — hide premium voices only if API is confirmed down
  checkApiAvailability().then(available => {
    if (!available) {
      apiAvailable = false;
      populateVoiceSel();
    }
  });

  // Load the Studio voice catalog (for previews) and validate any stored license
  // in the background, then repopulate so Studio voices + the right default appear.
  // Never blocks the free tool.
  Promise.all([loadLicense(), loadStudioVoices()]).then(() => populateVoiceSel());
})();

/* ========== API CHECK ========== */
// Probes endpoints in priority order; sets activeTtsUrl to the first reachable one.
async function checkApiAvailability() {
  for (const url of TTS_ENDPOINTS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000 * attempt);
        const response = await fetch(`${url}/`, {
          method: 'GET',
          signal: controller.signal
        });
        clearTimeout(timeout);
        if (response.ok) {
          if (activeTtsUrl !== url) {
            console.log(`Active TTS endpoint: ${url}`);
          }
          activeTtsUrl = url;
          console.log('Premium neural voices available');
          return true;
        }
      } catch (e) {
        console.warn(`API check ${url} attempt ${attempt} failed:`, e.message);
        if (attempt < 2) await new Promise(r => setTimeout(r, 500));
      }
    }
  }
  console.warn('All TTS endpoints unreachable - using browser voices only');
  return false;
}

// Re-check API availability every 5 minutes to catch outages and recoveries
setInterval(async () => {
  const available = await checkApiAvailability();
  if (available !== apiAvailable) {
    apiAvailable = available;
    populateVoiceSel();
    console.log(available ? 'Premium voices now available!' : 'Premium voices went offline.');
  }
}, 5 * 60 * 1000);

/* ========== VOICE LOADING ========== */
async function loadBrowserVoices() {
  browserVoices = speechSynthesis.getVoices();
  if (browserVoices.length) return;

  // Kick iOS with a silent utterance
  await new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    u.onend = resolve;
    u.onerror = resolve;
    speechSynthesis.speak(u);
  });

  // Wait for voiceschanged event
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 2000);
    speechSynthesis.onvoiceschanged = () => {
      clearTimeout(timeout);
      browserVoices = speechSynthesis.getVoices();
      resolve();
    };
  });
}

function populateVoiceSel() {
  const lang = langSel.value;
  const prevPick = voiceSel.value; // restore below if it survives the rebuild
  voiceSel.innerHTML = '';

  // Studio voices — shown to everyone so they can preview before subscribing.
  // The model is multilingual, so all studio voices are offered regardless of language.
  const studioLicensed = license && license.status === 'active';
  if (studioVoices.length) {
    const studioGroup = document.createElement('optgroup');
    studioGroup.label = studioLicensed ? 'Studio Voices' : '— Studio voices (optional upgrade) —';
    studioVoices.forEach(v => {
      const opt = document.createElement('option');
      opt.value = `studio:${v.id}`;
      // Show just the clean first name — strip provider descriptors like
      // "Roger - Laid-Back, Casual, Resonant".
      opt.textContent = (v.name || '').split(' - ')[0].trim() || v.name;
      studioGroup.appendChild(opt);
    });
    voiceSel.appendChild(studioGroup);
  }

  // Add neural voices first (if API available)
  const neuralVoices = NEURAL_VOICES[lang] || NEURAL_VOICES['en'];

  if (apiAvailable && neuralVoices.length) {
    const neuralGroup = document.createElement('optgroup');
    neuralGroup.label = 'Premium Voices';

    neuralVoices.forEach(v => {
      const opt = document.createElement('option');
      opt.value = `neural:${v.id}`;
      opt.textContent = `${v.name} - ${v.gender}`;
      neuralGroup.appendChild(opt);
    });

    voiceSel.appendChild(neuralGroup);
  }

  // Add browser voices - always available as fallback (limit to 5)
  const browserGroup = document.createElement('optgroup');
  browserGroup.label = apiAvailable ? 'Browser (Offline)' : 'Browser Voices';

  const defaultOpt = document.createElement('option');
  defaultOpt.value = 'browser:-1';
  defaultOpt.textContent = 'Default Voice';
  browserGroup.appendChild(defaultOpt);

  // Filter browser voices by language and limit to 5
  const langVoices = browserVoices.filter(v => v.lang.startsWith(lang)).slice(0, 5);

  langVoices.forEach((v) => {
    const opt = document.createElement('option');
    const realIndex = browserVoices.indexOf(v);
    opt.value = `browser:${realIndex}`;
    opt.textContent = v.name.replace(/Microsoft |Google /, '');  // Shorten names
    browserGroup.appendChild(opt);
  });

  voiceSel.appendChild(browserGroup);

  // Keep the user's explicit pick when this rebuild was a background refresh
  // (5-min health probe, license/studio catalog load) — those used to yank the
  // selection back to the default mid-session.
  if (prevPick && [...voiceSel.options].some(o => o.value === prevPick)) {
    voiceSel.value = prevPick;
    updateVoiceStatus();
    return;
  }

  // Default selection: Studio voices first when a license is active (the user is
  // paying for them, so make them the default), then premium Edge, then browser.
  if (studioLicensed && studioVoices.length) {
    voiceSel.value = `studio:${studioVoices[0].id}`;
  } else if (apiAvailable && neuralVoices.length) {
    voiceSel.value = `neural:${neuralVoices[0].id}`;
  } else {
    voiceSel.value = 'browser:-1';
  }

  // Update status to show voice type
  updateVoiceStatus();
}

function updateVoiceStatus() {
  const [voiceType] = voiceSel.value.split(':');
  // The "Hear a sample" button is available whenever Studio voices exist — it
  // previews the selected Studio voice, or a default one if the pick isn't Studio.
  const pv = $('previewBtn');
  if (pv) {
    pv.hidden = !studioVoices.length;
    if (!previewAudio || previewAudio.paused) pv.textContent = previewBtnLabel();
  }
  const indicator = document.getElementById('voice-type-indicator');
  if (indicator) {
    if (voiceType === 'neural') {
      indicator.textContent = 'Premium';
      indicator.className = 'voice-indicator voice-indicator--premium';
    } else {
      indicator.textContent = 'Browser';
      indicator.className = 'voice-indicator voice-indicator--browser';
    }
  }
}

// Update indicator when voice changes; track Studio voice selections.
if (voiceSel) {
  voiceSel.addEventListener('change', () => {
    updateVoiceStatus();
    if (voiceSel.value.startsWith('studio:')) trackEvent('studio_select');
  });
}

/* ========== START SPEAK ========== */
function startSpeak() {
  if (isSpeaking) return;
  if (!txt.value.trim()) {
    showError('Please type or paste some text first.');
    setStatus('Ready');
    return;
  }
  clearError();
  initSharedAudio(); // unlock the shared element while we're in the tap's call stack
  const sn = $('studioNudge');
  if (sn) sn.hidden = true;
  isSpeaking = true;
  startBtn.disabled = true;

  const [voiceType, voiceId] = voiceSel.value.split(':');
  lastPlaybackType = voiceType;

  if (voiceType === 'studio') {
    if (!(license && license.status === 'active')) {
      // Unlicensed: don't ambush with the pricing modal. Play the free cached
      // sample of the selected Studio voice and show an inline nudge instead.
      isSpeaking = false;
      updateControls();
      setStatus('Ready');
      playSample();
      showStudioNudge('sample');
      return;
    }
    useStudioSpeech(voiceId);
  } else if (voiceType === 'neural' && apiAvailable) {
    useTimedNeuralSpeech(voiceId);
  } else {
    useBrowserSpeech(voiceId);
  }
}

/* ========== TIMED NEURAL TTS (word-accurate playback) ========== */
// The /api/tts/timed endpoint returns, per segment, the MP3 audio plus a
// [time, char_offset] anchor for every spoken word. Those anchors drive the
// highlight (exact, not estimated), make every word clickable (seek), and
// let the tempo slider work live via playbackRate — audio is always
// synthesized at natural speed, so one cached synthesis serves every speed.

const SEGMENT_CHARS = 1200;         // ~75-90s of audio each; first sound in ~2-3s
const POSITION_LS_PREFIX = 'ra_pos_';

function hashText(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + '_' + s.length;
}

// Split into sentence-grouped segments PRESERVING absolute char offsets.
// Unlike the legacy chunkText(), nothing is trimmed away invisibly: each
// segment records exactly which [start, end) slice of the textarea it speaks,
// so a server word anchor (relative) + seg.start = exact display position.
function segmentTextWithOffsets(text, maxLen) {
  const out = [];
  const re = /[^.!?]+[.!?]+[\s]*|[^.!?]+$/g;
  let segStart = -1, segEnd = -1;
  let m;

  const push = (s, e) => {
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (e > s) out.push({ text: text.slice(s, e), start: s, end: e,
                          words: null, blob: null, fetching: null });
  };
  const addPiece = (ps, pe) => {
    if (segStart === -1) { segStart = ps; segEnd = pe; return; }
    if (pe - segStart > maxLen) { push(segStart, segEnd); segStart = ps; }
    segEnd = pe;
  };

  while ((m = re.exec(text)) !== null) {
    const ps = m.index, pe = m.index + m[0].length;
    if (pe - ps <= maxLen) { addPiece(ps, pe); continue; }
    // Oversized sentence: split at whitespace, or hard-cut when there is
    // none (CJK, long URLs) — offsets stay exact either way.
    let cur = ps;
    while (pe - cur > maxLen) {
      let cut = text.lastIndexOf(' ', cur + maxLen);
      if (cut <= cur) cut = cur + maxLen;
      addPiece(cur, cut);
      cur = cut;
    }
    if (cur < pe) addPiece(cur, pe);
  }
  if (segStart !== -1) push(segStart, segEnd);
  return out;
}

// Fetch one timed segment: audio (base64 MP3) + word anchors. Throws with
// .legacy=true on 404 so the caller can fall back to the old endpoint while
// a fresh server deploy is still rolling out.
async function fetchTimedSegment(seg, voiceId, label) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await new Promise(r => setTimeout(r, 800 * attempt));
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 45000);
      const r = await fetch(`${activeTtsUrl}/api/tts/timed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: seg.text, voice: voiceId }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (r.status === 404) {
        const e = new Error('timed endpoint unavailable');
        e.legacy = true;
        throw e;
      }
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.detail || `API error ${r.status}`);
      }
      const d = await r.json();
      const bin = atob(d.audio || '');
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      if (bytes.length < 100) throw new Error('audio too small');
      seg.blob = new Blob([bytes], { type: 'audio/mpeg' });
      seg.words = (d.words || []).map(w => [w[0] / 1000, w[1] + seg.start]);
      console.log(`Timed segment ${label}: ${bytes.length} bytes, ${seg.words.length} word anchors`);
      return seg;
    } catch (e) {
      if (e.legacy) throw e;
      lastErr = e;
      console.warn(`Timed segment ${label} attempt ${attempt} failed:`, e.message);
    }
  }
  throw lastErr || new Error('segment fetch failed');
}

function segIndexForChar(ch) {
  if (!timed) return -1;
  const segs = timed.segments;
  for (let i = 0; i < segs.length; i++) {
    if (ch < segs[i].end) return i;
  }
  return segs.length - 1;
}

// Audio time (seconds, natural rate) of the last word starting at or before ch.
function wordTimeForChar(seg, ch) {
  if (!seg.words || !seg.words.length) return 0;
  let t = 0;
  for (const w of seg.words) {
    if (w[1] <= ch) t = w[0]; else break;
  }
  return Math.max(0, t - 0.05);
}

// Jump the reading to a character position (word click / scrubber / resume).
function seekToChar(ch) {
  if (!timed || !isSpeaking) return;
  ch = Math.max(0, Math.min(totalChars - 1, ch));
  const idx = segIndexForChar(ch);
  if (idx === -1) return;
  progChar = ch;
  updateMeter(progChar); // instant visual feedback even while audio catches up
  const seg = timed.segments[idx];
  if (idx === timed.i && timed.curSeg === seg && currentAudio) {
    // Same segment: direct seek. Works paused too — stays paused at the new spot.
    try { currentAudio.currentTime = wordTimeForChar(seg, ch); } catch (e) {}
    return;
  }
  timed.seekChar = ch;
  if (audioResolve) audioResolve(); // abandon the current segment's playback
}

function savePosition(key, ch) {
  try { localStorage.setItem(key, JSON.stringify({ c: Math.floor(ch), t: Date.now() })); } catch (e) {}
}
function loadPosition(key) {
  try {
    const d = JSON.parse(localStorage.getItem(key) || 'null');
    if (!d) return 0;
    if (Date.now() - d.t > 30 * 86400000) { localStorage.removeItem(key); return 0; }
    return d.c || 0;
  } catch (e) { return 0; }
}
function clearPosition(key) {
  try { localStorage.removeItem(key); } catch (e) {}
}

async function useTimedNeuralSpeech(voiceId) {
  setStatus('Loading audio...');
  isSpeaking = true;
  isPaused = false;
  downloadBlobs = [];
  $('download').disabled = true;
  updateControls();
  setupMediaSession();
  setMediaPlaybackState('playing');

  const text = txt.value;
  totalChars = text.length;
  progChar = 0;
  startTime = Date.now();

  const key = hashText(text) + '|' + voiceId;
  let segments;
  if (timedCache && timedCache.key === key) {
    segments = timedCache.segments; // reuse already-fetched audio after a Stop
  } else {
    segments = segmentTextWithOffsets(text, SEGMENT_CHARS);
    timedCache = { key, segments };
  }
  if (!segments.length) { finish(); return; }

  timed = {
    voiceId, segments, i: 0, seekChar: null, curSeg: null,
    posKey: POSITION_LS_PREFIX + hashText(text),
  };

  // Resume where the reader left off, unless they were nearly done.
  const saved = loadPosition(timed.posKey);
  if (saved > 200 && saved < totalChars * 0.9) {
    timed.seekChar = saved;
    setStatus('Resuming where you left off — click the first word to start over.');
  }

  startProgressLoop();

  try {
    while (isSpeaking && timed) {
      // A requested jump (word click / scrubber / resume) picks the segment.
      if (timed.seekChar != null) {
        const idx = segIndexForChar(timed.seekChar);
        if (idx === -1) timed.seekChar = null; else timed.i = idx;
      }
      if (timed.i >= segments.length) break;

      // Respect Pause across segment boundaries (the old player didn't:
      // pausing in a gap let the next chunk start playing over "Paused").
      while (isPaused && isSpeaking && timed) {
        await new Promise(r => setTimeout(r, 150));
      }
      if (!isSpeaking || !timed) break;

      const seg = segments[timed.i];
      if (!seg.blob) {
        setStatus(`Loading part ${timed.i + 1} of ${segments.length}...`);
        try {
          await (seg.fetching || fetchTimedSegment(seg, voiceId, `${timed.i + 1}/${segments.length}`));
        } catch (e) {
          if (e.legacy) { // server not updated yet — old chunked path still works
            timed = null;
            useNeuralSpeechLegacy(voiceId);
            return;
          }
          throw e;
        } finally {
          seg.fetching = null;
        }
        if (!isSpeaking || !timed) break;
      }

      // Prefetch the next un-fetched segment while this one plays.
      const nxt = segments[timed.i + 1];
      if (nxt && !nxt.blob && !nxt.fetching) {
        nxt.fetching = fetchTimedSegment(nxt, voiceId, `${timed.i + 2}/${segments.length}`)
          .catch(() => { nxt.fetching = null; }); // errors re-surface on demand
      }

      // A seek that arrived during the fetch may point at a different segment.
      if (timed.seekChar != null && segIndexForChar(timed.seekChar) !== timed.i) continue;

      let startAt = 0;
      if (timed.seekChar != null) {
        startAt = wordTimeForChar(seg, timed.seekChar);
        timed.seekChar = null;
      }

      setStatus(segments.length > 1 ? `Playing (${timed.i + 1}/${segments.length})...` : 'Playing...');
      await playTimedSegment(seg, startAt);
      if (!isSpeaking || !timed) break;
      if (timed.seekChar != null) continue; // a click interrupted playback — re-route
      timed.i++;
    }

    if (isSpeaking && timed) {
      clearPosition(timed.posKey);
      downloadBlobs = segments.map(s => s.blob).filter(Boolean);
      const complete = segments.every(s => s.blob);
      timed = null;
      finish();
      $('download').disabled = !complete || !downloadBlobs.length;
    }
  } catch (error) {
    console.error('Timed TTS error:', error);
    if (currentAudio) {
      try { currentAudio.pause(); } catch (e) {}
      currentAudio = null;
    }
    if (timed) savePosition(timed.posKey, progChar);
    timed = null;
    if (!isSpeaking) return; // the user pressed Stop during the failure
    // Keep the reader's place: continue with a browser voice FROM HERE —
    // the old player restarted the whole text from the top.
    showError(`Premium voice error: ${error.message}. Continuing with a browser voice.`);
    setTimeout(clearError, 4000);
    useBrowserSpeech('-1', Math.floor(progChar));
  }
}

// Play one fetched segment on the shared (gesture-unlocked) element.
function playTimedSegment(seg, startAtSec) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(seg.blob);
    const audio = sharedAudio || (sharedAudio = new Audio());
    detachChunkHandlers(audio);
    try { audio.pause(); } catch (e) { /* pausing an idle element is a no-op */ }
    audio.loop = false; // may still be set from the silent keep-alive loop
    audio.src = url;
    audio.volume = +volSlider.value;
    try { audio.preservesPitch = true; } catch (e) {}
    audio.playbackRate = +rateSlider.value; // live tempo; audio is natural-rate
    currentAudio = audio;
    timed.curSeg = seg;

    let done = false;
    let lastT = -1;
    let lastAdvanceAt = Date.now();

    function settle(fn, arg) {
      if (done) return;
      done = true;
      clearInterval(watchdog);
      audioResolve = null;
      detachChunkHandlers(audio);
      URL.revokeObjectURL(url);
      if (currentAudio === audio) currentAudio = null;
      if (timed && timed.curSeg === seg) timed.curSeg = null;
      fn(arg);
    }

    // Stuck-playback watchdog: fires only when audio SHOULD be advancing but
    // isn't. Unlike the old flat 5-minute timer, a long user pause never
    // trips it (that timer silently un-paused and skipped ahead).
    const watchdog = setInterval(() => {
      if (done) return;
      if (isPaused || audio.paused || audio.ended) { lastAdvanceAt = Date.now(); return; }
      if (audio.currentTime !== lastT) {
        lastT = audio.currentTime;
        lastAdvanceAt = Date.now();
        return;
      }
      if (Date.now() - lastAdvanceAt > 45000) {
        console.warn('playTimedSegment: no progress for 45s — advancing');
        settle(resolve);
      }
    }, 5000);

    audioResolve = () => settle(resolve); // stopAll()/seek unblock instantly

    audio.onended = () => settle(resolve);
    audio.onerror = () => {
      const code = audio.error ? audio.error.code : 'unknown';
      settle(reject, new Error('Audio error (code ' + code + ')'));
    };

    // Screen-lock resume nudge — same rules as the legacy player.
    let lastRetryAt = 0;
    const retryPlay = () => {
      if (done || isPaused) return;
      if (audio.src !== url) return;
      if (!audio.paused || audio.ended) return;
      const now = Date.now();
      if (now - lastRetryAt < 1000) return;
      lastRetryAt = now;
      console.warn('Audio suspended mid-clip, resuming play...');
      audio.play().catch(() => {});
    };
    audio.onstalled = retryPlay;
    audio.onwaiting = retryPlay;

    if (startAtSec > 0) {
      try { audio.currentTime = startAtSec; } catch (e) {}
    }
    audio.play().then(() => {
      // If the seek was requested before metadata loaded, apply it now.
      if (startAtSec > 0 && Math.abs(audio.currentTime - startAtSec) > 1) {
        try { audio.currentTime = startAtSec; } catch (e) {}
      }
    }).catch((err) => {
      settle(reject, new Error('play() rejected: ' + err.message));
    });
  });
}

/* ========== NEURAL TTS (Edge TTS API) ========== */

// Fetch a single chunk with retry/backoff. Tries activeTtsUrl twice, then any other
// configured endpoint twice. Updates activeTtsUrl when fallback succeeds so the next
// chunk goes straight to the working URL. Returns an audio Blob or throws.
async function fetchChunkWithRetry(text, voiceId, chunkIndex) {
  const urlOrder = [activeTtsUrl, ...TTS_ENDPOINTS.filter(u => u !== activeTtsUrl)];
  let lastErr;
  for (const url of urlOrder) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attempt > 1) await new Promise(r => setTimeout(r, 1000 * attempt));
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        console.log(`Fetching TTS chunk ${chunkIndex + 1} via ${url} (attempt ${attempt})`);
        const response = await fetch(`${url}/api/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            voice: voiceId,
            rate: rateToApiFormat(+rateSlider.value),
            pitch: '+0Hz'
          }),
          signal: controller.signal
        });
        clearTimeout(timeout);
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw new Error(error.detail || `API error: ${response.status}`);
        }
        const blob = await response.blob();
        if (blob.size < 100) throw new Error('Audio blob too small');
        if (activeTtsUrl !== url) {
          console.log(`Switched active TTS endpoint to ${url}`);
          activeTtsUrl = url;
        }
        console.log(`Got audio blob for chunk ${chunkIndex + 1}, size: ${blob.size}`);
        return blob;
      } catch (e) {
        lastErr = e;
        console.warn(`Chunk ${chunkIndex + 1} via ${url} attempt ${attempt} failed:`, e.message);
      }
    }
  }
  throw lastErr || new Error(`All TTS endpoints failed for chunk ${chunkIndex + 1}`);
}

// Legacy chunked player — only used if /api/tts/timed 404s (server mid-deploy).
async function useNeuralSpeechLegacy(voiceId) {
  setStatus('Loading audio...');
  isSpeaking = true;
  isPaused = false;
  downloadBlobs = [];
  $('download').disabled = true;
  updateControls();
  setupMediaSession();
  setMediaPlaybackState('playing');
  startProgressLoop();

  const chunks = chunkText(txt.value, 1500); // ~3s TTFB vs ~9s at 4500; pipelined
  progChar = 0;
  startTime = Date.now();
  totalChars = txt.value.length;

  const MAX_ERRORS = 3;
  let consecutiveErrors = 0;

  console.log(`Neural TTS: ${chunks.length} chunks, sizes: [${chunks.map(c => c.length)}], voice: ${voiceId}`);

  // Kick off the first fetch immediately so audio starts as fast as possible.
  // Each subsequent fetch starts as soon as the previous chunk begins playing,
  // so the next blob is ready (or nearly ready) when the current one finishes.
  let nextFetch = fetchChunkWithRetry(chunks[0], voiceId, 0);

  try {
    for (let i = 0; i < chunks.length; i++) {
      if (!isSpeaking) break;

      // Await the pre-fetched blob for this chunk
      let audioBlob;
      try {
        setStatus(`Loading chunk ${i + 1}/${chunks.length}...`);
        audioBlob = await nextFetch;
        console.log(`Chunk ${i + 1} fetched: ${audioBlob.size} bytes`);
      } catch (fetchError) {
        console.error(`Chunk ${i + 1} fetch failed:`, fetchError.message);
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_ERRORS) {
          throw new Error(`Fetch failed: ${fetchError.message}`);
        }
        progChar += chunks[i].length;
        showError(`Chunk ${i + 1} skipped (${fetchError.message})`);
        if (i + 1 < chunks.length) {
          nextFetch = fetchChunkWithRetry(chunks[i + 1], voiceId, i + 1);
        }
        await new Promise(r => setTimeout(r, 500));
        clearError();
        continue;
      }

      // Start fetching the next chunk while this one plays
      if (i + 1 < chunks.length) {
        nextFetch = fetchChunkWithRetry(chunks[i + 1], voiceId, i + 1);
      }

      downloadBlobs.push(audioBlob);
      setStatus(chunks.length > 1 ? `Playing (${i + 1}/${chunks.length})...` : 'Playing...');

      try {
        await playAudioBlob(audioBlob, chunks[i].length);
        consecutiveErrors = 0;
      } catch (playError) {
        console.error(`Chunk ${i + 1} playback failed:`, playError.message);
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_ERRORS) {
          throw new Error(`Playback failed: ${playError.message}`);
        }
        showError(`Chunk ${i + 1}: ${playError.message}`);
        await new Promise(r => setTimeout(r, 500));
        clearError();
      }

      progChar += chunks[i].length;
    }

    if (isSpeaking) finish();

  } catch (error) {
    console.error('Neural TTS error:', error);

    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }

    setStatus('Switching to browser voice...');
    showError(`Premium voice error: ${error.message}. Using browser voice.`);
    await new Promise(r => setTimeout(r, 2000));
    clearError();

    // The user may have pressed Stop during the 2s "switching" delay above —
    // stopAll() flips isSpeaking false. Don't start an orphaned browser read
    // over a read they explicitly stopped. Guard on isSpeaking ONLY (not
    // isPaused: a pause during the window should still get the fallback).
    if (!isSpeaking) return;

    // Continue from where the premium read died, not from the top.
    useBrowserSpeech('-1', Math.floor(progChar));
  }
}

function playAudioBlob(blob, chunkLength) {
  return new Promise((resolve, reject) => {
    console.log('playAudioBlob: size:', blob.size, 'type:', blob.type);
    if (blob.size < 100) {
      reject(new Error('Audio blob too small (' + blob.size + ' bytes)'));
      return;
    }
    const url = URL.createObjectURL(blob);
    // Reuse the gesture-unlocked element so chunk N+1 may start screen-off.
    // Quiesce it BEFORE the src swap: pause it and strip the previous chunk's
    // handlers, so no leftover timeupdate/stall-retry from the finished chunk
    // fires against this one (that bleed-through is the skip/rewind/loop bug).
    // Keep the SAME element object — that's what preserves the iOS/Android
    // gesture unlock that lets play() run with the screen locked.
    const audio = sharedAudio || (sharedAudio = new Audio());
    detachChunkHandlers(audio);
    try { audio.pause(); } catch (e) { /* pausing an idle element is a no-op */ }
    audio.loop = false; // may still be set from the silent keep-alive loop
    audio.src = url; // assigning a new src resets currentTime to 0 for this chunk
    audio.volume = +volSlider.value;
    currentAudio = audio;

    const chunkStart = progChar;
    neuralChunkStart = chunkStart;
    neuralChunkLen = chunkLength;
    let done = false;

    function cleanup() {
      clearTimeout(safetyTimer);
      // Detach this chunk's handlers immediately so a late stall/waiting/error
      // event (e.g. from the about-to-be-revoked blob URL) can't fire a retry
      // or rewind the meter after we've already resolved.
      detachChunkHandlers(audio);
      URL.revokeObjectURL(url);
      if (currentAudio === audio) currentAudio = null;
    }

    // Safety timeout: if onended never fires (browser bug), resolve after
    // estimated duration + generous buffer so the queue doesn't hang forever.
    const safetyTimer = setTimeout(() => {
      if (done) return;
      console.warn('playAudioBlob: safety timeout — onended never fired, resolving');
      done = true;
      audioResolve = null;
      cleanup();
      resolve();
    }, 5 * 60 * 1000); // 5 minutes max per chunk

    // Expose resolve so stopAll() can unblock this promise immediately
    audioResolve = () => {
      if (done) return;
      done = true;
      audioResolve = null;
      cleanup();
      resolve();
    };

    audio.ontimeupdate = () => {
      if (audio.duration) {
        const chunkProgress = audio.currentTime / audio.duration;
        const currentChar = chunkStart + Math.floor(chunkProgress * chunkLength);
        updateMeter(currentChar);
      }
    };

    audio.onended = () => {
      if (done) return;
      done = true;
      audioResolve = null;
      cleanup();
      resolve();
    };

    audio.onerror = () => {
      if (done) return;
      done = true;
      audioResolve = null;
      const code = audio.error ? audio.error.code : 'unknown';
      const msg = audio.error ? audio.error.message : '';
      console.error('playAudioBlob error: code=' + code, msg);
      cleanup();
      reject(new Error('Audio error (code ' + code + '): ' + (msg || 'playback failed')));
    };

    // The chunk's MP3 is already fully in memory (we awaited the whole blob),
    // so a `waiting`/`stalled` here is a transient decode hiccup or an OS
    // suspend on screen-lock — never a download stall. Only nudge play() when
    // the element has genuinely fallen paused mid-clip (the screen-lock resume
    // case f453e7d added); skip it during normal buffering, across a chunk
    // boundary, or once finished — calling play() then is what produced the
    // skip/rewind storm. Debounced so it can't hammer on a throttled tab.
    let lastRetryAt = 0;
    const retryPlay = () => {
      if (done || isPaused) return;
      if (audio.src !== url) return;             // the next chunk already took the element
      if (!audio.paused || audio.ended) return;  // still playing or finished — leave it alone
      const now = Date.now();
      if (now - lastRetryAt < 1000) return;      // at most ~1 resume nudge per second
      lastRetryAt = now;
      console.warn('Audio suspended mid-clip, resuming play...');
      audio.play().catch(() => {}); // silent — onerror handles a real failure
    };
    audio.onstalled = retryPlay;
    audio.onwaiting = retryPlay;

    audio.playbackRate = 1; // Rate is handled by API
    audio.oncanplaythrough = () => {
      console.log('playAudioBlob: canplaythrough, duration:', audio.duration);
    };
    audio.play().catch((err) => {
      if (done) return;
      done = true;
      audioResolve = null;
      cleanup();
      reject(new Error('play() rejected: ' + err.message));
    });
  });
}

function chunkText(text, maxLength) {
  const chunks = [];
  const sentences = text.match(/[^.!?]+[.!?]+[\s]*/g) || [];

  // Capture trailing text that doesn't end in .!? (the regex silently drops it)
  const matchedLen = sentences.reduce((sum, s) => sum + s.length, 0);
  if (matchedLen < text.length) {
    const remainder = text.slice(matchedLen);
    if (remainder.trim()) sentences.push(remainder);
  }

  // Fallback: if no sentences found at all, hard-split at word boundaries
  if (!sentences.length) {
    let remaining = text;
    while (remaining.length > maxLength) {
      let splitIdx = remaining.lastIndexOf(' ', maxLength);
      if (splitIdx <= 0) splitIdx = maxLength;
      chunks.push(remaining.slice(0, splitIdx).trim());
      remaining = remaining.slice(splitIdx).trim();
    }
    if (remaining.trim()) chunks.push(remaining.trim());
    return chunks;
  }

  let currentChunk = '';
  for (const sentence of sentences) {
    // If a single sentence exceeds maxLength, split it at word boundaries
    if (sentence.length > maxLength) {
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }
      let remaining = sentence;
      while (remaining.length > maxLength) {
        let splitIdx = remaining.lastIndexOf(' ', maxLength);
        if (splitIdx <= 0) splitIdx = maxLength;
        chunks.push(remaining.slice(0, splitIdx).trim());
        remaining = remaining.slice(splitIdx).trim();
      }
      if (remaining.trim()) currentChunk = remaining;
      continue;
    }

    if ((currentChunk + sentence).length > maxLength && currentChunk) {
      chunks.push(currentChunk.trim());
      currentChunk = sentence;
    } else {
      currentChunk += sentence;
    }
  }
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

function rateToApiFormat(rate) {
  const percent = Math.round((rate - 1) * 100);
  return percent >= 0 ? `+${percent}%` : `${percent}%`;
}

/* ========== BROWSER TTS (Web Speech API) ========== */
// Split into <=CHUNK_SIZE pieces at whitespace when possible, hard cuts when
// not. The old single regex ([\s\S]{1,N}(?:\s|$)) silently DROPPED any run of
// more than N chars with no whitespace — Chinese/Japanese text lost everything
// but its tail.
function chunkForSpeech(text) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + CHUNK_SIZE, text.length);
    if (end < text.length) {
      const lastWs = text.lastIndexOf(' ', end);
      if (lastWs > i) end = lastWs + 1;
    }
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

function useBrowserSpeech(voiceIndex, fromChar = 0) {
  currentVoiceIndex = voiceIndex;
  fromChar = Math.max(0, Math.min(fromChar || 0, txt.value.length));
  queue = chunkForSpeech(txt.value.slice(fromChar));
  progChar = fromChar;
  startTime = Date.now();
  boundarySeen = false;
  isSpeaking = true;
  isPaused = false;
  setStatus('Playing...');
  updateControls();
  setupMediaSession();
  setMediaPlaybackState('playing');
  startSilentKeepAlive();
  startKeepAlive();
  speakNextChunk(voiceIndex);
  startProgressLoop();
}

// speechSynthesis does NOT mark a tab as "playing audio", so after ~5 minutes
// backgrounded Chrome throttles our timers to ~1/minute and the keep-alive
// below can no longer outrun the engine's ~15s kill. Looping the silent WAV
// on the shared element keeps the tab classed as audible and unthrottled for
// the whole read. (Premium reads are exempt naturally — real audio plays.)
function startSilentKeepAlive() {
  if (!sharedAudio) return;
  try {
    sharedAudio.src = SILENT_WAV;
    sharedAudio.loop = true;
    sharedAudio.volume = 0.01;
    sharedAudio.play().catch(() => {});
  } catch (e) {}
}

function stopSilentKeepAlive() {
  if (!sharedAudio) return;
  try {
    sharedAudio.loop = false;
    if (sharedAudio.src === SILENT_WAV) sharedAudio.pause();
  } catch (e) {}
}

// Chrome kills speechSynthesis after ~15s of continuous speech.
// Periodically pause/resume to keep it alive, and detect silent deaths.
function startKeepAlive() {
  stopKeepAlive();
  keepAliveTimer = setInterval(() => {
    if (!isSpeaking || isPaused) return;

    if (speechSynthesis.speaking) {
      // Standard Chrome keep-alive: pause/resume resets the 15s timer
      speechSynthesis.pause();
      speechSynthesis.resume();

      // Android Chrome's engine can die with `speaking` stuck true — the
      // recovery branch below never fires and playback stops silently.
      // Detect the zombie by lack of progress and re-speak the chunk.
      const now = Date.now();
      const expectedMs = currentChunk
        ? (currentChunk.length / (15 * (+rateSlider.value || 1))) * 1000 : 0;
      const zombie = lastBoundaryAt
        ? now - lastBoundaryAt > 15000               // boundaries flowed, then stopped
        : now - chunkSpokenAt > Math.max(20000, expectedMs * 2.5); // platform fires no boundaries
      if (zombie && currentChunk) {
        console.warn('Speech engine zombie (speaking stuck true) — re-speaking current chunk');
        if (utter) utter.onend = null; // keep cancel() from chaining into speakNextChunk
        speechSynthesis.cancel();
        queue.unshift(currentChunk);
        // Roll the pointer back to the chunk start we're about to re-speak.
        // Without this every recovery inflated progChar by the already-spoken
        // portion, walking the bar and highlight far ahead of the voice.
        progChar = currentChunkStart;
        currentChunk = '';
        setTimeout(() => speakNextChunk(currentVoiceIndex), 100);
      }
    } else if (!speechSynthesis.pending) {
      // Chrome silently killed speech — nothing is speaking or queued.
      // Neutralize the dead utterance's onend first so it can't also fire and
      // advance the queue a second time (mirrors the zombie branch above), then
      // re-speak. Put the current (interrupted) chunk back at the front.
      if (utter) utter.onend = null;
      if (currentChunk) {
        console.warn('Speech synthesis stalled, re-speaking current chunk...');
        queue.unshift(currentChunk);
        progChar = currentChunkStart; // same rollback as the zombie branch
        currentChunk = '';
        speakNextChunk(currentVoiceIndex);
      } else if (queue.length > 0) {
        console.warn('Speech synthesis stalled, resuming queue...');
        speakNextChunk(currentVoiceIndex);
      } else {
        // Queue empty but finish() was never called — call it now.
        finish();
      }
    }
  }, 5000);
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

// Cancel the in-flight utterance, push the unspoken remainder of the current
// chunk back to the front of the queue, and resume from there. Used by the
// volume slider since utterance.volume is locked once speak() runs.
function restartBrowserSpeech() {
  if (!isSpeaking || isPaused || currentAudio) return;
  // progChar is only a trustworthy slice point when a boundary event has fired
  // for THIS utterance. On platforms that don't emit onboundary (Safari, some
  // Android), progChar is just a drifting elapsed-time estimate — slicing on it
  // would drop unspoken text (skip) or repeat spoken text. There, re-speak the
  // whole chunk; a brief repeat beats losing content.
  const haveBoundary = lastBoundaryAt > 0;
  const charInChunk = haveBoundary ? Math.max(0, progChar - currentChunkStart) : 0;
  const remainder = currentChunk ? currentChunk.slice(charInChunk) : '';
  if (remainder.length > 0) queue.unshift(remainder);
  currentChunk = '';
  if (utter) utter.onend = null; // prevent the cancel from chaining into speakNextChunk twice
  speechSynthesis.cancel();
  setTimeout(() => speakNextChunk(currentVoiceIndex), 60);
}

function speakNextChunk(voiceIndex) {
  if (!queue.length) {
    finish();
    return;
  }
  currentChunk = queue.shift();
  const chunk = currentChunk;
  utter = new SpeechSynthesisUtterance(chunk);
  utter.rate = +rateSlider.value;
  utter.volume = +volSlider.value;

  if (voiceIndex !== '-1' && browserVoices[+voiceIndex]) {
    utter.voice = browserVoices[+voiceIndex];
  }

  const chunkStart = progChar;
  currentChunkStart = chunkStart;
  chunkSpokenAt = Date.now();
  lastBoundaryAt = 0;
  utter.onboundary = (e) => {
    progChar = chunkStart + e.charIndex;
    boundarySeen = true;
    lastBoundaryAt = Date.now();
  };
  // Only the CURRENT utterance may advance the queue. A superseded utterance
  // (e.g. one orphaned by the keep-alive stall-recovery re-speak) keeps a live
  // onend; by the time it fires, `utter` already points at a newer utterance —
  // bail rather than shift the queue an extra time (double-speak/skip). Also
  // stop advancing once playback has ended.
  const thisUtter = utter;
  utter.onend = () => {
    if (utter !== thisUtter || !isSpeaking) return;
    progChar = chunkStart + chunk.length;
    speakNextChunk(voiceIndex);
  };
  utter.onerror = (e) => {
    console.error('Speech error:', e);
    if (e.error !== 'canceled') {
      showError(`Speech error: ${e.error}`);
    }
  };
  speechSynthesis.speak(utter);
}

/* ========== PROGRESS + DISPLAY ========== */
// Bias between the audio clock and the lit word, in characters. The rAF loop
// already tracks the clock frame-accurately; with a +3 lead the highlight ran
// ahead of the voice (user-reported), so no extra lead. Negative = trail.
const HIGHLIGHT_LEAD_CHARS = 0;

let progressLooping = false;
function startProgressLoop() {
  if (progressLooping) return;
  progressLooping = true;
  requestAnimationFrame(progressLoop);
}

function progressLoop() {
  if (!isSpeaking) { progressLooping = false; return; }
  if (timed && timed.curSeg && currentAudio) {
    // Timed neural: the highlight IS the audio clock — snap to the word whose
    // spoken timestamp we're inside. Exact at any speed, no estimation.
    const seg = timed.curSeg;
    const t = currentAudio.currentTime;
    if (seg.words && seg.words.length) {
      let ch = seg.start;
      for (const w of seg.words) {
        if (w[0] <= t) ch = w[1]; else break;
      }
      progChar = ch;
    }
    // Remember the reading position every few seconds for cross-visit resume.
    if (!isPaused && Date.now() - lastPosSaveAt > 3000) {
      lastPosSaveAt = Date.now();
      savePosition(timed.posKey, progChar);
    }
  } else if (currentAudio && currentAudio.duration) {
    // Legacy neural: read the audio clock every frame. ontimeupdate alone
    // fires only ~4x/s, which made the highlight visibly trail the voice.
    const frac = Math.min(1, currentAudio.currentTime / currentAudio.duration);
    progChar = Math.min(totalChars,
      neuralChunkStart + Math.floor(frac * neuralChunkLen) + HIGHLIGHT_LEAD_CHARS);
  } else if (!boundarySeen && !currentAudio) {
    const elapsed = (Date.now() - startTime) / 1000;
    progChar = Math.min(totalChars, Math.round(elapsed * (180 / 60) * 5 * rateSlider.value));
  }
  updateMeter(progChar);
  requestAnimationFrame(progressLoop);
}

function buildDisplay() {
  disp.innerHTML = '';
  lastHlEl = null;
  lastHlIdx = -1;
  totalChars = txt.value.length;
  let off = 0;
  txt.value.split(/(\s+)/).forEach((tok) => {
    const s = document.createElement('span');
    s.textContent = tok;
    s.dataset.off = off; // char offset — powers click-to-read-from-here
    off += tok.length;
    disp.appendChild(s);
  });
  resetMeter();
}

function updateMeter(chars) {
  const percent = totalChars ? Math.round((chars / totalChars) * 100) : 0;
  progressBar.value = percent;
  meterPercent.textContent = percent + ' %';

  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const avgCharsPerSec = chars > 0 ? chars / elapsed : 15;
  const remaining = chars < totalChars ? Math.round((totalChars - chars) / avgCharsPerSec) : 0;

  elapsedLabel.textContent = formatTime(elapsed);
  remainingLabel.textContent = formatTime(remaining);

  highlight(chars);
}

let lastHlEl = null;     // currently highlighted span (avoids full-DOM class sweeps at 60fps)
let lastHlIdx = -1;
let lastHlAt = 0;
let userScrolledAt = 0;  // last manual scroll in #disp — auto-follow yields to the reader

function highlight(idx) {
  // The find loop is O(spans); at 60fps on long texts that's real work.
  // Skip until the position moved a few characters or 150ms passed.
  const now = Date.now();
  if (lastHlIdx >= 0 && Math.abs(idx - lastHlIdx) < 3 && now - lastHlAt < 150) return;
  lastHlIdx = idx;
  lastHlAt = now;

  let sum = 0;
  let target = null;
  for (const span of disp.childNodes) {
    const len = span.textContent.length;
    if (idx >= sum && idx < sum + len) {
      target = span;
      break;
    }
    sum += len;
  }
  if (target === lastHlEl) return;
  if (lastHlEl) lastHlEl.classList.remove('token-highlight');
  lastHlEl = target || null;
  if (target) {
    target.classList.add('token-highlight');
    followHighlight(target);
  }
}

// Keep the spoken word visible inside the scrollable #disp box, unless the
// reader scrolled it themselves in the last few seconds.
function followHighlight(target) {
  if (Date.now() - userScrolledAt < 4000) return;
  const dr = disp.getBoundingClientRect();
  const tr = target.getBoundingClientRect();
  if (tr.top < dr.top || tr.bottom > dr.bottom - 8) {
    disp.scrollTo({
      top: disp.scrollTop + (tr.top - dr.top) - dr.height / 3,
      behavior: 'smooth',
    });
  }
}

function formatTime(s) {
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sc = String(Math.floor(s % 60)).padStart(2, '0');
  return `${h}:${m}:${sc}`;
}

/* ========== PAUSE / RESUME / STOP ========== */
function pauseSpeak() {
  if (!isSpeaking || isPaused) return;

  if (currentAudio) {
    currentAudio.pause();
  } else {
    speechSynthesis.pause();
  }

  isPaused = true;
  if (timed) savePosition(timed.posKey, progChar);
  setStatus('Paused');
  setMediaPlaybackState('paused');
  updateControls();
}

function resumeSpeak() {
  if (!isSpeaking || !isPaused) return;

  if (currentAudio) {
    // play() can reject (iOS after a long pause revokes the gesture unlock);
    // without the catch the UI said "Playing..." over silence.
    currentAudio.play().catch((err) => {
      console.warn('resume play() rejected:', err.message);
      showError('Tap Play again to continue.');
      isPaused = true;
      setStatus('Paused');
      setMediaPlaybackState('paused');
      updateControls();
    });
  } else {
    speechSynthesis.resume();
  }

  isPaused = false;
  setStatus('Playing...');
  setMediaPlaybackState('playing');
  updateControls();
}

function stopAll() {
  // Remember the spot for resume before tearing the session down.
  if (timed) {
    savePosition(timed.posKey, progChar);
    timed = null;
  }

  // Stop neural audio and unblock any pending playback promise
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    currentAudio = null;
  }
  if (audioResolve) {
    audioResolve(); // unblocks the player loop so it can check !isSpeaking
    audioResolve = null;
  }

  // Stop browser speech
  speechSynthesis.cancel();
  stopKeepAlive();
  stopSilentKeepAlive();

  queue = [];
  currentChunk = '';
  isSpeaking = false;
  isPaused = false;
  downloadBlobs = [];
  $('download').disabled = true;
  resetMeter();
  setStatus('Ready');
  setMediaPlaybackState('none');
  updateControls();
}

function finish() {
  isSpeaking = false;
  isPaused = false;
  currentAudio = null;
  timed = null;
  stopKeepAlive();
  stopSilentKeepAlive();
  setMediaPlaybackState('none');
  updateMeter(totalChars);
  setStatus('Finished');
  updateControls();
  if (downloadBlobs.length) {
    $('download').disabled = false;
  }
  // After a FREE playback, invite unlicensed users to try Studio on their own text.
  if (lastPlaybackType && lastPlaybackType !== 'studio') showStudioNudge();
}

function downloadMp3() {
  if (!downloadBlobs.length) return;
  const combined = new Blob(downloadBlobs, { type: 'audio/mpeg' });
  const url = URL.createObjectURL(combined);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'read-aloud.mp3';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function resetMeter() {
  progressBar.value = 0;
  meterPercent.textContent = '0 %';
  elapsedLabel.textContent = '00:00:00';
  remainingLabel.textContent = '00:00:00';
}

function autoSize() {
  txt.style.height = 'auto';
  const maxH = window.innerHeight * 0.45; // match CSS max-height: 45vh
  txt.style.height = Math.min(txt.scrollHeight, maxH) + 'px';
}

/* ========== UI HELPERS ========== */
function updateControls() {
  startBtn.disabled = isSpeaking;
  pauseBtn.disabled = !isSpeaking || isPaused;
  resumeBtn.disabled = !isSpeaking || !isPaused;
  stopBtn.disabled = !isSpeaking;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function showError(message) {
  errorEl.textContent = message;
}

function clearError() {
  errorEl.textContent = '';
}

/* ========== PREMIUM / STUDIO VOICES (ElevenLabs) ========== */

// First-party funnel tracking — fire-and-forget, never blocks the UI.
function trackEvent(name) {
  try {
    fetch(`${BILLING_URL}/api/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
      keepalive: true
    }).catch(() => {});
  } catch (e) {}
}

// Validate the stored license key and refresh quota. Safe to call anytime.
async function loadLicense() {
  let key = '';
  try { key = localStorage.getItem(LICENSE_KEY_LS) || ''; } catch (e) {}
  if (!key) { license = null; updateLicenseUI(); return; }
  try {
    const r = await fetch(`${BILLING_URL}/api/billing/status?key=${encodeURIComponent(key)}`);
    if (r.ok) {
      license = await r.json();
    } else {
      if (r.status === 404) { try { localStorage.removeItem(LICENSE_KEY_LS); } catch (e) {} }
      license = null;
    }
  } catch (e) {
    license = null; // network error — leave the stored key in place for a later retry
  }
  updateLicenseUI();
}

// Curated narrators (ordered). Sarah leads, so she's the licensed default and the
// default preview voice. Character-y voices (Husky Trickster, Fierce Warrior, etc.)
// are dropped. Falls back to the full catalog if too few of these are present.
const CURATED_VOICES = ['Sarah', 'Brian', 'George', 'Charlotte', 'Daniel', 'Alice',
                        'River', 'Bill', 'Lily', 'Matilda'];

function curateVoices(voices) {
  const firstName = v => (v.name || '').split(' - ')[0].trim();
  const picked = CURATED_VOICES
    .map(name => voices.find(v => firstName(v) === name))
    .filter(Boolean);
  return picked.length >= 5 ? picked : voices;
}

async function loadStudioVoices() {
  // Loaded for everyone (the endpoint is public) so unlicensed visitors can
  // browse and preview Studio voices before subscribing.
  try {
    const r = await fetch(`${BILLING_URL}/api/tts/premium/voices`);
    if (r.ok) { const d = await r.json(); studioVoices = curateVoices(d.voices || []); }
  } catch (e) { studioVoices = []; }
}

function updateLicenseUI() {
  const statusEl = $('licenseStatus');
  const upBtn = $('upgradeBtn');
  if (!statusEl) return;
  if (license && license.status === 'active') {
    const rem = license.char_remaining != null ? license.char_remaining : 0;
    statusEl.hidden = false;
    statusEl.innerHTML =
      `Studio · <strong>${rem.toLocaleString()}</strong> chars left · ` +
      `<button type="button" class="link-btn" id="manageKey">manage</button>`;
    if (upBtn) upBtn.hidden = true;
    const mk = $('manageKey');
    if (mk) mk.onclick = openUpgrade;
  } else {
    statusEl.hidden = true;
    if (upBtn) upBtn.hidden = false;
  }
}

// Fetch one premium chunk. Throws an Error with .status on failure so the caller
// can react to billing/auth errors (no silent browser fallback for those).
async function fetchStudioChunk(text, voiceId) {
  const r = await fetch(`${BILLING_URL}/api/tts/premium`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice_id: voiceId, license_key: license.key })
  });
  if (!r.ok) {
    let detail = `error ${r.status}`;
    try { const e = await r.json(); detail = e.detail || detail; } catch (_) {}
    const err = new Error(detail);
    err.status = r.status;
    throw err;
  }
  const rem = r.headers.get('X-Chars-Remaining');
  if (rem != null && license) license.char_remaining = parseInt(rem, 10);
  const blob = await r.blob();
  if (blob.size < 100) throw new Error('audio too small');
  return blob;
}

async function useStudioSpeech(voiceId) {
  setStatus('Loading studio audio...');
  isSpeaking = true;
  isPaused = false;
  downloadBlobs = [];
  $('download').disabled = true;
  updateControls();

  const chunks = chunkText(txt.value, 1500); // stays under the per-request server cap
  progChar = 0;
  startTime = Date.now();
  totalChars = txt.value.length;

  // Pre-flight quota check so we fail fast instead of mid-playback.
  if (license && license.char_remaining != null && totalChars > license.char_remaining) {
    isSpeaking = false;
    updateControls();
    showError(`Not enough Studio characters left (${license.char_remaining.toLocaleString()} remaining, ` +
              `need ${totalChars.toLocaleString()}). Upgrade or wait for renewal.`);
    setStatus('Ready');
    openUpgrade();
    return;
  }

  let nextFetch = fetchStudioChunk(chunks[0], voiceId);
  try {
    for (let i = 0; i < chunks.length; i++) {
      if (!isSpeaking) break;

      setStatus(`Loading chunk ${i + 1}/${chunks.length}...`);
      const audioBlob = await nextFetch;

      if (i + 1 < chunks.length) {
        nextFetch = fetchStudioChunk(chunks[i + 1], voiceId);
      } else {
        nextFetch = null;
      }

      downloadBlobs.push(audioBlob);
      setStatus(chunks.length > 1 ? `Playing (${i + 1}/${chunks.length})...` : 'Playing...');
      await playAudioBlob(audioBlob, chunks[i].length);
      progChar += chunks[i].length;
      updateLicenseUI();
    }
    if (isSpeaking) finish();
  } catch (err) {
    if (nextFetch) nextFetch.catch(() => {}); // swallow the in-flight look-ahead
    if (currentAudio) { currentAudio.pause(); currentAudio = null; }
    isSpeaking = false;
    isPaused = false;
    updateControls();
    if (err.status === 402) {
      showError('Studio limit reached for this period — upgrade or wait for renewal.');
      openUpgrade();
    } else if (err.status === 401) {
      showError("Your license key isn't valid anymore. Re-paste it under “manage”.");
      openUpgrade();
    } else if (err.status === 503) {
      showError('Studio is briefly at capacity — try again shortly, or use a Premium voice.');
    } else {
      showError(`Studio voice error: ${err.message}`);
    }
    setStatus('Ready');
  } finally {
    loadLicense(); // refresh remaining quota from the server
  }
}

/* ========== STUDIO PREVIEW SAMPLES (free, cached) ========== */
// The preview button ALWAYS plays a Studio voice, never the selected free
// voice. Label it accordingly or visitors think they compared free vs Studio
// and heard no difference (they heard Studio twice).
function previewBtnLabel() {
  return voiceSel && voiceSel.value.startsWith('studio:')
    ? 'Hear this voice' : 'Hear a Studio sample';
}

function stopPreview() {
  if (previewAudio) {
    previewAudio.pause();
    previewAudio = null;
  }
  const btn = $('previewBtn');
  if (btn && !btn.hidden) btn.textContent = previewBtnLabel();
}

function togglePreview() {
  if (previewAudio && !previewAudio.paused) { stopPreview(); return; }
  playSample();
}

// Pick a pleasant default preview voice (Roger, the catalog's first, isn't ideal).
function defaultPreviewVoiceId() {
  const prefer = ['Sarah', 'Charlotte', 'Brian', 'George', 'Daniel'];
  for (const name of prefer) {
    const v = studioVoices.find(x => (x.name || '').split(' - ')[0].trim() === name);
    if (v) return v.id;
  }
  return studioVoices[0] && studioVoices[0].id;
}

// "Hear a sample": plays the free, cached canned clip for the selected (or a
// default) Studio voice. Zero per-visitor character cost.
async function playSample() {
  const val = voiceSel.value;
  const vid = val.startsWith('studio:') ? val.slice('studio:'.length) : defaultPreviewVoiceId();
  if (!vid) return;
  const btn = $('previewBtn');
  stopPreview();
  if (btn) { btn.disabled = true; btn.textContent = '… loading'; }

  let url = null;
  try {
    const r = await fetch(`${BILLING_URL}/api/tts/premium/sample?voice_id=${encodeURIComponent(vid)}`);
    if (!r.ok) throw new Error('sample ' + r.status);
    url = URL.createObjectURL(await r.blob());
    previewAudio = new Audio(url);
    previewAudio.onended = () => {
      URL.revokeObjectURL(url);
      previewAudio = null;
      if (btn) btn.textContent = previewBtnLabel();
      // The sample just finished — the hottest moment in the funnel.
      trackEvent('sample_done');
      // Inline CTA only when the plans modal isn't already showing the offer.
      const modal = $('upgradeModal');
      if (modal && modal.hidden) showStudioNudge('after-sample');
    };
    previewAudio.onerror = () => {
      previewAudio = null;
      if (btn) { btn.disabled = false; btn.textContent = previewBtnLabel(); }
    };
    await previewAudio.play();
    if (btn) { btn.disabled = false; btn.textContent = 'Stop sample'; }
  } catch (e) {
    if (url) URL.revokeObjectURL(url);
    if (btn) { btn.disabled = false; btn.textContent = previewBtnLabel(); }
  }
}

/* ========== STUDIO CONVERSION NUDGE ========== */
// Shown after a free playback finishes, to unlicensed users. Offers a free
// cached Studio sample (no per-visitor character cost) and the plans.
function showStudioNudge(mode) {
  const el = $('studioNudge');
  if (!el) return;
  const eligible = studioVoices.length && !(license && license.status === 'active');
  if (!eligible) { el.hidden = true; return; }
  // Three moments, one element:
  //   'sample'       — visitor pressed Play on a Studio voice (sample now playing)
  //   'after-sample' — the sample just finished: plans become the primary action
  //   (default)      — a free playback ended; quiet invitation, shows often
  let intro, sampleLabel = 'Hear a sample';
  let plansPrimary = false;
  if (mode === 'sample') {
    intro = "<strong>That's a Studio voice, so here's a sample of it.</strong> "
      + 'The free voices above will read your full text right now.';
  } else if (mode === 'after-sample') {
    intro = "<strong>Like that voice?</strong> That's Studio. $9 a month, "
      + 'and the rest of the tool stays free.';
    sampleLabel = 'Play it again';
    plansPrimary = true;
  } else {
    intro = 'The Studio voices sound like an actual person reading.';
    sampleLabel = 'Hear one';
  }
  el.innerHTML = intro + ' '
    + '<button type="button" class="nudge-btn' + (plansPrimary ? ' nudge-btn--ghost' : '')
    + '" id="nudgeSample">' + sampleLabel + '</button> '
    + '<button type="button" class="nudge-btn' + (plansPrimary ? '' : ' nudge-btn--ghost')
    + '" id="nudgePlans">See plans</button>';
  el.hidden = false;
  const s = $('nudgeSample'); if (s) s.onclick = playSample;
  const p = $('nudgePlans'); if (p) p.onclick = openUpgrade;
}

/* ========== UPGRADE MODAL ========== */
function openUpgrade() {
  const m = $('upgradeModal');
  if (!m) return;
  trackEvent('upgrade_open');
  m.hidden = false;
  document.body.style.overflow = 'hidden';
  const ki = $('keyInput');
  if (ki) { try { ki.value = localStorage.getItem(LICENSE_KEY_LS) || ''; } catch (e) {} }
  loadTiers();
}

function closeUpgrade() {
  const m = $('upgradeModal');
  if (!m) return;
  m.hidden = true;
  document.body.style.overflow = '';
}

async function loadTiers() {
  const grid = $('tierGrid');
  if (!grid) return;
  grid.innerHTML = '<p class="muted">Loading plans…</p>';
  try {
    const r = await fetch(`${BILLING_URL}/api/billing/tiers`);
    if (!r.ok) throw new Error('tiers ' + r.status);
    const d = await r.json();
    const tiers = d.tiers || [];
    grid.innerHTML = '';
    tiers.forEach(t => {
      const price = t.amount_cents != null ? `$${(t.amount_cents / 100).toFixed(0)}` : '—';
      const cap = t.cap || 0;
      // ~900 characters ≈ one minute of spoken audio — frame the cap as a benefit.
      const mins = Math.round(cap / 900);
      const audio = mins >= 90 ? `~${(mins / 60).toFixed(1)} hrs of audio`
                              : `~${Math.max(5, Math.round(mins / 5) * 5)} min of audio`;
      const popular = t.plan === 'pro';
      const card = document.createElement('div');
      card.className = 'tier-card' + (popular ? ' tier-card--popular' : '');
      card.innerHTML =
        (popular ? '<span class="tier-flag">Most popular</span>' : '') +
        `<p class="tier-name">${t.plan}</p>` +
        `<p class="tier-price">${price}<span>/${t.interval}</span></p>` +
        `<p class="tier-cap"><span class="tier-cap-big">${audio}</span>` +
          `<span class="tier-cap-exact">${cap.toLocaleString()} characters / month</span></p>` +
        `<button type="button" class="btn tier-btn">Choose ${t.plan}</button>`;
      card.querySelector('button').onclick = (e) => startCheckout(t.price_id, e.currentTarget);
      grid.appendChild(card);
    });
    if (!grid.children.length) grid.innerHTML = '<p class="muted">Plans unavailable right now.</p>';
  } catch (e) {
    grid.innerHTML = '<p class="muted">Couldn\'t load plans — try again in a moment.</p>';
  }
}

async function startCheckout(priceId, btn) {
  trackEvent('checkout_click');
  if (btn) { btn.disabled = true; btn.textContent = 'Redirecting…'; }
  try {
    const r = await fetch(`${BILLING_URL}/api/billing/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ price_id: priceId })
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.url) { location.href = d.url; return; }
    throw new Error(d.detail || `checkout failed (${r.status})`);
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Try again'; }
    const msg = $('keyMsg');
    if (msg) msg.textContent = 'Could not start checkout: ' + e.message;
  }
}

async function applyKey() {
  const input = $('keyInput');
  const msg = $('keyMsg');
  if (!input || !msg) return;
  const key = (input.value || '').trim();
  if (!key) { msg.textContent = 'Paste your key first.'; return; }
  msg.textContent = 'Checking…';
  try {
    const r = await fetch(`${BILLING_URL}/api/billing/status?key=${encodeURIComponent(key)}`);
    if (!r.ok) {
      msg.textContent = r.status === 404 ? "That key wasn't found." : 'Could not validate key.';
      return;
    }
    const lic = await r.json();
    if (lic.status !== 'active') { msg.textContent = `That subscription is ${lic.status}.`; return; }
    try { localStorage.setItem(LICENSE_KEY_LS, key); } catch (e) {}
    license = lic;
    await loadStudioVoices();
    populateVoiceSel();
    updateLicenseUI();
    msg.textContent = `Unlocked — ${lic.char_remaining.toLocaleString()} chars on ${lic.plan}.`;
    setTimeout(closeUpgrade, 1400);
  } catch (e) {
    msg.textContent = 'Network error — try again.';
  }
}

async function recoverKey() {
  const input = $('recoverEmail');
  const msg = $('recoverMsg');
  if (!input || !msg) return;
  const email = (input.value || '').trim();
  if (!email || !email.includes('@')) { msg.textContent = 'Enter the email you paid with.'; return; }
  msg.textContent = 'Sending…';
  try {
    const r = await fetch(`${BILLING_URL}/api/billing/recover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const d = await r.json().catch(() => ({}));
    msg.textContent = d.message || 'If that email has an active subscription, the key is on its way.';
  } catch (e) {
    msg.textContent = 'Network error — try again.';
  }
}

/* ========== KEYBOARD SHORTCUTS ========== */
function handleShortcuts(event) {
  const isMac = navigator.platform.toUpperCase().includes('MAC');
  const metaKey = isMac ? event.metaKey : event.ctrlKey;

  if (metaKey && event.key === 'Enter') {
    event.preventDefault();
    startSpeak();
    return;
  }

  if (event.key === 'Escape') {
    const modal = $('upgradeModal');
    if (modal && !modal.hidden) {
      event.preventDefault();
      closeUpgrade();
      return;
    }
    if (isSpeaking) {
      event.preventDefault();
      stopAll();
    }
    return;
  }

  if (event.code === 'Space') {
    const target = event.target;
    const isEditable = target && (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' ||
      target.isContentEditable
    );
    if (isEditable) return;
    if (!isSpeaking) return;

    event.preventDefault();
    if (isPaused) {
      resumeSpeak();
    } else {
      pauseSpeak();
    }
  }
}
