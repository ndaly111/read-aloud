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

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // Ad-style card: photo, product name, one-line hook, price when Amazon supplies one,
  // and a Shop now button. The whole card is the link.
  function card(item) {
    const a = el('a', 'pick-card');
    a.href = item.url;
    a.target = '_blank';
    a.rel = 'noopener sponsored';
    a.addEventListener('click', () => send(item.id, 'click'));
    if (item.image) {
      // Amazon's product shots sit on white and are shown whole; our stock photos fill the frame.
      const frame = el('span', 'pick-card__frame' + (item.image_kind === 'product' ? ' pick-card__frame--product' : ''));
      const img = el('img', 'pick-card__img');
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
    const body = el('span', 'pick-card__body');
    body.appendChild(el('span', 'pick-card__title', item.title));
    body.appendChild(el('span', 'pick-card__hook', item.hook));
    if (item.price) body.appendChild(el('span', 'pick-card__price', item.price));
    body.appendChild(el('span', 'pick-card__btn', 'Shop now'));
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
