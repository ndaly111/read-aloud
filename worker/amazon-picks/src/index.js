// Cloudflare Worker for the homepage "Worth a look" Amazon picks strip.
//   GET  /picks   - the picks scheduled for this UTC hour, with API-fetched title/image/price
//                   when Amazon has let us have them.
//   POST /event   - aggregate view/click counters per hour and pick. No identifiers.
//   GET  /status  - operator view: last catalog refresh, active/bench pool, last rotation.
//   cron 6-hourly - refreshes product facts from the Amazon Creators API.
//   cron weekly   - rotatePool(): benches active picks nobody clicks, promotes bench picks.
// Stores product facts and counts only. Nothing about visitors is ever recorded.
import { CATALOG, ACTIVE_SIZE, hourIndex, scheduledPicks, pickUrl } from './catalog.js';

const ORIGINS = new Set(['https://read-aloud.com', 'https://www.read-aloud.com']);
const TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const GET_ITEMS_URL = 'https://creatorsapi.amazon/catalog/v1/getItems';
const MARKETPLACE = 'www.amazon.com';
// Amazon allows a displayed price only when it was fetched within the last 24 hours.
const PRICE_MAX_AGE_S = 24 * 3600;
const DISCLOSURE = 'As an Amazon Associate I earn from qualifying purchases.';
const ROTATE_CRON = '7 6 * * 1';

// Weekly pool rotation - the readable rules:
//   - A pick is judged on the last 7 days only, and only if it was seen at least MIN_VIEWS
//     times in that week (otherwise it is not judged and stays).
//   - The ROTATE_N judged picks with the lowest click-through rate are benched, but only if
//     their rate is under RETIRE_BELOW x the median of the judged picks - when everything
//     performs alike, nothing is swapped.
//   - Benched picks go to the back of the bench and can return later. keep:true picks are
//     never benched. The bench picks that have waited longest are promoted.
const ROTATE_N = 3;
const MIN_VIEWS = 200;
const RETIRE_BELOW = 0.6;

const json = (body, status, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
});
function publicHeaders(request) {
  const origin = request.headers.get('Origin');
  return ORIGINS.has(origin) ? { 'access-control-allow-origin': origin, 'vary': 'Origin' } : {};
}
const byId = new Map(CATALOG.map(p => [p.id, p]));

// The active picks, in a stable order. Catalog entries the pool table has never seen are
// added to it (the first ACTIVE_SIZE ever seen become active, later ones join the bench).
async function activePicks(env) {
  if (!env.DB) return CATALOG.slice(0, ACTIVE_SIZE);
  const read = async () => (await env.DB.prepare('SELECT id, status, since FROM pick_pool').all()).results || [];
  let rows = await read();
  const known = new Set(rows.map(r => r.id));
  const missing = CATALOG.filter(p => !known.has(p.id));
  if (missing.length) {
    let activeCount = rows.filter(r => r.status === 'active').length;
    const now = Math.floor(Date.now() / 1000);
    await env.DB.batch(missing.map((p, i) => env.DB.prepare(
      'INSERT OR IGNORE INTO pick_pool (id, status, since) VALUES (?, ?, ?)'
    ).bind(p.id, activeCount++ < ACTIVE_SIZE ? 'active' : 'bench', now + i)));
    rows = await read();
  }
  const active = rows.filter(r => r.status === 'active' && byId.has(r.id))
    .sort((a, b) => a.since - b.since || (a.id < b.id ? -1 : 1)).map(r => byId.get(r.id));
  return active.length ? active : CATALOG.slice(0, ACTIVE_SIZE);
}

async function currentPicks(env, request) {
  const headers = { ...publicHeaders(request), 'cache-control': 'public, max-age=300' };
  if (env.PICKS_ENABLED !== 'true' || !env.PARTNER_TAG) return json({ ready: false }, 200, headers);
  const now = Date.now();
  const picks = scheduledPicks(now, await activePicks(env));
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
  const active = await activePicks(env);
  const allowed = new Set([...scheduledPicks(now, active), ...scheduledPicks(now - 3600000, active)].map(p => p.id));
  if (!allowed.has(body.pick)) return new Response(null, { status: 204, headers });
  await env.DB.prepare(
    'INSERT INTO pick_events (hour, pick, event, count) VALUES (?, ?, ?, 1) ' +
    'ON CONFLICT(hour, pick, event) DO UPDATE SET count = pick_events.count + 1'
  ).bind(hourIndex(now), body.pick, body.event).run();
  return new Response(null, { status: 204, headers });
}

