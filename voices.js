export const regionalVoicePriority = {
    "en-US": ["Samantha", "Alex"],
    "en-GB": ["Daniel", "Serena", "Moira"],
    "en-AU": ["Karen", "Russell"],
    "fr-FR": ["Thomas", "Audrey"],
    "de-DE": ["Hans", "Marlene"],
    "it-IT": ["Alice", "Luca"],
};

export const highQualityVoices = [
    "Samantha", "Alex", "Daniel", "Serena", "Moira",
    "Karen", "Russell", "Thomas", "Audrey", "Hans",
    "Marlene", "Alice", "Luca"
];

export const excludedVoices = [
    "Jester", "Organ", "Bubbles", "Bad News", "Boing", "Wobble",
    "Grandma", "Grandpa", "Rocko", "Shelley", "Flo", "Eddy", "Reed"
];

export let cachedVoices = [];

/**
 * Populates the voices array using the SpeechSynthesis API.
 * Waits for the `voiceschanged` event if voices are not immediately available.
 * @returns {Promise<Array>} - A Promise that resolves with the available voices.
 */
export async function populateVoices() {
    if (cachedVoices.length > 0) {
        console.log("Using cached voices:", cachedVoices);
        return cachedVoices;
    }

    cachedVoices = speechSynthesis.getVoices();

    if (cachedVoices.length === 0) {
        console.log("Waiting for voices to load...");
        await new Promise(resolve => {
            speechSynthesis.addEventListener('voiceschanged', () => {
                cachedVoices = speechSynthesis.getVoices();
                console.log("Voices loaded:", cachedVoices);
                resolve();
            });
        });
    } else {
        console.log("Voices loaded immediately:", cachedVoices);
    }

    return cachedVoices;
}

/**
 * Filters available voices based on the selected language.
 * Applies prioritization and highlights high-quality voices.
 * @param {string} selectedLanguage - Language code (e.g., "en").
 * @returns {Promise<string>} - A Promise that resolves with HTML string of <option> elements.
 */
export async function filterVoicesByLanguage(selectedLanguage) {
    const voices = await populateVoices();

    if (voices.length === 0) {
        console.error("No voices available for filtering.");
        return '<option value="-1" disabled>No voices available</option>';
    }

    const prioritizedVoices = regionalVoicePriority[selectedLanguage + "-US"] || [];
    let options = [];

    voices.forEach((voice, index) => {
        if (excludedVoices.some(excluded => voice.name.includes(excluded))) {
            return; // Skip excluded voices
        }

        const isHighQuality = highQualityVoices.includes(voice.name);
        const isPrioritized = prioritizedVoices.includes(voice.name);

        const optionHTML = `<option value="${index}" ${isHighQuality ? 'selected' : ''}>${isHighQuality || isPrioritized ? '🌟 ' : ''}${voice.name} (${voice.lang})</option>`;
        options.push(optionHTML);
    });

    return `<option value="-1">Default Voice (Fallback)</option>` + options.join('');
}
