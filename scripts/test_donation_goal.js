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
  // Mirrors D1: a prepared statement can be run with or without bind().
  const DB = { prepare(sql) {
    const exec = args => ({
      async first() { return db.prepare(sql).get(...args); },
      async run() { return { meta: db.prepare(sql).run(...args) }; },
    });
    return { bind: (...args) => exec(args), ...exec([]) };
  } };
  const now = new Date(), created = Math.floor(Date.now() / 1000) - 60;
  const env = { DB, BMC_WEBHOOK_SECRET: 'test-only-secret', GOAL_B_USD: '50', GOAL_C_USD: '100',
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
  assert.deepEqual((await (await goal()).json()).goals_cents, { B: 5000, C: 10000 });
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
  assert.equal((await (await goal()).json()).totals_verified, true);
  for (const overrides of [{ GOAL_B_USD: '0.001' },
    { GOAL_B_USD: '100' }, { GOAL_C_USD: '50' }, { GOAL_C_USD: '' },
    { SUPPORT_ROLLOUT_VARIANT: 'D' }]) {
    assert.equal((await (await goal(overrides)).json()).ready, false);
  }
  // An unreconciled ledger publishes the TARGET only: no raised figure, test still runs.
  for (const overrides of [{ GOAL_DATA_VERIFIED: 'false' }, { GOAL_VERIFIED_MONTH: '2020-01' },
    { GOAL_VERIFIED_MONTH: '' }, { DB: null }]) {
    const unverified = await (await goal(overrides)).json();
    assert.equal(unverified.ready, true);
    assert.equal(unverified.totals_verified, false);
    assert.equal(unverified.raised_cents, null);
    assert.equal(unverified.experiment_active, true);
    assert.deepEqual(unverified.goals_cents, { B: 5000, C: 10000 });
  }
  // Donation attribution is a reporting label, never a launch gate.
  assert.equal((await (await goal({ ATTRIBUTION_VERIFIED: 'false' })).json()).experiment_active, true);
  for (const overrides of [{ EXPERIMENT_ENABLED: 'false' },
    { EXPERIMENT_LAUNCH_UTC: new Date(Date.now() - 42 * 86400000).toISOString() },
    { EXPERIMENT_LAUNCH_UTC: '' },
    { EXPERIMENT_LAUNCH_UTC: new Date(Date.now() + 86400000).toISOString() }]) {
    assert.equal((await (await goal(overrides)).json()).experiment_active, false);
  }
  assert.equal((await (await goal()).json()).rollout_variant, null);
  for (const variant of ['A', 'B', 'C']) {
    // Winner configuration ends allocation even if the old enable switch is on.
    const early = await (await goal({ SUPPORT_ROLLOUT_VARIANT: variant })).json();
    assert.equal(early.experiment_active, false);
    assert.equal(early.rollout_variant, variant);
    // The chosen appeal can remain in place after the six-week experiment expires.
    const later = await (await goal({ SUPPORT_ROLLOUT_VARIANT: variant,
      EXPERIMENT_LAUNCH_UTC: new Date(Date.now() - 50 * 86400000).toISOString() })).json();
    assert.equal(later.rollout_variant, variant);
    assert.equal(later.experiment_active, false);
  }
  const rolledOutUnverified = await (await goal({ SUPPORT_ROLLOUT_VARIANT: 'C', GOAL_DATA_VERIFIED: 'false' })).json();
  assert.equal(rolledOutUnverified.ready, true);
  assert.equal(rolledOutUnverified.totals_verified, false);
  assert.equal(rolledOutUnverified.raised_cents, null);
  const response = await goal();
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://read-aloud.com');
  assert.equal((await goal({}, 'https://untrusted.invalid')).headers.get('access-control-allow-origin'), null);
  assert(!JSON.stringify(db.prepare('SELECT * FROM donations').all()).includes('private'));
  assert(!JSON.stringify(await response.json()).includes('private'));
  // Own aggregate counter: only known experiment/variant/event triples are recorded.
  const post = (body, origin = 'https://read-aloud.com', overrides = {}) => worker.fetch(
    new Request('https://test.invalid/event', { method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { Origin: origin, 'content-type': 'application/json' } }), { ...env, ...overrides });
  const counted = (variant, event) => db.prepare(
    'SELECT count FROM experiment_events WHERE variant = ? AND event = ?').get(variant, event)?.count ?? 0;
  assert.equal((await post({ experiment_id: 'support_goal_2026_10', variant: 'B', event: 'view' })).status, 204);
  assert.equal((await post({ experiment_id: 'support_goal_2026_10', variant: 'B', event: 'view' })).status, 204);
  assert.equal((await post({ experiment_id: 'support_goal_2026_10', variant: 'B', event: 'click' })).status, 204);
  assert.equal(counted('B', 'view'), 2);
  assert.equal(counted('B', 'click'), 1);
  for (const bad of [{ experiment_id: 'other', variant: 'B', event: 'view' },
    { experiment_id: 'support_goal_2026_10', variant: 'D', event: 'view' },
    { experiment_id: 'support_goal_2026_10', variant: 'B', event: 'donate' },
    { experiment_id: 'support_goal_2026_10', variant: 'B' }, null, []]) {
    assert.equal((await post(bad)).status, 400);
  }
  assert.equal((await post('{')).status, 400);
  assert.equal((await post({ experiment_id: 'support_goal_2026_10', variant: 'B', event: 'view' },
    'https://untrusted.invalid')).status, 403);
  assert.equal((await post({ experiment_id: 'support_goal_2026_10', variant: 'B', event: 'view' },
    'https://read-aloud.com', { DB: null })).status, 503);
  assert.equal((await worker.fetch(new Request('https://test.invalid/event',
    { headers: { Origin: 'https://read-aloud.com' } }), env)).status, 405);
  assert.equal(counted('B', 'view'), 2);
  assert.equal(counted('D', 'view'), 0);
  // Counters hold no identifiers of any kind.
  assert.deepEqual(Object.keys(db.prepare('SELECT * FROM experiment_events LIMIT 1').get()),
    ['day', 'variant', 'event', 'count']);
  // A database that predates the counter table self-migrates on the first event.
  db.exec('DROP TABLE experiment_events');
  assert.equal((await post({ experiment_id: 'support_goal_2026_10', variant: 'C', event: 'click' })).status, 204);
  assert.equal(counted('C', 'click'), 1);
  assert.equal(counted('B', 'view'), 0);
  assert(Math.abs(fisherExact(1, 9, 11, 3) - 0.0027594561852200836) < 1e-9);
  const input = { launch_at: '2026-10-01T12:00:00Z', review_at: '2026-10-15T12:00:00Z',
    attribution_verified: true, unique_counts_verified: true, guardrails_ok: true,
    weekday_weekend_represented: true,
    variants: { A: { exposed: 5000, clicks: 100, donors: 15, net_cents: 7500 },
      B: { exposed: 5000, clicks: 200, donors: 60, net_cents: 30000 },
      C: { exposed: 5000, clicks: 150, donors: 20, net_cents: 10000 } } };
  assert.equal(review(input).winner, 'B');
  assert.equal(review(input).significance_threshold, 0.05 / 12);
  assert.equal(Object.keys(review(input).comparisons).length, 3);
  assert.equal(review({ ...input, variants: { ...input.variants, B: input.variants.C, C: input.variants.B } }).winner, 'C');
  assert.equal(review({ ...input, variants: { ...input.variants, A: input.variants.B, B: input.variants.A } }).winner, 'A');
  // Both goals can beat the control without either goal being a clear overall winner.
  assert.equal(review({ ...input, variants: { ...input.variants, C: input.variants.B } }).winner, null);
  assert.throws(() => review({ ...input, variants: { A: input.variants.A, B: input.variants.B } }), /C:/);
  assert.equal(review({ ...input, attribution_verified: false }).winner, null);
  // Click rate is the primary decision metric because BMC cannot attribute payments.
  const clicky = { ...input, attribution_verified: false,
    variants: { A: { exposed: 5000, clicks: 100, donors: null, net_cents: null },
      B: { exposed: 5000, clicks: 300, donors: null, net_cents: null },
      C: { exposed: 5000, clicks: 150, donors: null, net_cents: null } } };
  assert.equal(review(clicky).decision, 'click_rate_winner');
  assert.equal(review(clicky).winner, 'B');
  assert.equal(Object.keys(review(clicky).click_comparisons).length, 3);
  // Only a formal day 7/14/28/42 review can choose a winner.
  assert.equal(review({ ...clicky, review_at: '2026-10-16T12:00:00Z' }).winner, null);
  // Below the per-arm click floor nothing is decided, however large the ratio.
  assert.equal(review({ ...clicky, variants: { A: { exposed: 300, clicks: 6, donors: null, net_cents: null },
    B: { exposed: 300, clicks: 29, donors: null, net_cents: null },
    C: { exposed: 300, clicks: 7, donors: null, net_cents: null } } }).winner, null);
  // Impossible counts are reported, not silently compared.
  const broken = review({ ...clicky, variants: { ...clicky.variants, B: { exposed: 5000, clicks: 5001, donors: null, net_cents: null } } });
  assert.equal(broken.winner, null);
  assert.deepEqual(broken.click_comparisons, {});
  assert(broken.reasons.some(reason => reason.includes('exceed exposure events')));
  // A verified donation winner still takes precedence over the click result.
  assert.equal(review({ ...input, variants: { ...input.variants, B: { ...input.variants.B, clicks: 100 },
    C: { ...input.variants.C, clicks: 300 } } }).decision, 'donation_conversion_winner');
  assert.equal(review({ ...input, review_at: '2026-10-16T12:00:00Z' }).winner, null);
  assert.equal(review({ ...input, guardrails_ok: false }).decision, 'stop_for_guardrail');
  assert.equal(review({ ...input, attribution_verified: false, review_at: '2026-11-12T12:00:00Z' }).decision, 'inconclusive');
  assert.equal(review({ ...input, variants: { ...input.variants, A: { ...input.variants.A, donors: null, net_cents: null } } }).winner, null);
  assert.equal(review({ ...input, variants: { ...input.variants, C: { ...input.variants.C, donors: null, net_cents: null } } }).winner, null);
  db.close();
  console.log('Donation Worker, refund/retry ledger, activation gates and decision rules passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
