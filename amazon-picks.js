/* "Worth a look" strip: three Amazon picks, rotated by UTC hour by the Worker so everyone
   sees the same three during an hour. Counts views and clicks per pick in aggregate only. */
(() => {
  'use strict';
  const ORIGIN = 'https://read-aloud-amazon-picks.ndaly111.workers.dev';
  const strip = document.getElementById('amazonPicks');
  if (!strip) return;

  function send(pick, event) {
    // Aggregate counter only: pick id + event name. No identifiers, no page content.
    const body = JSON.stringify({ pick, event });
    try {
      // text/plain keeps the beacon a CORS "simple" request (see donation-experiment.js).
      if (navigator.sendBeacon && navigator.sendBeacon(ORIGIN + '/event',
        new Blob([body], { type: 'text/plain' }))) return;
      fetch(ORIGIN + '/event', { method: 'POST', body, mode: 'cors', credentials: 'omit',
        keepalive: true, referrerPolicy: 'no-referrer',
        headers: { 'content-type': 'application/json' } }).catch(() => {});
    } catch (_) {}
  }

  function card(item) {
    const a = document.createElement('a');
    a.className = 'pick-card';
    a.href = item.url;
    a.target = '_blank';
    a.rel = 'noopener sponsored';
    a.addEventListener('click', () => send(item.id, 'click'));
    if (item.image) {
      const frame = document.createElement('span');
      frame.className = 'pick-card__frame';
      const img = document.createElement('img');
      img.className = 'pick-card__img';
      img.src = item.image;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.width = 640;
      img.height = 400;
      // A photo that fails to load leaves a text card rather than a broken image.
      img.addEventListener('error', () => frame.remove());
      frame.appendChild(img);
      a.appendChild(frame);
    }
    const body = document.createElement('span');
    body.className = 'pick-card__body';
    const hook = document.createElement('span');
    hook.className = 'pick-card__hook';
    hook.textContent = item.hook;
    const meta = document.createElement('span');
    meta.className = 'pick-card__meta';
    meta.textContent = item.title + (item.price ? ' · ' + item.price : '') + ' · See it on Amazon';
    body.append(hook, meta);
    a.appendChild(body);
    return a;
  }

  function render(data) {
    const row = strip.querySelector('.picks-row');
    const note = strip.querySelector('.picks-disclosure');
    if (!row || !note || !data || data.ready !== true || !Array.isArray(data.items) || !data.items.length) return;
    row.replaceChildren(...data.items.map(card));
    note.textContent = data.disclosure;
    strip.hidden = false;
    const seen = () => data.items.forEach(item => send(item.id, 'view'));
    // Count a view only when the strip actually comes into view.
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver(entries => {
        if (entries.some(e => e.isIntersecting)) { io.disconnect(); seen(); }
      }, { threshold: 0.5 });
      io.observe(strip);
    } else seen();
  }

  fetch(ORIGIN + '/picks', { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' })
    .then(r => (r.ok ? r.json() : null))
    .then(render)
    .catch(() => {});
})();
