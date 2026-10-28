// Operational events only. No text, email, raw errors, full UA, cookies or storage.
// Optional and fire-and-forget: playback never awaits this module or its requests.
(() => {
  const ENDPOINT = 'https://tts.read-aloud.com/api/diagnostics';
  const BUILD = '20261028a';
  const CODES = /^(|unknown|no-progress|timeout|abort|network|invalid-response|invalid-audio|audio-too-small|incomplete-audio|wrong-engine|not-allowed|interrupted|canceled|synthesis-failed|synthesis-unavailable|audio-busy|audio-hardware|language-unavailable|voice-unavailable|invalid-argument|text-too-long|audio-[1-4]|http-[1-5][0-9]{2})$/;
  const EVENTS = new Set(['start', 'heartbeat', 'visibility', 'playing', 'unexpected_pause',
    'waiting', 'stalled', 'audio_error', 'play_rejected', 'voice_error', 'speech_restart',
    'fetch_error', 'fetch_recovered', 'reading_error', 'user_pause', 'user_resume', 'stop', 'finish',
    'loop_change', 'loop_gap_start', 'loop_gap_end', 'voice_change', 'language_change',
    'rate_change', 'volume_change', 'seek', 'export_start', 'export_finish', 'export_error',
    'runtime_error', 'unhandled_rejection', 'resource_error', 'no_progress', 'feedback', 'online', 'offline', 'page_exit']);
  const critical = new Set(['unexpected_pause', 'audio_error', 'play_rejected', 'voice_error',
    'speech_restart', 'fetch_error', 'fetch_recovered', 'reading_error', 'stop', 'finish']);
  const REPORT_KINDS = { runtime_error: 'uncaught-error', unhandled_rejection: 'unhandled-rejection',
    resource_error: 'resource-error', no_progress: 'no-progress', feedback: 'feedback', export_error: 'export-error',
    reading_error: 'playback-error', audio_error: 'playback-error', voice_error: 'playback-error',
    play_rejected: 'playback-error', stalled: 'playback-error', unexpected_pause: 'playback-error', fetch_error: 'playback-error' };
  Object.keys(REPORT_KINDS).forEach(event => critical.add(event));
  const afterReading = new Set(['runtime_error', 'unhandled_rejection', 'resource_error', 'feedback',
    'export_start', 'export_finish', 'export_error', 'voice_change', 'language_change', 'rate_change', 'volume_change', 'loop_change']);
  const ERROR_NAMES = new Set(['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError',
    'URIError', 'EvalError', 'DOMException', 'NotAllowedError', 'AbortError', 'NotSupportedError',
    'InvalidStateError', 'SecurityError', 'NetworkError', 'TimeoutError']);
  const FILES = new Set(['readaloud.js', 'playback-diagnostics.js', 'file-upload.js', 'index.html']);
  const PHASES = new Set(['idle', 'loading', 'playing', 'paused', 'loop-gap', 'ended', 'exporting']);
  const bound = (n, max, fallback = 0) => Number.isFinite(+n) ? Math.max(0, Math.min(max, Math.round(+n))) : fallback;
  let session = null;
  let timer = null;
  const pendingReports = [];
  let lastRetryAt = 0;

  function send(body, isReport, retry = false) {
    const failed = () => {
      if (isReport && !retry) {
        pendingReports.push(body);
        if (pendingReports.length > 4) pendingReports.shift();
      }
    };
    try {
      const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
        keepalive: true, credentials: 'omit', referrerPolicy: 'no-referrer' };
      if (globalThis.AbortSignal?.timeout) options.signal = AbortSignal.timeout(5000);
      Promise.resolve(fetch(ENDPOINT, options)).then(response => {
        if (response && !response.ok) failed();
      }).catch(failed);
    } catch (_) { failed(); }
  }
  function retryReports(force = false) {
    if (navigator.onLine === false || (!force && Date.now() - lastRetryAt < 30000)) return;
    lastRetryAt = Date.now();
    // Retry the exact sanitized report once. Never relabel it as a new reading.
    for (const body of pendingReports.splice(0)) send(body, true, true);
  }

  function snapshot(s) { try { return s.snapshot() || {}; } catch (_) { return {}; } }
  function ensureSession() {
    if (!session) session = { id: crypto.randomUUID(), started: Date.now(), seq: 0, active: false,
      source: 'page', voice: 'device', language: 'en', readerBuild: '', device: device(), seen: new Map(),
      breadcrumbs: [], snapshot: () => {
        try { return globalThis.playbackDiagnosticState?.() || {}; } catch (_) { return {}; }
      } };
    return session;
  }
  function frame(filename, line, column) {
    try {
      if (!filename) return null;
      const url = new URL(filename, location.href);
      const file = url.pathname.split('/').pop();
      if (url.origin !== location.origin || !FILES.has(file)) return null;
      return { file, line: bound(line, 1000000), column: bound(column, 1000000) };
    } catch (_) { return null; }
  }
  function errorDetails(error, filename, line, column) {
    const frames = [];
    const first = frame(filename, line, column);
    if (first) frames.push(first);
    // Never keep the message, function name, full URL/query or third-party frames.
    if (typeof error?.stack === 'string') {
      for (const match of error.stack.slice(0, 8192).matchAll(/(https?:\/\/[^\s)]+?):(\d+):(\d+)/g)) {
        const f = frame(match[1], match[2], match[3]);
        if (f && !frames.some(x => x.file === f.file && x.line === f.line && x.column === f.column)) frames.push(f);
        if (frames.length >= 6) break;
      }
    }
    return { error_name: ERROR_NAMES.has(error?.name) ? error.name : '', frames };
  }
  function heartbeat() {
    try {
      retryReports();
      const s = session;
      if (!s?.active) return;
      const state = snapshot(s);
      const progress = [state.position, bound(state.media_time_ms, 86400000), state.segment].join(':');
      if (s.lastProgress !== progress || state.paused || state.loop_gap_active ||
          document.visibilityState === 'hidden' || !state.speaking || !['loading', 'playing'].includes(state.phase)) {
        s.progressAt = Date.now(); s.lastProgress = progress;
      } else if (Date.now() - s.progressAt >= 90000) {
        record('no_progress', 'no-progress'); s.progressAt = Date.now();
      }
      record('heartbeat');
    } catch (_) {}
  }

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
      if (!EVENTS.has(event)) return;
      const s = session || (afterReading.has(event) ? ensureSession() : null);
      if (!s || (!s.active && !afterReading.has(event)) || (readingId && readingId !== s.id)) return;
      const now = Date.now();
      const state = snapshot(s);
      // Retries can finish within five seconds. Distinguish individual attempts
      // so four server attempts do not collapse into a single "unknown" event.
      const endpoint = ['primary', 'render'].includes(details.endpoint) ? details.endpoint : '';
      const requestId = bound(details.request_id, 1000000);
      const attempt = bound(details.attempt, 4);
      const action = /^(loop|voice|language|rate|volume)_change$/.test(event)
        ? [state.loop_on, state.loop_gap_sec, state.rate, state.volume, state.selected_voice, state.selected_language].join(':') : '';
      const key = [event, code, endpoint, requestId, attempt, action,
        ERROR_NAMES.has(details.error_name) ? details.error_name : '',
        ...(details.frames || []).slice(0, 6).map(f => FILES.has(f.file) ? `${f.file}:${bound(f.line, 1000000)}` : '')].join(':');
      if (s.seen.has(key) && now - s.seen.get(key) < 5000) return;
      // The ring continues after ordinary samples are capped, so a later report
      // still explains the actions immediately preceding the failure.
      if (event !== 'heartbeat') s.breadcrumbs.push({ event, elapsed_ms: bound(now - s.started, 86400000),
        position: bound(state.position, 10000000), segment: Number.isInteger(state.segment) ? Math.max(-1, Math.min(100000, state.segment)) : -1,
        phase: PHASES.has(state.phase) ? state.phase : 'idle', rate: Math.max(0.1, Math.min(10, +state.rate || 1)),
        loop_on: !!state.loop_on, loop_gap_sec: bound(state.loop_gap_sec, 600) });
      if (s.breadcrumbs.length > 12) s.breadcrumbs.shift();
      // Reserve 40 slots for failures/end events and one final feedback snapshot.
      if ((s.seq >= 100 && (event !== 'feedback' || s.feedbackSent)) || (s.seq >= 60 && !critical.has(event))) return;
      if (event === 'feedback') s.feedbackSent = true;
      s.seen.set(key, now);
      if (s.seen.size > 120) s.seen.delete(s.seen.keys().next().value);
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
        phase: PHASES.has(state.phase) ? state.phase : 'idle',
        selected_voice: /^[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9]{1,50}Neural$/.test(state.selected_voice) ? state.selected_voice : 'device',
        selected_language: /^[a-z]{2,3}$/.test(state.selected_language) ? state.selected_language : s.language,
        loop_on: !!state.loop_on, loop_gap_active: !!state.loop_gap_active,
        loop_gap_sec: bound(state.loop_gap_sec, 600), loop_remaining_ms: bound(state.loop_remaining_ms, 600000),
        segment_count: bound(state.segment_count, 100000), ready_state: bound(state.ready_state, 4), network_state: bound(state.network_state, 3),
        export_type: ['mp3', 'subtitles'].includes(details.export_type) ? details.export_type : '',
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
      if (REPORT_KINDS[event]) payload.report = { kind: REPORT_KINDS[event],
        error_name: ERROR_NAMES.has(details.error_name) ? details.error_name : '',
        frames: (Array.isArray(details.frames) ? details.frames : []).filter(f => FILES.has(f.file)).slice(0, 6)
          .map(f => ({ file: f.file, line: bound(f.line, 1000000), column: bound(f.column, 1000000) })),
        breadcrumbs: s.breadcrumbs.slice() };
      const body = JSON.stringify(payload);
      if (body.length > 8192) return;
      send(body, !!REPORT_KINDS[event]);
    } catch (_) { /* Observability must never interrupt the reader. */ }
  }

  globalThis.readerDiagnostics = {
    begin(source, voice, language, snapshot, readerBuild = '') {
      try {
        clearInterval(timer);
        session = { id: crypto.randomUUID(), started: Date.now(), seq: 0, active: true,
          source, voice: source === 'premium' ? voice : 'device', language,
          snapshot, readerBuild: /^[0-9]{8}[a-z0-9-]{0,20}$/.test(readerBuild) ? readerBuild : '',
          device: device(), seen: new Map(), breadcrumbs: [], lastProgress: null, progressAt: Date.now() };
        record('start');
        timer = setInterval(heartbeat, 15000);
      } catch (_) { session = null; }
    },
    record,
    capture(event, error, readingId, details = {}) {
      try { record(event, CODES.test(details.code) ? details.code : 'unknown', readingId,
        { ...details, ...errorDetails(error) }); } catch (_) {}
    },
    feedback() { retryReports(); record('feedback'); },
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
  globalThis.addEventListener('error', e => {
    try {
      if (e.target && e.target !== globalThis) {
        const f = frame(e.target.src || e.target.href, 0, 0);
        if (f) record('resource_error', 'unknown', undefined, { frames: [f] });
      } else {
        const details = errorDetails(e.error, e.filename, e.lineno, e.colno);
        if (details.frames.length) record('runtime_error', 'unknown', undefined, details);
      }
    } catch (_) {}
  }, true);
  globalThis.addEventListener('unhandledrejection', e => {
    try {
      const details = errorDetails(e.reason);
      if (details.frames.length || session?.active) record('unhandled_rejection', 'unknown', undefined, details);
    } catch (_) {}
  });
  document.addEventListener('visibilitychange', () => record('visibility'));
  globalThis.addEventListener('online', () => { retryReports(true); record('online'); });
  globalThis.addEventListener('offline', () => record('offline'));
  globalThis.addEventListener('pagehide', () => { retryReports(true); record('page_exit'); globalThis.readerDiagnostics.end('stop'); });
})();
