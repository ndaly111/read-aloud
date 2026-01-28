/**
 * Premium TTS Module - Uses Edge TTS neural voices via API
 * Falls back to browser voices if API is unavailable
 */

const TTS_API_URL = 'https://read-aloud-tts-api.onrender.com'; // Update after deploying

// Neural voice options (much better than browser defaults)
export const NEURAL_VOICES = {
  'en-US': [
    { id: 'en-US-AriaNeural', name: 'Aria (Female)', style: 'friendly' },
    { id: 'en-US-GuyNeural', name: 'Guy (Male)', style: 'newscast' },
    { id: 'en-US-JennyNeural', name: 'Jenny (Female)', style: 'assistant' },
    { id: 'en-US-DavisNeural', name: 'Davis (Male)', style: 'calm' },
    { id: 'en-US-MichelleNeural', name: 'Michelle (Female)', style: 'warm' },
    { id: 'en-US-ChristopherNeural', name: 'Christopher (Male)', style: 'reliable' },
    { id: 'en-US-SaraNeural', name: 'Sara (Female)', style: 'cheerful' },
  ],
  'en-GB': [
    { id: 'en-GB-SoniaNeural', name: 'Sonia (Female)', style: 'professional' },
    { id: 'en-GB-RyanNeural', name: 'Ryan (Male)', style: 'cheerful' },
    { id: 'en-GB-LibbyNeural', name: 'Libby (Female)', style: 'warm' },
  ],
  'en-AU': [
    { id: 'en-AU-NatashaNeural', name: 'Natasha (Female)', style: 'friendly' },
    { id: 'en-AU-WilliamNeural', name: 'William (Male)', style: 'conversational' },
  ],
  'es': [
    { id: 'es-ES-ElviraNeural', name: 'Elvira (Female, Spain)' },
    { id: 'es-ES-AlvaroNeural', name: 'Alvaro (Male, Spain)' },
    { id: 'es-MX-DaliaNeural', name: 'Dalia (Female, Mexico)' },
    { id: 'es-MX-JorgeNeural', name: 'Jorge (Male, Mexico)' },
  ],
  'fr': [
    { id: 'fr-FR-DeniseNeural', name: 'Denise (Female)' },
    { id: 'fr-FR-HenriNeural', name: 'Henri (Male)' },
  ],
  'de': [
    { id: 'de-DE-KatjaNeural', name: 'Katja (Female)' },
    { id: 'de-DE-ConradNeural', name: 'Conrad (Male)' },
  ],
  'it': [
    { id: 'it-IT-ElsaNeural', name: 'Elsa (Female)' },
    { id: 'it-IT-DiegoNeural', name: 'Diego (Male)' },
  ],
  'pt': [
    { id: 'pt-BR-FranciscaNeural', name: 'Francisca (Female)' },
    { id: 'pt-BR-AntonioNeural', name: 'Antonio (Male)' },
  ],
  'zh': [
    { id: 'zh-CN-XiaoxiaoNeural', name: 'Xiaoxiao (Female)' },
    { id: 'zh-CN-YunxiNeural', name: 'Yunxi (Male)' },
  ],
  'ja': [
    { id: 'ja-JP-NanamiNeural', name: 'Nanami (Female)' },
    { id: 'ja-JP-KeitaNeural', name: 'Keita (Male)' },
  ],
  'ko': [
    { id: 'ko-KR-SunHiNeural', name: 'SunHi (Female)' },
    { id: 'ko-KR-InJoonNeural', name: 'InJoon (Male)' },
  ],
};

// State
let currentAudio = null;
let isPlaying = false;
let isPaused = false;
let useNeuralVoices = true; // Toggle for premium/browser voices

/**
 * Check if the TTS API is available
 */
