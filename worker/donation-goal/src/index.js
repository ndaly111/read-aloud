// Cloudflare Worker for verified aggregate Buy Me a Coffee support totals.
// Stores only transaction IDs, amounts, timestamps and refund status. No donor PII.
const ORIGINS = new Set(['https://read-aloud.com', 'https://www.read-aloud.com']);
const json = (body, status, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
});
function publicHeaders(request) {
  const origin = request.headers.get('Origin');
  return ORIGINS.has(origin) ? { 'access-control-allow-origin': origin, 'vary': 'Origin' } : {};
}
async function validSignature(body, secret, hex) {
  if (!secret || !/^[a-f0-9]{64}$/i.test(hex || '')) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, body));
  const actual = [...signature].map(b => b.toString(16).padStart(2, '0')).join('');
  let difference = 0;
  for (let i = 0; i < actual.length; i++) {
    difference |= actual.charCodeAt(i) ^ hex.toLowerCase().charCodeAt(i);
  }
  return difference === 0;
}
async function currentGoal(env, request) {
  const headers = publicHeaders(request);
  const targetDollars = Number(env.GOAL_USD);
  if (env.GOAL_DATA_VERIFIED !== 'true' || !env.DB ||
      !Number.isFinite(targetDollars) || targetDollars <= 0 ||
      !Number.isSafeInteger(Math.round(targetDollars * 100))) {
    return json({ ready: false }, 200, headers);
  }
  const today = new Date();
  const year = today.getUTCFullYear();
  const monthNum = today.getUTCMonth();
  const month = year + '-' + String(monthNum + 1).padStart(2, '0');
  const start = Date.UTC(year, monthNum, 1) / 1000;
  const end = Date.UTC(year, monthNum + 1, 1) / 1000;
  const useBaseline = env.BASELINE_MONTH === month;
  const baselineCents = useBaseline ? Number(env.BASELINE_CENTS || '0') : 0;
  const baselineThrough = useBaseline ? Number(env.BASELINE_THROUGH_UNIX || '0') : start - 1;
  if (!Number.isSafeInteger(baselineCents) || baselineCents < 0 ||
      !Number.isSafeInteger(baselineThrough) ||
      (useBaseline && (baselineThrough < start - 1 || baselineThrough > Date.now() / 1000))) {
    return json({ ready: false }, 200, headers);
  }
  const minEventTimestamp = Math.max(start - 1, baselineThrough);
  const row = await env.DB.prepare(
    'SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM donations ' +
    'WHERE created_at > ? AND created_at < ? AND refunded = 0'
  ).bind(minEventTimestamp, end).first();
  const raised = baselineCents + Number(row?.cents || 0);
  if (!Number.isSafeInteger(raised) || raised < 0) return json({ ready: false }, 200, headers);
  return json({
    ready: true, currency: 'USD',
    month_label: new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(today),
    goal_cents: Math.round(targetDollars * 100),
    raised_cents: raised,
    data_scope: 'verified_one_time_usd_donations',
    as_of: today.toISOString()
  }, 200, headers);
}
async function processWebhook(request, env) {
  if (!env.DB || !env.BMC_WEBHOOK_SECRET) return new Response('Not configured', { status: 503 });
  const body = await request.arrayBuffer();
  if (body.byteLength > 64000) return new Response('Too large', { status: 413 });
  if (!await validSignature(body, env.BMC_WEBHOOK_SECRET, request.headers.get('x-signature-sha256'))) {
    return new Response('Invalid signature', { status: 401 });
  }
  let event;
  try { event = JSON.parse(new TextDecoder().decode(body)); }
  catch (_) { return new Response('Invalid JSON', { status: 400 }); }
  // Test events cannot affect public donation totals.
  if (event.live_mode !== true) return new Response(null, { status: 204 });
  if (event.type !== 'donation.created' && event.type !== 'donation.refunded') {
    return new Response(null, { status: 204 });
  }
  const data = event.data || {};
  if (data.currency !== 'USD') {
    // Non-USD contributions must be reconciled manually; do not use false conversions.
    return new Response(null, { status: 204 });
  }
  const id = String(data.id ?? '');
  const created = Number(data.created_at || event.created);
  const cents = Math.round(Number(data.amount) * 100);
  if (!id || id.length > 128 || !Number.isSafeInteger(created) || created <= 0 ||
      !Number.isSafeInteger(cents) || cents < 0) {
    return new Response('Invalid donation', { status: 400 });
  }
  if (event.type === 'donation.created' && data.status !== 'succeeded') {
    return new Response(null, { status: 204 });
  }
  const refunded = event.type === 'donation.refunded' ||
    data.refunded === true || data.refunded === 'true';
  // Upsert is idempotent on BMC transaction ID, including retries/refunds out of order.
  await env.DB.prepare(
    'INSERT INTO donations (id, created_at, amount_cents, refunded) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET created_at=excluded.created_at, ' +
    'amount_cents=excluded.amount_cents, ' +
    'refunded=MAX(donations.refunded, excluded.refunded)'
  ).bind(id, created, cents, refunded ? 1 : 0).run();
  return new Response(null, { status: 204 });
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/goal') {
      if (request.method === 'OPTIONS') return new Response(null, {
        status: 204,
        headers: { ...publicHeaders(request), 'access-control-allow-methods': 'GET, OPTIONS' }
      });
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      try { return await currentGoal(env, request); }
      catch (_) { return json({ ready: false }, 503, publicHeaders(request)); }
    }
    if (url.pathname === '/webhook' && request.method === 'POST') {
      try { return await processWebhook(request, env); }
      catch (_) { return new Response('Temporary error', { status: 503 }); }
    }
    return new Response('Not found', { status: 404 });
  }
};