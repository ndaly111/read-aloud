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
  const goals = { B: Number(env.GOAL_B_USD) * 100, C: Number(env.GOAL_C_USD) * 100 };
  // Fixed owner-selected targets; changing them mid-test invalidates the design.
  if (env.GOAL_DATA_VERIFIED !== 'true' || !env.DB || goals.B !== 5000 || goals.C !== 10000) {
    return json({ ready: false }, 200, headers);
  }
  const today = new Date();
  const year = today.getUTCFullYear();
  const monthNum = today.getUTCMonth();
  const month = year + '-' + String(monthNum + 1).padStart(2, '0');
  const start = Date.UTC(year, monthNum, 1) / 1000;
  const end = Date.UTC(year, monthNum + 1, 1) / 1000;
  // Each opening ledger must be reconciled. A new month fails closed until verified.
  // Import individual payment facts rather than an aggregate balance so late refunds
  // and webhook retries can update the same transaction without double counting.
  if (env.GOAL_VERIFIED_MONTH !== month) {
    return json({ ready: false }, 200, headers);
  }
  const row = await env.DB.prepare(
    'SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM donations ' +
    'WHERE created_at >= ? AND created_at < ? AND refunded = 0'
  ).bind(start, Math.min(end, Math.floor(today.getTime() / 1000) + 1)).first();
  const raised = Number(row?.cents || 0);
  if (!Number.isSafeInteger(raised) || raised < 0) return json({ ready: false }, 200, headers);
  const launch = Date.parse(env.EXPERIMENT_LAUNCH_UTC || '');
  const active = env.EXPERIMENT_ENABLED === 'true' && env.ATTRIBUTION_VERIFIED === 'true' &&
    Number.isFinite(launch) && launch <= today.getTime() && today.getTime() - launch < 42 * 86400000;
  return json({
    ready: true, currency: 'USD',
    month_label: new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(today),
    goals_cents: goals,
    raised_cents: raised,
    data_scope: 'verified_one_time_usd_donations',
    experiment_id: 'support_goal_2026_10',
    experiment_active: active,
    launch_at: Number.isFinite(launch) ? new Date(launch).toISOString() : null,
    as_of: today.toISOString()
  }, 200, headers);
}
async function processWebhook(request, env) {
  if (!env.DB || !env.BMC_WEBHOOK_SECRET) return new Response('Not configured', { status: 503 });
  if (Number(request.headers.get('content-length')) > 64000) return new Response('Too large', { status: 413 });
  const reader = request.body?.getReader();
  if (!reader) return new Response('Invalid body', { status: 400 });
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 64000) {
      await reader.cancel();
      return new Response('Too large', { status: 413 });
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  if (body.byteLength > 64000) return new Response('Too large', { status: 413 });
  if (!await validSignature(body, env.BMC_WEBHOOK_SECRET, request.headers.get('x-signature-sha256'))) {
    return new Response('Invalid signature', { status: 401 });
  }
  let event;
  try { event = JSON.parse(new TextDecoder().decode(body)); }
  catch (_) { return new Response('Invalid JSON', { status: 400 }); }
  // Test events cannot affect public donation totals.
  if (!event || typeof event !== 'object' || Array.isArray(event)) return new Response('Invalid event', { status: 400 });
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
  const created = data.created_at;
  const cents = Math.round(data.amount * 100);
  if (!Number.isSafeInteger(data.id) || data.id <= 0 || !Number.isSafeInteger(created) || created <= 0 ||
      created > Math.floor(Date.now() / 1000) + 60 || typeof data.amount !== 'number' ||
      !Number.isSafeInteger(cents) || cents <= 0 ||
      Math.abs(data.amount * 100 - cents) > 0.000001) {
    return new Response('Invalid donation', { status: 400 });
  }
  if (event.type === 'donation.created' && data.status !== 'succeeded') {
    return new Response(null, { status: 204 });
  }
  const refunded = event.type === 'donation.refunded' || data.status === 'refunded' ||
    data.refunded === true || data.refunded === 'true';
  // Upsert is idempotent on BMC transaction ID, including retries/refunds out of order.
  const result = await env.DB.prepare(
    'INSERT INTO donations (id, created_at, amount_cents, refunded) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET refunded=MAX(donations.refunded, excluded.refunded) ' +
    'WHERE donations.created_at=excluded.created_at AND donations.amount_cents=excluded.amount_cents'
  ).bind(id, created, cents, refunded ? 1 : 0).run();
  if (result.meta?.changes === 0) return new Response('Payment conflict: reconcile ledger', { status: 409 });
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