export async function checkApiAvailability() {
  try {
    const response = await fetch(`${TTS_API_URL}/`, { method: 'GET', timeout: 5000 });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get neural voices for a language
 */
export function getNeuralVoices(lang) {
  // Try exact match first, then language code only
  return NEURAL_VOICES[lang] || NEURAL_VOICES[lang.split('-')[0]] || NEURAL_VOICES['en-US'];
}

/**
 * Populate voice dropdown with neural voices
 */
export function populateNeuralVoiceDropdown(selectElement, lang = 'en-US') {
  const voices = getNeuralVoices(lang);
  selectElement.innerHTML = '';

  // Add neural voices header
  const neuralGroup = document.createElement('optgroup');
  neuralGroup.label = '🌟 Premium Neural Voices';

  voices.forEach(voice => {
    const option = document.createElement('option');
    option.value = voice.id;
    option.textContent = voice.name;
    if (voice.style) option.title = `Style: ${voice.style}`;
    neuralGroup.appendChild(option);
  });

  selectElement.appendChild(neuralGroup);

  // Add browser voices as fallback option
  const browserOption = document.createElement('option');
  browserOption.value = 'browser-default';
  browserOption.textContent = '📱 Use Browser Voice (Offline)';
  selectElement.appendChild(browserOption);
}

/**
 * Convert rate slider value (0.5-2) to API format (+/-%)
 */
function rateToApiFormat(rate) {
  const percent = Math.round((rate - 1) * 100);
  return percent >= 0 ? `+${percent}%` : `${percent}%`;
}

/**
 * Generate speech using neural TTS API
 */
export async function speakNeural(text, voice, rate = 1, onProgress, onEnd, onError) {
  if (!text.trim()) {
    onError?.('No text provided');
    return;
  }

  // Stop any current playback
  stop();

  // Check if using browser fallback
  if (voice === 'browser-default' || !useNeuralVoices) {
    return speakBrowser(text, null, rate, onEnd, onError);
  }

  try {
    const response = await fetch(`${TTS_API_URL}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: text,
        voice: voice,
        rate: rateToApiFormat(rate),
        pitch: '+0Hz'
      })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error(error.detail || `API error: ${response.status}`);
    }

    const audioBlob = await response.blob();
    const audioUrl = URL.createObjectURL(audioBlob);

    currentAudio = new Audio(audioUrl);
    currentAudio.onended = () => {
      isPlaying = false;
      URL.revokeObjectURL(audioUrl);
      onEnd?.();
    };
    currentAudio.onerror = (e) => {
      isPlaying = false;
      onError?.(`Audio playback error: ${e.message}`);
    };
    currentAudio.ontimeupdate = () => {
      if (currentAudio.duration) {
        const progress = (currentAudio.currentTime / currentAudio.duration) * 100;
        onProgress?.(progress, currentAudio.currentTime, currentAudio.duration);
      }
    };

    await currentAudio.play();
    isPlaying = true;
    isPaused = false;

  } catch (error) {
    console.warn('Neural TTS failed, falling back to browser:', error.message);
    // Fallback to browser TTS
    return speakBrowser(text, null, rate, onEnd, onError);
  }
}

/**
 * Fallback: Use browser's built-in TTS
 */
export function speakBrowser(text, voice, rate, onEnd, onError) {
  if (!('speechSynthesis' in window)) {
    onError?.('Browser does not support speech synthesis');
    return;
  }

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = rate;

  if (voice && typeof voice === 'object') {
    utterance.voice = voice;
  }

  utterance.onend = () => {
    isPlaying = false;
    onEnd?.();
  };
  utterance.onerror = (e) => {
    isPlaying = false;
    onError?.(`Speech error: ${e.error}`);
  };

  speechSynthesis.speak(utterance);
  isPlaying = true;
  isPaused = false;
}

/**
 * Pause playback
 */
export function pause() {
  if (currentAudio && isPlaying && !isPaused) {
    currentAudio.pause();
    isPaused = true;
  } else if (speechSynthesis.speaking && !speechSynthesis.paused) {
    speechSynthesis.pause();
    isPaused = true;
  }
}

/**
 * Resume playback
 */
export function resume() {
  if (currentAudio && isPaused) {
    currentAudio.play();
    isPaused = false;
  } else if (speechSynthesis.paused) {
    speechSynthesis.resume();
    isPaused = false;
  }
}

/**
 * Stop playback
 */
export function stop() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    currentAudio = null;
  }
  if (speechSynthesis.speaking) {
    speechSynthesis.cancel();
  }
  isPlaying = false;
  isPaused = false;
}

/**
 * Get current playback state
 */
export function getState() {
  return { isPlaying, isPaused };
}

/**
 * Toggle between neural and browser voices
 */
export function setUseNeuralVoices(enabled) {
  useNeuralVoices = enabled;
}

/**
 * Chunk long text for streaming (better UX for long documents)
 */
export function chunkText(text, maxLength = 1000) {
  const chunks = [];
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];

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

  return chunks;
}

/**
 * Speak long text in chunks (with progress tracking)
 */
export async function speakLongText(text, voice, rate, onChunkProgress, onTotalProgress, onEnd, onError) {
  const chunks = chunkText(text);
  let currentChunkIndex = 0;

  const speakNextChunk = async () => {
    if (currentChunkIndex >= chunks.length) {
      onEnd?.();
      return;
    }

    const totalProgress = (currentChunkIndex / chunks.length) * 100;
    onTotalProgress?.(totalProgress, currentChunkIndex, chunks.length);

    await speakNeural(
      chunks[currentChunkIndex],
      voice,
      rate,
      (chunkProgress) => onChunkProgress?.(chunkProgress),
      () => {
        currentChunkIndex++;
        speakNextChunk();
      },
      onError
    );
  };

  await speakNextChunk();
}
