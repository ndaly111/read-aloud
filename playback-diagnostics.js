// Operational events only. No text, email, raw errors, full UA, cookies or storage.
// Optional and fire-and-forget: playback never awaits this module or its requests.
(() => {
  const ENDPOINT = 'https://tts.read-aloud.com/api/diagnostics';
  const BUILD = '20261010diag2';
  const CODES = /^(|unknown|timeout|abort|network|invalid-response|invalid-audio|audio-too-small|incomplete-audio|wrong-engine|not-allowed|interrupted|canceled|synthesis-failed|synthesis-unavailable|audio-busy|audio-hardware|language-unavailable|voice-unavailable|invalid-argument|text-too-long|audio-[1-4]|http-[1-5][0-9]{2})$/;
  const EVENTS = new Set(['start', 'heartbeat', 'visibility', 'playing', 'unexpected_pause',
    'waiting', 'stalled', 'audio_error', 'play_rejected', 'voice_error', 'speech_restart',
    'fetch_error', 'fetch_recovered', 'reading_error', 'user_pause', 'user_resume', 'stop', 'finish']);
  const critical = new Set(['unexpected_pause', 'audio_error', 'play_rejected', 'voice_error',
    'speech_restart', 'fetch_error', 'fetch_recovered', 'reading_error', 'stop', 'finish']);
  const bound = (n, max, fallback = 0) => Number.isFinite(+n) ? Math.max(0, Math.min(max, Math.round(+n))) : fallback;
  let session = null;
  let timer = null;

  function device() {
    const ua = navigator.userAgent || '';
    const choices = [['Samsung', /SamsungBrowser\/(\d+)/], ['Edge', /Edg(?:A|iOS)?\/(\d+)/],
      ['Firefox', /(?:Firefox|FxiOS)\/(\d+)/], ['Chrome', /(?:Chrome|CriOS)\/(\d+)/],
      ['Safari', /Version\/(\d+).*Safari/]];
    const match = choices.map(([name, re]) => [name, ua.match(re)]).find(([, m]) => m);
    const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ||
      (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iOS' :
      /Windows/.test(ua) ? 'Windows' : /Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'other';
    return { browser: match ? match[0] : 'other', browser_major: match ? bound(match[1][1], 999) : 0, os };
  }

  function record(event, code = '', readingId, details = {}) {
    try {
      const s = session;
      if (!s || !s.active || !EVENTS.has(event) || (readingId && readingId !== s.id)) return;
      const now = Date.now();
      // Reserve 20 slots for failures/end events after periodic samples stop.
      if (s.seq >= 80 || (s.seq >= 60 && !critical.has(event))) return;
      // Retries can finish within five seconds. Distinguish individual attempts
      // so four server attempts do not collapse into a single "unknown" event.
      const endpoint = ['primary', 'render'].includes(details.endpoint) ? details.endpoint : '';
      const requestId = bound(details.request_id, 1000000);
      const attempt = bound(details.attempt, 4);
      const key = [event, code, endpoint, requestId, attempt].join(':');
      if (s.seen.has(key) && now - s.seen.get(key) < 5000) return;
      const state = s.snapshot();
      s.seen.set(key, now);
      const payload = {
        reading_id: s.id, seq: ++s.seq, event,
        elapsed_ms: bound(now - s.started, 86400000), build: BUILD, reader_build: s.readerBuild,
        source: s.source, voice: s.voice, language: s.language, ...s.device,
        position: bound(state.position, 10000000), total_chars: bound(state.total_chars, 10000000),
        segment: Number.isInteger(state.segment) ? Math.max(-1, Math.min(100000, state.segment)) : -1,
        media_time_ms: bound(state.media_time_ms, 86400000),
        media_duration_ms: bound(state.media_duration_ms, 86400000),
        media_paused: !!state.media_paused, media_muted: !!state.media_muted,
        speaking: !!state.speaking, paused: !!state.paused,
        speech_speaking: !!state.speech_speaking, speech_pending: !!state.speech_pending,
        speech_paused: !!state.speech_paused,
        visibility: document.visibilityState === 'hidden' ? 'hidden' : 'visible',
        online: navigator.onLine !== false,
        rate: Math.max(0.1, Math.min(10, +state.rate || 1)),
        volume: Math.max(0, Math.min(1, Number.isFinite(+state.volume) ? +state.volume : 1)),
        code: CODES.test(code) ? code : 'unknown',
        endpoint, request_id: requestId, attempt,
        request_start: Number.isInteger(details.request_start) ? Math.max(-1, Math.min(10000000, details.request_start)) : -1,
        request_chars: bound(details.request_chars, 10000),
        request_ms: bound(details.request_ms, 120000),
        http_status: bound(details.http_status, 599),
        stage: ['network', 'response', 'decode', 'validation', 'complete'].includes(details.stage) ? details.stage : '',
        audio_bytes: bound(details.audio_bytes, 50000000),
        expected_chars: bound(details.expected_chars, 10000),
        returned_chars: Number.isInteger(details.returned_chars) ? Math.max(-1, Math.min(10000, details.returned_chars)) : -1,
      };
      const options = { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), keepalive: true, credentials: 'omit', referrerPolicy: 'no-referrer' };
      if (globalThis.AbortSignal?.timeout) options.signal = AbortSignal.timeout(5000);
      Promise.resolve(fetch(ENDPOINT, options)).catch(() => {});
    } catch (_) { /* Observability must never interrupt the reader. */ }
  }

  globalThis.readerDiagnostics = {
    begin(source, voice, language, snapshot, readerBuild = '') {
      try {
        clearInterval(timer);
        session = { id: crypto.randomUUID(), started: Date.now(), seq: 0, active: true,
          source, voice: source === 'premium' ? voice : 'device', language,
          snapshot, readerBuild: /^[0-9]{8}[a-z0-9-]{0,20}$/.test(readerBuild) ? readerBuild : '',
          device: device(), seen: new Map() };
        record('start');
        timer = setInterval(() => record('heartbeat'), 15000);
      } catch (_) { session = null; }
    },
    record,
    end(event = 'stop') {
      record(event);
      if (session) session.active = false;
      clearInterval(timer);
      timer = null;
    },
    // Only the current reading's requests carry its ID; downloads after Stop
    // must not be mistaken for playback. No ID survives a page reload.
    headers() { return session?.active ? { 'X-Reading-ID': session.id } : {}; },
    readingId() { return session?.id || ''; },
  };
  document.addEventListener('visibilitychange', () => record('visibility'));
  globalThis.addEventListener('pagehide', () => globalThis.readerDiagnostics.end('stop'));
})();
