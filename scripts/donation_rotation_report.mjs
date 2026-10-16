// Time-rotated donation test report: credits every donation to the appeal that was live in
// the UTC hour it was made, then applies the pre-registered rule in
// docs/experiments/donation-goal-2026-10.md ("Time-rotated restart").
// Usage: node scripts/donation_rotation_report.mjs   (reads the live D1 via npx wrangler)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { hourIndex, scheduledVariant } from '../worker/donation-goal/src/schedule.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = path.join(here, '..', 'worker', 'donation-goal', 'wrangler.toml');
const launch = Date.parse(readFileSync(config, 'utf8').match(/EXPERIMENT_LAUNCH_UTC = "([^"]+)"/)[1]);
const ARMS = ['A', 'B', 'C'];
const LOOKS = [21, 42];
const ALPHA = 0.05 / (LOOKS.length * 3);

function query(sql) {
  // npx is a .cmd shim on Windows, so it needs a shell; quote every argument (the SQL has >=).
  const args = ['wrangler', 'd1', 'execute', 'read-aloud-donations', '--remote',
    '--config', config, '--json', '--command', sql].map(x => `"${x}"`);
  const out = execFileSync('npx', args, { encoding: 'utf8', shell: true });
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}

// Two-sided exact test that two arms donate at the same rate per view: given n donations
// between them, the first arm's count is Binomial(n, its share of the views).
function rateTest(d1, v1, d2, v2) {
  const n = d1 + d2;
  if (n === 0) return 1;
  const p = v1 / (v1 + v2);
  const pmf = [];
  let c = 1;
  for (let k = 0; k <= n; k++) {
    pmf.push(c * p ** k * (1 - p) ** (n - k));
    c = c * (n - k) / (k + 1);
  }
  return Math.min(1, pmf.filter(x => x <= pmf[d1] * (1 + 1e-9)).reduce((a, b) => a + b, 0));
}

const now = Date.now();
const day = (now - launch) / 86400000;
const startHour = hourIndex(launch);
const arm = () => ({ hours: 0, views: 0, clicks: 0, donations: 0, cents: 0, clickCredited: 0 });
const stats = Object.fromEntries(ARMS.map(a => [a, arm()]));
for (let h = startHour; h < hourIndex(Math.min(now, launch + 42 * 86400000)); h++) {
  stats[scheduledVariant(h * 3600000)].hours++;
}
for (const r of query('SELECT variant, event, SUM(count) AS n FROM rotation_events ' +
    `WHERE hour >= ${startHour} GROUP BY 1, 2`)) {
  if (r.event === 'view') stats[r.variant].views += r.n;
  if (r.event === 'click') stats[r.variant].clicks += r.n;
}
const since = Math.floor(launch / 1000);
const clicks = query(`SELECT ts, variant FROM click_times WHERE ts >= ${since - 1800}`);
for (const d of query(`SELECT created_at, amount_cents FROM donations WHERE refunded = 0 AND created_at >= ${since}`)) {
  const s = stats[scheduledVariant(d.created_at * 1000)];
  s.donations++;
  s.cents += d.amount_cents;
  // Backup credit (sensitivity only): the single appeal clicked in the 30 minutes before.
  const prior = new Set(clicks.filter(c => c.ts <= d.created_at && c.ts >= d.created_at - 1800).map(c => c.variant));
  if (prior.size === 1) stats[[...prior][0]].clickCredited++;
}

const usd = c => '$' + (c / 100).toFixed(2);
console.log(`Time-rotated donation test - day ${day.toFixed(1)} of 42 (launch ${new Date(launch).toISOString()})`);
console.log('Arm  Hours  Views  Clicks  Click%  Donations  Raised   Don/1k views  $/1k views  Click-credited');
for (const a of ARMS) {
  const s = stats[a];
  const per = x => (s.views ? (x / s.views * 1000).toFixed(2) : 'NA').padStart(12);
  console.log(`${a}    ${String(s.hours).padStart(5)}  ${String(s.views).padStart(5)}  ${String(s.clicks).padStart(6)}  ` +
    `${(s.views ? (s.clicks / s.views * 100).toFixed(2) : 'NA').padStart(6)}  ${String(s.donations).padStart(9)}  ` +
    `${usd(s.cents).padStart(7)}  ${per(s.donations)}  ${per(s.cents / 100)}  ${String(s.clickCredited).padStart(14)}`);
}

const look = LOOKS.find(l => Math.abs(day - l) < 1) ?? (day >= 42 ? 42 : null);
const rate = a => stats[a].views ? stats[a].donations / stats[a].views : 0;
let winner = null;
for (const a of ARMS) {
  const others = ARMS.filter(b => b !== a);
  const ok = stats[a].donations >= 10 && others.every(b =>
    rate(a) >= 1.2 * rate(b) &&
    rateTest(stats[a].donations, stats[a].views, stats[b].donations, stats[b].views) < ALPHA);
  if (ok) winner = a;
}
for (const [x, y] of [['A', 'B'], ['A', 'C'], ['B', 'C']]) {
  console.log(`${x} vs ${y} donation rate: p = ${rateTest(stats[x].donations, stats[x].views,
    stats[y].donations, stats[y].views).toFixed(4)} (needs < ${ALPHA.toFixed(4)})`);
}
if (look === null) console.log(`Health check only - formal looks are days ${LOOKS.join(' and ')}.`);
else if (winner) console.log(`Formal look day ${look}: WINNER ${winner} (check the month total did not fall before rollout).`);
else if (look === 42) console.log('Final look: no winner met the rule - inconclusive; keep the existing appeal (A).');
else console.log(`Formal look day ${look}: no winner yet - continue to day 42.`);
