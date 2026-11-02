// Cloudflare Worker for the homepage "Worth a look" Amazon picks strip.
//   GET  /picks  - the picks scheduled for this UTC hour, with API-fetched title/image/price
//                  when Amazon has let us have them.
//   POST /event  - aggregate view/click counters per hour and pick. No identifiers.
//   cron         - refreshes product facts from the Amazon Creators API every 6 hours.
// Stores product facts and counts only. Nothing about visitors is ever recorded.
import { PICKS, hourIndex, scheduledPicks, pickUrl } from './catalog.js';

const ORIGINS = new Set(['https://read-aloud.com', 'https://www.read-aloud.com']);
const TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const GET_ITEMS_URL = 'https://creatorsapi.amazon/catalog/v1/getItems';
const MARKETPLACE = 'www.amazon.com';
// Amazon allows a displayed price only when it was fetched within the last 24 hours.
const PRICE_MAX_AGE_S = 24 * 3600;
const DISCLOSURE = 'As an Amazon Associate I earn from qualifying purchases.';

const json = (body, status, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
});
function publicHeaders(request) {
  const origin = request.headers.get('Origin');
  return ORIGINS.has(origin) ? { 'access-control-allow-origin': origin, 'vary': 'Origin' } : {};
}

async function currentPicks(env, request) {
  const headers = { ...publicHeaders(request), 'cache-control': 'public, max-age=300' };
  if (env.PICKS_ENABLED !== 'true' || !env.PARTNER_TAG) return json({ ready: false }, 200, headers);
  const now = Date.now();
  const picks = scheduledPicks(now);
  const facts = new Map();
  if (env.DB) {
    const asins = picks.filter(p => p.kind === 'asin').map(p => p.asin);
    if (asins.length) {
      const rows = await env.DB.prepare(
        'SELECT asin, title, image, price, url, updated_at FROM pick_items WHERE asin IN (' +
        asins.map(() => '?').join(',') + ')').bind(...asins).all();
      for (const row of rows.results || []) facts.set(row.asin, row);
    }
  }
  const nowS = Math.floor(now / 1000);
  const items = picks.map(pick => {
    const fact = pick.kind === 'asin' ? facts.get(pick.asin) : null;
    const fresh = fact && nowS - fact.updated_at <= PRICE_MAX_AGE_S;
    return {
      id: pick.id,
      title: pick.title,
      hook: pick.hook,
      // The API's own tagged detail URL when we have it; our tagged link otherwise.
      url: (fact && fact.url) || pickUrl(pick, env.PARTNER_TAG),
      image: (fact && fact.image) || null,
      // Stale prices are withheld rather than shown wrong.
      price: fresh && fact.price ? fact.price : null,
      price_as_of: fresh && fact.price ? new Date(fact.updated_at * 1000).toISOString() : null
    };
  });
  return json({
    ready: true, hour: hourIndex(now), disclosure: DISCLOSURE, items, as_of: new Date(now).toISOString()
  }, 200, headers);
}

const EVENT_NAMES = new Set(['view', 'click']);
async function recordEvent(request, env) {
  const headers = publicHeaders(request);
  if (!headers['access-control-allow-origin']) return new Response('Forbidden', { status: 403 });
  if (!env.DB) return new Response('Not configured', { status: 503 });
  if (Number(request.headers.get('content-length')) > 256) return new Response('Too large', { status: 413 });
  let body;
  try { body = await request.json(); }
  catch (_) { return new Response('Invalid JSON', { status: 400 }); }
  if (!body || typeof body !== 'object' || typeof body.pick !== 'string' || !EVENT_NAMES.has(body.event)) {
    return new Response('Invalid event', { status: 400, headers });
  }
  const now = Date.now();
  // Only a pick on screen this hour or last hour (a page opened before the hour turned) counts.
  const allowed = new Set([...scheduledPicks(now), ...scheduledPicks(now - 3600000)].map(p => p.id));
  if (!allowed.has(body.pick)) return new Response(null, { status: 204, headers });
  await env.DB.prepare(
    'INSERT INTO pick_events (hour, pick, event, count) VALUES (?, ?, ?, 1) ' +
    'ON CONFLICT(hour, pick, event) DO UPDATE SET count = pick_events.count + 1'
  ).bind(hourIndex(now), body.pick, body.event).run();
  return new Response(null, { status: 204, headers });
}

// ---- Amazon Creators API refresh --------------------------------------------------------
async function accessToken(env) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials', scope: 'creatorsapi::default',
      client_id: env.CREATORS_ID, client_secret: env.CREATORS_SECRET
    })
  });
  if (!res.ok) throw new Error('token ' + res.status);
  const data = await res.json();
  if (!data.access_token) throw new Error('token missing');
  return data.access_token;
}

