// Operator-only aggregate review. No donor data or network requests.
const fs = require('node:fs');

function fisherExact(a, b, c, d) {
  const n = a + b + c + d;
  const logFactorials = [0];
  for (let i = 1; i <= n; i++) logFactorials[i] = logFactorials[i - 1] + Math.log(i);
  const choose = (n, k) => logFactorials[n] - logFactorials[k] - logFactorials[n - k];
  const row = a + b, successes = a + c;
  const logP = x => choose(successes, x) + choose(n - successes, row - x) - choose(n, row);
  const observed = logP(a);
  let p = 0;
  for (let x = Math.max(0, row - (n - successes)); x <= Math.min(row, successes); x++) {
    const value = logP(x);
    if (value <= observed + 1e-7) p += Math.exp(value);
  }
  return Math.min(1, p);
}

function review(input) {
  const launch = Date.parse(input.launch_at), date = Date.parse(input.review_at);
  if (!Number.isFinite(launch) || !Number.isFinite(date) || date < launch) {
    throw new Error('Supply actual UTC launch_at and review_at timestamps.');
  }
  const day = Math.floor((date - launch) / 86400000);
  const checkpoints = [7, 14, 28, 42];
  const formal = checkpoints.includes(day);
  const nextDay = checkpoints.find(value => value > day);
  const result = {
    experiment_id: 'support_goal_2026_10', day,
    formal_review: formal, decision: 'continue', winner: null,
    next_review_at: nextDay ? new Date(launch + nextDay * 86400000).toISOString() : null,
    reasons: [], metrics: {},
  };
  if (input.guardrails_ok === false) {
    result.decision = 'stop_for_guardrail';
    result.reasons.push('Disable the experiment and investigate the guardrail failure.');
    return result;
  }
  let complete = true;
  for (const variant of ['A', 'B']) {
    const arm = input.variants?.[variant];
    if (!arm || !Number.isSafeInteger(arm.exposed) || arm.exposed <= 0 || arm.exposed > 1000000 ||
        !Number.isSafeInteger(arm.clicks) || arm.clicks < 0) {
      throw new Error(`${variant}: supply positive unique exposed users and nonnegative click events.`);
    }
    if (arm.donors == null || arm.net_cents == null) complete = false;
    else if (!Number.isSafeInteger(arm.donors) || arm.donors < 0 || arm.donors > arm.exposed ||
             !Number.isSafeInteger(arm.net_cents) || arm.net_cents < 0) {
      throw new Error(`${variant}: donors must be unique completed donors within exposed users; net_cents must be nonnegative.`);
    }
    result.metrics[variant] = {
      ...arm, click_events_per_exposed: arm.clicks / arm.exposed,
      donation_rate: arm.donors == null ? null : arm.donors / arm.exposed,
      net_usd_per_1000_exposed: arm.net_cents == null ? null : arm.net_cents * 10 / arm.exposed,
    };
  }
  if (!complete || input.attribution_verified !== true || input.unique_counts_verified !== true) {
    result.reasons.push('Completed-payment attribution or comparable unique-user counts are unverified. Clicks cannot establish a donation winner.');
  } else {
    const a = input.variants.A, b = input.variants.B;
    result.p_value = fisherExact(a.donors, a.exposed - a.donors, b.donors, b.exposed - b.donors);
    const rateA = a.donors / a.exposed, rateB = b.donors / b.exposed;
    const best = rateB > rateA ? 'B' : 'A';
    const low = Math.min(rateA, rateB), high = Math.max(rateA, rateB);
    result.relative_lift = low === 0 ? null : high / low - 1;
    const qualifies = formal && a.donors >= 15 && b.donors >= 15 &&
      low > 0 && result.relative_lift >= 0.20 && result.p_value < 0.0125 &&
      input.guardrails_ok === true && input.weekday_weekend_represented === true;
    if (qualifies) {
      result.decision = 'donation_conversion_winner';
      result.winner = best;
      result.reasons.push('All planned conversion criteria passed. Review revenue separately before rollout; this test does not establish a revenue winner.');
      return result;
    }
    result.reasons.push('The complete set of planned early-stop criteria has not passed.');
  }
  if (day >= 42) {
    result.decision = 'inconclusive';
    result.reasons.push('Restore the existing appeal and document the next test.');
  } else if (!formal) result.reasons.push('Health check only; wait for the next planned formal review.');
  return result;
}

module.exports = { review, fisherExact };
if (require.main === module) {
  try {
    if (!process.argv[2]) throw new Error('Usage: node scripts/review_donation_experiment.js <aggregate-review.json>');
    console.log(JSON.stringify(review(JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
