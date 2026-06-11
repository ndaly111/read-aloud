/* ========== CONFIG ========== */
const CHUNK_SIZE = 900; // Character slice size
const LANGS = { en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', zh: 'Chinese', ja: 'Japanese', ko: 'Korean' };
const $ = (id) => document.getElementById(id);

// Edge TTS API endpoints, in priority order.
// Primary: self-hosted via Cloudflare Tunnel from mini PC (no cold start, larger cache).
// Fallback: Render free tier (cold-starts but always reachable).
// activeTtsUrl tracks which one is currently working; flips automatically on failure
// and on the next 5-minute health probe when the primary recovers.
const TTS_ENDPOINTS = [
  'https://tts.read-aloud.com',
  'https://read-aloud-s4ov.onrender.com',
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
let audioResolve = null; // Exposed resolve for playAudioBlob — lets stopAll() unblock it
let volChangeTimer = null; // Debounce for live volume changes that re-trigger browser TTS

/* ========== INIT ========== */
(async function init() {
  // Populate language dropdown
  Object.entries(LANGS).forEach(([code, name]) => langSel.add(new Option(name, code)));
  langSel.value = (navigator.language || 'en').slice(0, 2);

  // Event listeners
  langSel.onchange = () => populateVoiceSel();
  rateSlider.oninput = () => (rateValue.textContent = rateSlider.value);
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
  const modal = $('upgradeModal');
  if (modal) modal.addEventListener('click', (e) => {
    if (e.target === modal) closeUpgrade();
  });

  txt.addEventListener('input', () => {
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
  if (pv) pv.hidden = !studioVoices.length;
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
    useNeuralSpeech(voiceId);
  } else {
    useBrowserSpeech(voiceId);
  }
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

async function useNeuralSpeech(voiceId) {
  setStatus('Loading audio...');
  isSpeaking = true;
  isPaused = false;
  downloadBlobs = [];
  $('download').disabled = true;
  updateControls();

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

    progChar = 0;
    useBrowserSpeech('-1');
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
    const audio = new Audio(url);
    audio.volume = +volSlider.value;
    currentAudio = audio;

    const chunkStart = progChar;
    let done = false;

    function cleanup() {
      clearTimeout(safetyTimer);
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

    // If the browser suspends the audio (tab hidden, network blip, etc.),
    // retry playing the already-rendered blob rather than failing.
    const retryPlay = () => {
      if (done || isPaused) return;
      console.warn('Audio stalled, retrying play...');
      audio.play().catch(() => {}); // silent — onerror will handle a real failure
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
function useBrowserSpeech(voiceIndex) {
  currentVoiceIndex = voiceIndex;
  queue = txt.value.match(new RegExp(`[\\s\\S]{1,${CHUNK_SIZE}}(?:\\s|$)`, 'g')) || [];
  progChar = 0;
  startTime = Date.now();
  boundarySeen = false;
  isSpeaking = true;
  isPaused = false;
  setStatus('Playing...');
  updateControls();
  startKeepAlive();
  speakNextChunk(voiceIndex);
  requestAnimationFrame(progressLoop);
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
    } else if (!speechSynthesis.pending) {
      // Chrome silently killed speech — nothing is speaking or queued.
      // Put the current (interrupted) chunk back at the front and re-speak.
      if (currentChunk) {
        console.warn('Speech synthesis stalled, re-speaking current chunk...');
        queue.unshift(currentChunk);
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
  const charInChunk = Math.max(0, progChar - currentChunkStart);
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
  utter.onboundary = (e) => {
    progChar = chunkStart + e.charIndex;
    boundarySeen = true;
  };
  utter.onend = () => {
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
function progressLoop() {
  if (!isSpeaking) return;
  if (!boundarySeen && !currentAudio) {
    const elapsed = (Date.now() - startTime) / 1000;
    progChar = Math.min(totalChars, Math.round(elapsed * (180 / 60) * 5 * rateSlider.value));
  }
  updateMeter(progChar);
  requestAnimationFrame(progressLoop);
}

function buildDisplay() {
  disp.innerHTML = '';
  totalChars = txt.value.length;
  txt.value.split(/(\s+)/).forEach((tok) => {
    const s = document.createElement('span');
    s.textContent = tok;
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

function highlight(idx) {
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
  Array.from(disp.children).forEach((s) => s.classList.remove('token-highlight'));
  if (target) target.classList.add('token-highlight');
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
  setStatus('Paused');
  updateControls();
}

function resumeSpeak() {
  if (!isSpeaking || !isPaused) return;

  if (currentAudio) {
    currentAudio.play();
  } else {
    speechSynthesis.resume();
  }

  isPaused = false;
  setStatus('Playing...');
  updateControls();
}

function stopAll() {
  // Stop neural audio and unblock any pending playAudioBlob promise
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    currentAudio = null;
  }
  if (audioResolve) {
    audioResolve(); // unblocks useNeuralSpeech loop so it can check !isSpeaking
    audioResolve = null;
  }

  // Stop browser speech
  speechSynthesis.cancel();
  stopKeepAlive();

  queue = [];
  currentChunk = '';
  isSpeaking = false;
  isPaused = false;
  downloadBlobs = [];
  $('download').disabled = true;
  resetMeter();
  setStatus('Ready');
  updateControls();
}

function finish() {
  isSpeaking = false;
  isPaused = false;
  currentAudio = null;
  stopKeepAlive();
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
function stopPreview() {
  if (previewAudio) {
    previewAudio.pause();
    previewAudio = null;
  }
  const btn = $('previewBtn');
  if (btn && !btn.hidden) btn.textContent = 'Hear a sample';
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
      if (btn) btn.textContent = 'Hear a sample';
      // The sample just finished — the hottest moment in the funnel.
      trackEvent('sample_done');
      // Inline CTA only when the plans modal isn't already showing the offer.
      const modal = $('upgradeModal');
      if (modal && modal.hidden) showStudioNudge('after-sample');
    };
    previewAudio.onerror = () => {
      previewAudio = null;
      if (btn) { btn.disabled = false; btn.textContent = 'Hear a sample'; }
    };
    await previewAudio.play();
    if (btn) { btn.disabled = false; btn.textContent = 'Stop sample'; }
  } catch (e) {
    if (url) URL.revokeObjectURL(url);
    if (btn) { btn.disabled = false; btn.textContent = 'Hear a sample'; }
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