// The API returns lowerCamelCase keys; older samples show PascalCase. Accept either.
const get = (obj, ...keys) => {
  let cur = obj;
  for (const key of keys) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[key] ?? cur[key.charAt(0).toUpperCase() + key.slice(1)];
  }
  return cur;
};

function parseItem(item) {
  const listings = get(item, 'offersV2', 'listings');
  const listing = Array.isArray(listings) ? listings[0] : null;
  const price = get(listing, 'price', 'money', 'displayAmount') || get(listing, 'price', 'displayAmount') || null;
  return {
    asin: get(item, 'asin'),
    title: get(item, 'itemInfo', 'title', 'displayValue') || null,
    image: get(item, 'images', 'primary', 'medium', 'url') || get(item, 'images', 'primary', 'large', 'url') || null,
    price: typeof price === 'string' ? price : null,
    url: get(item, 'detailPageURL') || null
  };
}

async function refreshCatalog(env) {
  const now = Math.floor(Date.now() / 1000);
  const note = (status, detail) => env.DB.prepare(
    'INSERT INTO pick_refresh (id, ran_at, status, detail) VALUES (1, ?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET ran_at = excluded.ran_at, status = excluded.status, detail = excluded.detail'
  ).bind(now, status, detail || null).run();
  if (!env.DB || !env.CREATORS_ID || !env.CREATORS_SECRET || !env.PARTNER_TAG) {
    if (env.DB) await note('not_configured');
    return;
  }
  const asins = PICKS.filter(p => p.kind === 'asin').map(p => p.asin);
  if (!asins.length) { await note('nothing_to_fetch'); return; }
  let token;
  try { token = await accessToken(env); }
  catch (err) { await note('token_failed', String(err.message)); return; }
  let updated = 0;
  for (let i = 0; i < asins.length; i += 10) {
    const batch = asins.slice(i, i + 10);
    const res = await fetch(GET_ITEMS_URL, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-marketplace': MARKETPLACE },
      body: JSON.stringify({
        itemIds: batch, partnerTag: env.PARTNER_TAG, partnerType: 'Associates', marketplace: MARKETPLACE,
        resources: ['images.primary.medium', 'images.primary.large', 'itemInfo.title',
          'offersV2.listings.price', 'offersV2.listings.availability']
      })
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      // 403 AssociateNotEligible: the account is under Amazon's sales bar for catalog data.
      // The strip keeps running on our own words; this just records why there are no photos.
      await note(res.status === 403 ? 'not_eligible' : 'http_' + res.status, text);
      return;
    }
    const data = await res.json();
    const items = get(data, 'itemsResult', 'items') || [];
    for (const raw of items) {
      const item = parseItem(raw);
      if (!item.asin) continue;
      await env.DB.prepare(
        'INSERT INTO pick_items (asin, title, image, price, url, updated_at) VALUES (?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(asin) DO UPDATE SET title = excluded.title, image = excluded.image, ' +
        'price = excluded.price, url = excluded.url, updated_at = excluded.updated_at'
      ).bind(item.asin, item.title, item.image, item.price, item.url, now).run();
      updated++;
    }
  }
  await note('ok', 'updated ' + updated + ' of ' + asins.length);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/picks') {
      if (request.method === 'OPTIONS') return new Response(null, {
        status: 204, headers: { ...publicHeaders(request), 'access-control-allow-methods': 'GET, OPTIONS' }
      });
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      try { return await currentPicks(env, request); }
      catch (_) { return json({ ready: false }, 503, publicHeaders(request)); }
    }
    if (url.pathname === '/event') {
      if (request.method === 'OPTIONS') return new Response(null, {
        status: 204, headers: { ...publicHeaders(request), 'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type' }
      });
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      // A counter failure must never affect the page.
      try { return await recordEvent(request, env); }
      catch (_) { return new Response(null, { status: 204, headers: publicHeaders(request) }); }
    }
    if (url.pathname === '/status' && request.method === 'GET') {
      // Operator check: last refresh outcome. No secrets, no visitor data.
      try {
        const row = env.DB ? await env.DB.prepare('SELECT ran_at, status, detail FROM pick_refresh WHERE id = 1').first() : null;
        return json({ refresh: row || null, picks: PICKS.length }, 200, { 'cache-control': 'no-store' });
      } catch (_) { return json({ refresh: null }, 503); }
    }
    return new Response('Not found', { status: 404 });
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refreshCatalog(env));
  }
};