// ---- weekly pool rotation ---------------------------------------------------------------
async function weekStats(env, sinceHour) {
  const rows = (await env.DB.prepare(
    'SELECT pick, event, SUM(count) AS n FROM pick_events WHERE hour >= ? GROUP BY pick, event'
  ).bind(sinceHour).all()).results || [];
  const stats = {};
  for (const r of rows) {
    stats[r.pick] ||= { views: 0, clicks: 0 };
    stats[r.pick][r.event === 'click' ? 'clicks' : 'views'] += Number(r.n);
  }
  return stats;
}

async function rotatePool(env) {
  if (!env.DB) return;
  const nowS = Math.floor(Date.now() / 1000);
  const log = (status, detail) => env.DB.prepare(
    'INSERT INTO pick_rotations (ran_at, status, detail) VALUES (?, ?, ?)'
  ).bind(nowS, status, detail || null).run();
  const active = await activePicks(env);
  const stats = await weekStats(env, hourIndex(Date.now()) - 7 * 24);
  const judged = active.filter(p => !p.keep)
    .map(p => ({ id: p.id, ...(stats[p.id] || { views: 0, clicks: 0 }) }))
    .filter(s => s.views >= MIN_VIEWS)
    .map(s => ({ ...s, ctr: s.clicks / s.views }))
    .sort((a, b) => a.ctr - b.ctr);
  if (!judged.length) { await log('skipped', 'no active pick reached ' + MIN_VIEWS + ' views this week'); return; }
  const median = judged[Math.floor(judged.length / 2)].ctr;
  const retire = judged.filter(s => s.ctr < median * RETIRE_BELOW).slice(0, ROTATE_N);
  const bench = ((await env.DB.prepare(
    "SELECT id FROM pick_pool WHERE status = 'bench' ORDER BY since ASC, id ASC"
  ).all()).results || []).map(r => r.id).filter(id => byId.has(id));
  const swaps = Math.min(retire.length, bench.length);
  if (!swaps) {
    await log('no_change', JSON.stringify({ judged: judged.length, median_ctr: median, below_bar: retire.length, bench: bench.length }));
    return;
  }
  const stmts = [];
  for (let i = 0; i < swaps; i++) {
    stmts.push(env.DB.prepare("UPDATE pick_pool SET status = 'bench', since = ? WHERE id = ?").bind(nowS + i, retire[i].id));
    stmts.push(env.DB.prepare("UPDATE pick_pool SET status = 'active', since = ? WHERE id = ?").bind(nowS + i, bench[i]));
  }
  await env.DB.batch(stmts);
  await log('rotated', JSON.stringify({
    median_ctr: median,
    retired: retire.slice(0, swaps).map(s => ({ id: s.id, views: s.views, clicks: s.clicks })),
    promoted: bench.slice(0, swaps)
  }));
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
  const asins = (await activePicks(env)).filter(p => p.kind === 'asin').map(p => p.asin);
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

async function status(env) {
  if (!env.DB) return json({ refresh: null }, 503);
  const refresh = await env.DB.prepare('SELECT ran_at, status, detail FROM pick_refresh WHERE id = 1').first();
  const active = await activePicks(env);
  const bench = ((await env.DB.prepare("SELECT id FROM pick_pool WHERE status = 'bench' ORDER BY since ASC, id ASC").all()).results || [])
    .map(r => r.id).filter(id => byId.has(id));
  const stats = await weekStats(env, hourIndex(Date.now()) - 7 * 24);
  const rotation = await env.DB.prepare('SELECT ran_at, status, detail FROM pick_rotations ORDER BY ran_at DESC LIMIT 1').first();
  return json({
    refresh: refresh || null,
    rules: { active_size: ACTIVE_SIZE, rotate_n: ROTATE_N, min_views: MIN_VIEWS, retire_below_median: RETIRE_BELOW, cron: ROTATE_CRON },
    active: active.map(p => ({ id: p.id, keep: !!p.keep, week: stats[p.id] || { views: 0, clicks: 0 } })),
    bench,
    last_rotation: rotation || null
  }, 200, { 'cache-control': 'no-store' });
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
      // Operator check. No secrets, no visitor data.
      try { return await status(env); }
      catch (err) { return json({ error: String(err.message) }, 503); }
    }
    return new Response('Not found', { status: 404 });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(event.cron === ROTATE_CRON ? rotatePool(env) : refreshCatalog(env));
  }
};
