/* ============ readaloud.js  ============ */
/*  Web Speech first → meSpeak fallback   */

(() => {
  // ------- small helpers -------
  const $ = (q) => document.querySelector(q);
  const sliceSize = 900;                             // Chrome length guard
  const defaultRate = 1.0;                           // 1× speed
  const voicesReady =
    "speechSynthesis" in window
      ? new Promise((res) => {
          let id = setInterval(() => {
            if (speechSynthesis.getVoices().length) {
              clearInterval(id);
              res();
            } else {
              speechSynthesis.getVoices();           // kick-start on Safari
            }
          }, 50);
        })
      : Promise.resolve();

  // -------- public API ---------
  window.readAloud = async function (text, opts = {}) {
    if (!text || !text.trim()) return;

    await voicesReady;                               // wait for OS voices

    const rate = opts.rate || defaultRate;

    /* 1️⃣  PRIMARY: Web Speech API present & at least one voice */
    if ("speechSynthesis" in window &&
        speechSynthesis.getVoices().length) {
      speakWithWebSpeech(text, rate);
      return;
    }

    /* 2️⃣  FALLBACK: meSpeak.js has been loaded */
    if (window.mespeak) {
      speakWithMeSpeak(text, rate);
      return;
    }

    alert("Sorry — this browser cannot speak and no fallback is available.");
  };

  // -------- Implementation details --------
  function speakWithWebSpeech(text, rate) {
    stop();                                         // cancel any prior run
    const chunks = chunk(text);
    const vo = speechSynthesis.getVoices().find(v => v.lang.startsWith("en")) ||
               speechSynthesis.getVoices()[0];
    next();
    function next() {
      if (!chunks.length) return;
      const u = new SpeechSynthesisUtterance(chunks.shift());
      if (vo) u.voice = vo;
      u.rate = rate;
      u.onend = next;
      speechSynthesis.speak(u);
    }
  }

  function speakWithMeSpeak(text, rate) {
    stop();
    const chunks = chunk(text);
    next();
    function next() {
      if (!chunks.length) return;
      mespeak.speak(chunks.shift(), { speed: 175 * rate }, next);
    }
  }

  function chunk(t) {
    const out = [];
    while (t.length) out.push(t.slice(0, sliceSize)), (t = t.slice(sliceSize));
    return out;
  }

  window.readAloudStop = stop;
  function stop() {
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    if (window.mespeak) mespeak.stop && mespeak.stop();
  }
})();
