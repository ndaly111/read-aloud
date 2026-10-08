// Real SQLite queries and signed fixtures matching the published BMC schema.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHmac } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { review, fisherExact } = require('./review_donation_experiment');
const root = path.join(__dirname, '..');

(async () => {
  const source = fs.readFileSync(path.join(root, 'worker/donation-goal/src/index.js'), 'utf8');
  const worker = (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).default;
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(root, 'worker/donation-goal/schema.sql'), 'utf8'));
  const DB = { prepare(sql) { return { bind(...args) { return {
    async first() { return db.prepare(sql).get(...args); },
    async run() { return { meta: db.prepare(sql).run(...args) }; },
  }; } }; } };
  const now = new Date(), created = Math.floor(Date.now() / 1000) - 60;
  const env = { DB, BMC_WEBHOOK_SECRET: 'test-only-secret', GOAL_USD: '100',
    GOAL_DATA_VERIFIED: 'true', GOAL_VERIFIED_MONTH: now.toISOString().slice(0, 7),
    EXPERIMENT_ENABLED: 'true', ATTRIBUTION_VERIFIED: 'true',
    EXPERIMENT_LAUNCH_UTC: new Date(Date.now() - 86400000).toISOString() };
  const goal = async (overrides = {}, origin = 'https://read-aloud.com') => worker.fetch(
    new Request('https://test.invalid/goal', { headers: { Origin: origin } }), { ...env, ...overrides });
  const event = (id, overrides = {}, type = 'donation.created') => ({
    event_id: id, type, live_mode: true, created, attempt: 1,
    data: { id, object: 'payment', amount: 5.25, currency: 'USD', status: 'succeeded',
      refunded: 'false', created_at: created, supporter_email: 'private@example.com',
      support_note: 'private donor message', ...overrides },
  });
  async function webhook(payload, signature) {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return worker.fetch(new Request('https://test.invalid/webhook', { method: 'POST', body,
      headers: { 'x-signature-sha256': signature ?? createHmac('sha256', env.BMC_WEBHOOK_SECRET).update(body).digest('hex') } }), env);
  }
  assert.equal((await webhook(event(1), 'wrong')).status, 401);
  assert.equal((await webhook({ ...event(1), live_mode: false })).status, 204);
  assert.equal((await webhook(event(1, { currency: 'EUR' }))).status, 204);
  assert.equal((await webhook(event(1, { status: 'pending' }))).status, 204);
  assert.equal((await webhook('null')).status, 400);
  for (const amount of [null, -1, 0, '5', 0.001]) assert.equal((await webhook(event(1, { amount }))).status, 400);
  assert.equal((await webhook(event(1, { created_at: undefined }, 'donation.refunded'))).status, 400);
  assert.equal((await webhook('x'.repeat(64001))).status, 413);
  assert.equal((await webhook(event(1))).status, 204);
  assert.equal((await webhook(event(1))).status, 204);
  assert.equal((await (await goal()).json()).raised_cents, 525);
  assert.equal((await webhook(event(1, { amount: 10 }))).status, 409);
  // An imported opening payment and its late refund use the same row.
  db.prepare('INSERT INTO donations VALUES (?, ?, ?, ?)').run('2', created, 1000, 0);
  assert.equal((await (await goal()).json()).raised_cents, 1525);
  assert.equal((await webhook(event(2, { amount: 10, status: 'refunded' }, 'donation.refunded'))).status, 204);
  assert.equal((await webhook(event(2, { amount: 10 }))).status, 204);
  assert.equal((await (await goal()).json()).raised_cents, 525);
  assert.equal((await webhook(event(3, { status: 'refunded' }, 'donation.refunded'))).status, 204);
  assert.equal((await webhook(event(3))).status, 204); // refund before creation remains refunded
  assert.equal((await (await goal()).json()).raised_cents, 525);
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000;
  db.prepare('INSERT INTO donations VALUES (?, ?, ?, ?)').run('4', start - 1, 10000, 0);
  db.prepare('INSERT INTO donations VALUES (?, ?, ?, ?)').run('5', start, 125, 0);
  assert.equal((await (await goal()).json()).raised_cents, 650);
  for (const overrides of [{ GOAL_DATA_VERIFIED: 'false' }, { GOAL_USD: '0.001' }, { GOAL_VERIFIED_MONTH: '2020-01' }, { DB: null }]) {
    assert.equal((await (await goal(overrides)).json()).ready, false);
  }
  for (const overrides of [{ ATTRIBUTION_VERIFIED: 'false' }, { EXPERIMENT_ENABLED: 'false' },
    { EXPERIMENT_LAUNCH_UTC: new Date(Date.now() - 42 * 86400000).toISOString() }]) {
    assert.equal((await (await goal(overrides)).json()).experiment_active, false);
  }
  const response = await goal();
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://read-aloud.com');
  assert.equal((await goal({}, 'https://untrusted.invalid')).headers.get('access-control-allow-origin'), null);
  assert(!JSON.stringify(db.prepare('SELECT * FROM donations').all()).includes('private'));
  assert(!JSON.stringify(await response.json()).includes('private'));
  assert(Math.abs(fisherExact(1, 9, 11, 3) - 0.0027594561852200836) < 1e-9);
  const input = { launch_at: '2026-10-01T12:00:00Z', review_at: '2026-10-15T12:00:00Z',
    attribution_verified: true, unique_counts_verified: true, guardrails_ok: true,
    weekday_weekend_represented: true,
    variants: { A: { exposed: 5000, clicks: 100, donors: 15, net_cents: 7500 },
      B: { exposed: 5000, clicks: 200, donors: 60, net_cents: 30000 } } };
  assert.equal(review(input).winner, 'B');
  assert.equal(review({ ...input, attribution_verified: false }).winner, null);
  assert.equal(review({ ...input, review_at: '2026-10-16T12:00:00Z' }).winner, null);
  assert.equal(review({ ...input, guardrails_ok: false }).decision, 'stop_for_guardrail');
  assert.equal(review({ ...input, attribution_verified: false, review_at: '2026-11-12T12:00:00Z' }).decision, 'inconclusive');
  assert.equal(review({ ...input, variants: { ...input.variants, A: { ...input.variants.A, donors: null, net_cents: null } } }).winner, null);
  db.close();
  console.log('Donation Worker, refund/retry ledger, activation gates and decision rules passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
