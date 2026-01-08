/* ========== CONFIG ========== */
const CHUNK_SIZE = 900; // Character slice size
const LANGS = { en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian' };
const $ = (id) => document.getElementById(id);

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
let voices = [];
let queue = [];
let utter = null;
let progChar = 0;
let totalChars = 0;
let startTime = 0;
let isSpeaking = false;
let boundarySeen = false;
let isPaused = false;

/* ========== INIT ========== */
(async function init() {
  // Populate language dropdown
  Object.entries(LANGS).forEach(([code, name]) => langSel.add(new Option(name, code)));
  langSel.value = (navigator.language || 'en').slice(0, 2);

  // Event listeners
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

  await loadVoicesWithKick(); // Load voices, with iOS kick
  buildDisplay();
  autoSize();
  updateControls();
})();

/* ========== VOICE LOADING (FIX FOR iOS) ========== */
async function loadVoicesWithKick() {
  // Attempt to get voices
  voices = speechSynthesis.getVoices();
  if (voices.length) {
    populateVoiceSel();
    return;
  }

  // Kick iOS with a silent utterance
  await new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    u.onend = resolve;
    speechSynthesis.speak(u);
  });

  // Wait for voiceschanged event
  await new Promise((resolve) => {
    speechSynthesis.onvoiceschanged = () => {
      voices = speechSynthesis.getVoices();
      populateVoiceSel();
      resolve();
    };
  });
}

function populateVoiceSel() {
  voiceSel.innerHTML = '<option value="-1">Default</option>';
  voices.forEach((v, i) => voiceSel.add(new Option(`${v.name} (${v.lang})`, i)));
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

  // Web Speech API available?
  if (speechSynthesis && voices.length) {
    useWebSpeech();
  } else {
    useMeSpeakFallback();
  }
}

function useWebSpeech() {
  queue = txt.value.match(new RegExp(`[\\s\\S]{1,${CHUNK_SIZE}}(?:\\s|$)`, 'g')) || [];
  progChar = 0;
  startTime = Date.now();
  boundarySeen = false;
  isSpeaking = true;
  isPaused = false;
  setStatus('Speaking');
  updateControls();
  speakNextChunk();
  requestAnimationFrame(progressLoop);
}

function speakNextChunk() {
  if (!queue.length) {
    finish();
    return;
  }
  const chunk = queue.shift();
  utter = new SpeechSynthesisUtterance(chunk);
  utter.rate = +rateSlider.value;
  if (voiceSel.value !== '-1') utter.voice = voices[+voiceSel.value];
  const chunkStart = progChar;
  utter.onboundary = (e) => {
    progChar = chunkStart + e.charIndex;
    boundarySeen = true;
  };
  utter.onend = () => {
    progChar = chunkStart + chunk.length;
    speakNextChunk();
  };
  speechSynthesis.speak(utter);
}

/* ========== PROGRESS + DISPLAY ========== */
function progressLoop() {
  if (!isSpeaking) return;
  if (!boundarySeen) {
    const elapsed = (Date.now() - startTime) / 1000;
    progChar = Math.min(totalChars, Math.round(elapsed * (180 / 60) * 5));
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
  const estTotal = totalChars ? Math.round(totalChars / (180 * 5 / 60) / rateSlider.value) : 0;
  const remaining = Math.max(0, estTotal - elapsed);
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
  const sc = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sc}`;
}

/* ========== STOP/RESET ========== */
function stopAll() {
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

/* ========== FALLBACK (meSpeak) ========== */
async function useMeSpeakFallback() {
  setStatus('Speaking (fallback)');
  if (!window.mespeakLoaded) {
    showError('meSpeak is not yet ready. Please try again in a second.');
    setStatus('Ready');
    updateControls();
    return;
  }
  clearError();
  progChar = 0;
  startTime = Date.now();
  isSpeaking = true;
  isPaused = false;
  updateControls();
  const chunks = txt.value.match(new RegExp(`[\\s\\S]{1,${CHUNK_SIZE}}(?:\\s|$)`, 'g')) || [];
  for (const chunk of chunks) {
    await new Promise((res) => mespeak.speak(chunk, { speed: +rateSlider.value * 175 }, res));
    progChar += chunk.length;
    updateMeter(progChar);
  }
  finish();
}

function pauseSpeak() {
  if (!isSpeaking || isPaused) return;
  speechSynthesis.pause();
  isPaused = true;
  setStatus('Paused');
  updateControls();
}

function resumeSpeak() {
  if (!isSpeaking || !isPaused) return;
  speechSynthesis.resume();
  isPaused = false;
  setStatus('Speaking');
  updateControls();
}

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
    const isEditable =
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable);
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
