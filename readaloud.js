/* ========== CONFIG ========== */
const CHUNK_SIZE = 900; // Character slice size
const LANGS = { en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', zh: 'Chinese', ja: 'Japanese', ko: 'Korean' };
const $ = (id) => document.getElementById(id);

// Edge TTS API URL - Update this after deploying to Render
const TTS_API_URL = 'https://read-aloud-s4ov.onrender.com';

// Premium Neural Voices (Edge TTS - free, high quality)
const NEURAL_VOICES = {
  en: [
    { id: 'en-US-AriaNeural', name: 'Aria', gender: 'Female', accent: 'US', style: 'friendly' },
    { id: 'en-US-JennyNeural', name: 'Jenny', gender: 'Female', accent: 'US', style: 'assistant' },
    { id: 'en-US-GuyNeural', name: 'Guy', gender: 'Male', accent: 'US', style: 'newscast' },
    { id: 'en-US-DavisNeural', name: 'Davis', gender: 'Male', accent: 'US', style: 'calm' },
    { id: 'en-US-SaraNeural', name: 'Sara', gender: 'Female', accent: 'US', style: 'cheerful' },
    { id: 'en-US-ChristopherNeural', name: 'Christopher', gender: 'Male', accent: 'US', style: 'reliable' },
    { id: 'en-GB-SoniaNeural', name: 'Sonia', gender: 'Female', accent: 'UK', style: 'professional' },
    { id: 'en-GB-RyanNeural', name: 'Ryan', gender: 'Male', accent: 'UK', style: 'cheerful' },
    { id: 'en-AU-NatashaNeural', name: 'Natasha', gender: 'Female', accent: 'AU', style: 'friendly' },
    { id: 'en-AU-WilliamNeural', name: 'William', gender: 'Male', accent: 'AU', style: 'conversational' },
  ],
  es: [
    { id: 'es-ES-ElviraNeural', name: 'Elvira', gender: 'Female', accent: 'Spain' },
    { id: 'es-ES-AlvaroNeural', name: 'Alvaro', gender: 'Male', accent: 'Spain' },
    { id: 'es-MX-DaliaNeural', name: 'Dalia', gender: 'Female', accent: 'Mexico' },
    { id: 'es-MX-JorgeNeural', name: 'Jorge', gender: 'Male', accent: 'Mexico' },
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

  txt.addEventListener('input', () => {
    clearError();
    buildDisplay();
  });
  window.addEventListener('resize', autoSize);
  window.addEventListener('keydown', handleShortcuts);

  // Check API availability and load voices
  setStatus('Loading voices...');
  apiAvailable = await checkApiAvailability();
  await loadBrowserVoices();
  populateVoiceSel();

  buildDisplay();
  autoSize();
  updateControls();
  setStatus('Ready');
})();

/* ========== API CHECK ========== */
async function checkApiAvailability() {
  // Try up to 2 times with increasing timeout
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000 * attempt);
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

// Re-check API availability periodically (in case it comes back online)
async function recheckApi() {
  if (!apiAvailable) {
    const nowAvailable = await checkApiAvailability();
    if (nowAvailable && !apiAvailable) {
      apiAvailable = true;
      populateVoiceSel();
      console.log('Premium voices now available!');
    }
  }
}

// Check every 5 minutes if API was initially unavailable
setInterval(() => {
  if (!apiAvailable) recheckApi();
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
    neuralGroup.label = '⭐ Premium Neural Voices (Natural Sound)';

    neuralVoices.forEach(v => {
      const opt = document.createElement('option');
      opt.value = `neural:${v.id}`;
      opt.textContent = `${v.name} (${v.gender}${v.accent ? ', ' + v.accent : ''})`;
      opt.title = v.style ? `Style: ${v.style}` : '';
      neuralGroup.appendChild(opt);
    });

    voiceSel.appendChild(neuralGroup);
  }

  // Add browser voices - always available as fallback
  const browserGroup = document.createElement('optgroup');
  browserGroup.label = apiAvailable ? '📱 Browser Voices (Works Offline)' : '📱 Browser Voices';

  const defaultOpt = document.createElement('option');
  defaultOpt.value = 'browser:-1';
  defaultOpt.textContent = 'Default Browser Voice';
  browserGroup.appendChild(defaultOpt);

  // Filter and sort browser voices by language
  const langVoices = browserVoices.filter(v => v.lang.startsWith(lang));

  // If no voices for selected language, show all voices
  const voicesToShow = langVoices.length > 0 ? langVoices : browserVoices;

  voicesToShow.forEach((v) => {
    const opt = document.createElement('option');
    const realIndex = browserVoices.indexOf(v);
    opt.value = `browser:${realIndex}`;
    opt.textContent = `${v.name} (${v.lang})`;
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
  if (isSpeaking) stopAll();
  if (!txt.value.trim()) {
    showError('Please type or paste some text first.');
    setStatus('Ready');
    return;
  }
  clearError();

  const [voiceType, voiceId] = voiceSel.value.split(':');

  if (voiceType === 'neural' && apiAvailable) {
    useNeuralSpeech(voiceId);
  } else {
    useBrowserSpeech(voiceId);
  }
}

/* ========== NEURAL TTS (Edge TTS API) ========== */
async function useNeuralSpeech(voiceId) {
  setStatus('Generating audio...');
  isSpeaking = true;
  isPaused = false;
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

      setStatus(`Speaking (${i + 1}/${chunks.length})...`);

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

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

        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw new Error(error.detail || `API error: ${response.status}`);
        }

        const audioBlob = await response.blob();
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
    const url = URL.createObjectURL(blob);
    currentAudio = new Audio(url);

    const chunkStart = progChar;

    currentAudio.ontimeupdate = () => {
      if (currentAudio.duration) {
        const chunkProgress = currentAudio.currentTime / currentAudio.duration;
        const currentChar = chunkStart + Math.floor(chunkProgress * chunkLength);
        updateMeter(currentChar);
      }
    };

    currentAudio.onended = () => {
      URL.revokeObjectURL(url);
      currentAudio = null;
      resolve();
    };

    currentAudio.onerror = (e) => {
      URL.revokeObjectURL(url);
      currentAudio = null;
      reject(new Error('Audio playback failed'));
    };

    currentAudio.playbackRate = 1; // Rate is handled by API
    currentAudio.play().catch(reject);
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
  queue = txt.value.match(new RegExp(`[\\s\\S]{1,${CHUNK_SIZE}}(?:\\s|$)`, 'g')) || [];
  progChar = 0;
  startTime = Date.now();
  boundarySeen = false;
  isSpeaking = true;
  isPaused = false;
  setStatus('Speaking');
  updateControls();
  speakNextChunk(voiceIndex);
  requestAnimationFrame(progressLoop);
}

function speakNextChunk(voiceIndex) {
  if (!queue.length) {
    finish();
    return;
  }
  const chunk = queue.shift();
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
  setStatus('Speaking');
  updateControls();
}

function stopAll() {
  // Stop neural audio
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    currentAudio = null;
  }

  // Stop browser speech
  speechSynthesis.cancel();

  queue = [];
  isSpeaking = false;
  isPaused = false;
  resetMeter();
  setStatus('Ready');
  updateControls();
}

function finish() {
  isSpeaking = false;
  isPaused = false;
  currentAudio = null;
  updateMeter(totalChars);
  setStatus('Finished');
  updateControls();
}

function resetMeter() {
  progressBar.value = 0;
  meterPercent.textContent = '0 %';
  elapsedLabel.textContent = '00:00:00';
  remainingLabel.textContent = '00:00:00';
}

function autoSize() {
  txt.style.height = 'auto';
  txt.style.height = txt.scrollHeight + 'px';
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
