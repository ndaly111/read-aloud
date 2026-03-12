/* ========== CONFIG ========== */
const CHUNK_SIZE = 900; // Character slice size
const LANGS = { en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', zh: 'Chinese', ja: 'Japanese', ko: 'Korean' };
const $ = (id) => document.getElementById(id);

// Edge TTS API URL - Update this after deploying to Render
const TTS_API_URL = 'https://read-aloud-s4ov.onrender.com';

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
let audioResolve = null; // Exposed resolve for playAudioBlob — lets stopAll() unblock it

/* ========== INIT ========== */
(async function init() {
  // Populate language dropdown
  Object.entries(LANGS).forEach(([code, name]) => langSel.add(new Option(name, code)));
  langSel.value = (navigator.language || 'en').slice(0, 2);

  // Event listeners
  langSel.onchange = () => populateVoiceSel();
  rateSlider.oninput = () => (rateValue.textContent = rateSlider.value);
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
async function checkApiAvailability() {
  // Try up to 2 times with increasing timeout
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000 * attempt);
      const response = await fetch(`${TTS_API_URL}/`, {
        method: 'GET',
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (response.ok) {
        console.log('✓ Premium neural voices available');
        return true;
      }
    } catch (e) {
      console.warn(`API check attempt ${attempt} failed:`, e.message);
      if (attempt < 2) await new Promise(r => setTimeout(r, 500));
    }
  }
  console.warn('Premium voices unavailable - using browser voices only');
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
async function useNeuralSpeech(voiceId) {
  setStatus('Connecting to voice server...');
  isSpeaking = true;
  isPaused = false;
  downloadBlobs = [];
  $('download').disabled = true;
  updateControls();

  // Chunk text for long documents
  const chunks = chunkText(txt.value, 4500); // Edge TTS limit ~5000
  progChar = 0;
  startTime = Date.now();
  totalChars = txt.value.length;

  let consecutiveErrors = 0;
  const MAX_ERRORS = 2;

  try {
    for (let i = 0; i < chunks.length; i++) {
      if (!isSpeaking) break; // Stopped

      setStatus(`Rendering audio (${i + 1}/${chunks.length})...`);

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

        console.log('Fetching TTS for chunk', i + 1, 'voice:', voiceId);
        const response = await fetch(`${TTS_API_URL}/api/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: chunks[i],
            voice: voiceId,
            rate: rateToApiFormat(+rateSlider.value),
            pitch: '+0Hz'
          }),
          signal: controller.signal
        });

        clearTimeout(timeout);
        console.log('TTS response status:', response.status);

        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          console.error('TTS API error:', error);
          throw new Error(error.detail || `API error: ${response.status}`);
        }

        const audioBlob = await response.blob();
        console.log('Got audio blob, size:', audioBlob.size);
        downloadBlobs.push(audioBlob);
        await playAudioBlob(audioBlob, chunks[i].length);

        progChar += chunks[i].length;
        consecutiveErrors = 0; // Reset on success

      } catch (chunkError) {
        consecutiveErrors++;
        console.warn(`Chunk ${i + 1} failed:`, chunkError.message);

        if (consecutiveErrors >= MAX_ERRORS) {
          throw new Error(`Multiple failures - switching to browser voice`);
        }

        // Skip this chunk and continue with next
        progChar += chunks[i].length;
        showError(`Chunk skipped, continuing...`);
        await new Promise(r => setTimeout(r, 500));
        clearError();
      }
    }

    if (isSpeaking) finish();

  } catch (error) {
    console.error('Neural TTS error:', error);

    // Clean up any partial state
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }

    // Fallback to browser voice
    setStatus('Switching to browser voice...');
    showError('Premium voice unavailable. Using browser voice instead.');

    // Small delay so user sees the message
    await new Promise(r => setTimeout(r, 1000));
    clearError();

    // Reset and use browser speech
    progChar = 0;
    useBrowserSpeech('-1');
  }
}

function playAudioBlob(blob, chunkLength) {
  return new Promise((resolve, reject) => {
    console.log('Playing audio blob, size:', blob.size);
    if (blob.size < 100) {
      reject(new Error('Audio blob too small - API may have failed'));
      return;
    }
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    currentAudio = audio;

    const chunkStart = progChar;
    let done = false;

    // Expose resolve so stopAll() can unblock this promise immediately
    audioResolve = () => {
      if (done) return;
      done = true;
      audioResolve = null;
      URL.revokeObjectURL(url);
      if (currentAudio === audio) currentAudio = null;
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
      URL.revokeObjectURL(url);
      if (currentAudio === audio) currentAudio = null;
      resolve();
    };

    audio.onerror = () => {
      if (done) return;
      done = true;
      audioResolve = null;
      URL.revokeObjectURL(url);
      if (currentAudio === audio) currentAudio = null;
      reject(new Error('Audio playback failed'));
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
    audio.oncanplaythrough = () => setStatus('Playing...');
    audio.play().catch((err) => {
      if (done) return;
      done = true;
      audioResolve = null;
      URL.revokeObjectURL(url);
      if (currentAudio === audio) currentAudio = null;
      reject(err);
    });
  });
}

function chunkText(text, maxLength) {
  const chunks = [];
  const sentences = text.match(/[^.!?]+[.!?]+[\s]*/g) || [text];

  let currentChunk = '';
  for (const sentence of sentences) {
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

  return chunks.length ? chunks : [text];
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

function speakNextChunk(voiceIndex) {
  if (!queue.length) {
    finish();
    return;
  }
  currentChunk = queue.shift();
  const chunk = currentChunk;
  utter = new SpeechSynthesisUtterance(chunk);
  utter.rate = +rateSlider.value;

  if (voiceIndex !== '-1' && browserVoices[+voiceIndex]) {
    utter.voice = browserVoices[+voiceIndex];
  }

  const chunkStart = progChar;
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
