/* "Worth a look" strip: three Amazon picks, rotated by UTC hour by the Worker so everyone
   sees the same three during an hour. Counts views and clicks per pick in aggregate only. */
(() => {
  'use strict';
  const ORIGIN = 'https://read-aloud-amazon-picks.ndaly111.workers.dev';
  const strip = document.getElementById('amazonPicks');
  if (!strip) return;

  // Which kind of page the strip sits on: the homepage or one of the guides. A two-value
  // label for counting traffic per page type; never the URL or anything about the visitor.
  const SURFACE = /^\/(index\.html)?$/.test(location.pathname) ? 'home' : 'guide';

  function send(pick, event, photo, variant) {
    // Aggregate counter only: pick id, event name, which stock photo, page type. No identifiers.
    const body = JSON.stringify({ pick, event, photo: photo || 0, variant: variant || '', surface: SURFACE });
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

  // Amazon requires a date/time stamp next to any price it supplies.
  function priceStamp(iso) {
    const when = new Date(iso);
    if (Number.isNaN(when.getTime())) return null;
    return 'as of ' + when.toLocaleString('en-US', { month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  }

  // Ad-style card: photo, product name, one-line hook, price when Amazon supplies one,
  // and a button naming Amazon as the destination. The whole card is the link.
  function card(item) {
    const a = el('a', 'pick-card');
    a.href = item.url;
    a.target = '_blank';
    a.rel = 'noopener sponsored';
    a.addEventListener('click', () => send(item.id, 'click', item.photo, item.variant));
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
    const stamp = item.price && item.price_as_of ? priceStamp(item.price_as_of) : null;
    // A price without its time stamp is never shown.
    if (stamp) {
      const price = el('span', 'pick-card__price', item.price);
      price.appendChild(el('small', 'pick-card__stamp', stamp));
      body.appendChild(price);
    }
    // A wording test may supply its own button text; every version names Amazon.
    body.appendChild(el('span', 'pick-card__btn', item.button || 'See it on Amazon'));
    a.appendChild(body);
    return a;
  }

  function render(data) {
    const row = strip.querySelector('.picks-row');
    const note = strip.querySelector('.picks-disclosure');
    if (!row || !note || !data || data.ready !== true || !Array.isArray(data.items) || !data.items.length) return;
    const cards = data.items.map(card);
    row.replaceChildren(...cards);
    note.textContent = data.disclosure;
    // Dated heading from the Worker (e.g. "Gifts worth a look." 11/19-12/20); same style,
    // last words in the italic accent. Without one the page's own heading stays.
    const h = strip.querySelector('.picks-heading');
    if (h && data.heading && data.heading.lead && data.heading.em) {
      h.replaceChildren(document.createTextNode(data.heading.lead + ' '), el('em', '', data.heading.em));
    }
    strip.hidden = false;
    // Count a view per card, once, when at least half of that card is on screen (since 11/11).
    // Before 11/11 one view per card was counted when half the whole strip was on screen, which
    // on phones (three stacked cards, ~2x the screen height) meant scrolling past card 2.
    if (!('IntersectionObserver' in window)) {
      data.items.forEach(item => send(item.id, 'view', item.photo, item.variant));
      return;
    }
    const io = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        const item = data.items[cards.indexOf(e.target)];
        if (item) send(item.id, 'view', item.photo, item.variant);
      }
    }, { threshold: 0.5 });
    cards.forEach(c => io.observe(c));
  }

  fetch(ORIGIN + '/picks', { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' })
    .then(r => (r.ok ? r.json() : null))
    .then(render)
    .catch(() => {});
})();
