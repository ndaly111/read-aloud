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

  txt.addEventListener('input', () => {
    clearError();
    buildDisplay();
  });
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
          console.log('✓ Premium neural voices available');
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

  // Add neural voices first (if API available)
  const neuralVoices = NEURAL_VOICES[lang] || NEURAL_VOICES['en'];

  if (apiAvailable && neuralVoices.length) {
    const neuralGroup = document.createElement('optgroup');
    neuralGroup.label = '⭐ Premium Voices';

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
  browserGroup.label = apiAvailable ? '📱 Browser (Offline)' : '📱 Browser Voices';

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

  // Select first neural voice by default if available, otherwise first browser voice
  if (apiAvailable && neuralVoices.length) {
    voiceSel.value = `neural:${neuralVoices[0].id}`;
  } else {
    voiceSel.value = 'browser:-1';
  }

  // Update status to show voice type
  updateVoiceStatus();
}

function updateVoiceStatus() {
  const [voiceType] = voiceSel.value.split(':');
  const indicator = document.getElementById('voice-type-indicator');
  if (indicator) {
    if (voiceType === 'neural') {
      indicator.textContent = '⭐ Premium';
      indicator.className = 'voice-indicator voice-indicator--premium';
    } else {
      indicator.textContent = '📱 Browser';
      indicator.className = 'voice-indicator voice-indicator--browser';
    }
  }
}

// Update indicator when voice changes
if (voiceSel) {
  voiceSel.addEventListener('change', updateVoiceStatus);
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
  isSpeaking = true;
  startBtn.disabled = true;

  const [voiceType, voiceId] = voiceSel.value.split(':');

  if (voiceType === 'neural' && apiAvailable) {
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
