// tts.js: Handles text-to-speech logic
import { voices } from './voices.js';

let speechSynthesisUtterance;

export function startReading(text, voiceIndex, rate = 1, pitch = 1, onBoundary, onEnd) {
    if (!text) {
        alert('Please enter some text to read aloud.');
        return;
    }

    if (speechSynthesis.speaking) {
        speechSynthesis.cancel();
    }

    speechSynthesisUtterance = new SpeechSynthesisUtterance(text);

    if (voiceIndex >= 0 && voices[voiceIndex]) {
        speechSynthesisUtterance.voice = voices[voiceIndex];
    }

    speechSynthesisUtterance.rate = rate;
    speechSynthesisUtterance.pitch = pitch;
    speechSynthesisUtterance.onboundary = onBoundary;
    speechSynthesisUtterance.onend = onEnd;

    speechSynthesis.speak(speechSynthesisUtterance);
}

export function pauseReading() {
    if (speechSynthesis.speaking) {
        speechSynthesis.pause();
    }
}

export function resumeReading() {
    if (speechSynthesis.paused) {
        speechSynthesis.resume();
    }
}

export function stopReading() {
    if (speechSynthesis.speaking) {
        speechSynthesis.cancel();
    }
}
