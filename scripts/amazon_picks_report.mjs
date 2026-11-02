// Views, clicks and click-through rate per Amazon pick, from the Worker's aggregate counters.
// Usage (from the repo root):  node scripts/amazon_picks_report.mjs [days]
// Reads the remote D1 database through wrangler; prints one line per pick, best CTR first.
import { execFileSync } from 'node:child_process';

const days = Math.max(1, Number(process.argv[2]) || 30);
const sinceHour = Math.floor(Date.now() / 3600000) - days * 24;
const sql = 'SELECT pick, event, SUM(count) AS n FROM pick_events WHERE hour >= ' + sinceHour +
  ' GROUP BY pick, event';
const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'read-aloud-picks', '--remote', '--json',
  '--command', sql], { cwd: new URL('../worker/amazon-picks/', import.meta.url), encoding: 'utf8',
  shell: process.platform === 'win32' });
const rows = JSON.parse(out.slice(out.indexOf('[')))[0].results;
const byPick = {};
for (const r of rows) {
  byPick[r.pick] ||= { views: 0, clicks: 0 };
  byPick[r.pick][r.event === 'click' ? 'clicks' : 'views'] += Number(r.n);
}
const list = Object.entries(byPick).map(([pick, c]) => ({ pick, ...c, ctr: c.views ? c.clicks / c.views : 0 }))
  .sort((a, b) => b.ctr - a.ctr);
console.log('pick'.padEnd(20), 'views'.padStart(7), 'clicks'.padStart(7), 'ctr'.padStart(7), '  (last ' + days + ' days)');
for (const r of list) {
  console.log(r.pick.padEnd(20), String(r.views).padStart(7), String(r.clicks).padStart(7),
    (r.ctr * 100).toFixed(2).padStart(6) + '%');
}
const total = list.reduce((a, r) => ({ views: a.views + r.views, clicks: a.clicks + r.clicks }), { views: 0, clicks: 0 });
console.log('total'.padEnd(20), String(total.views).padStart(7), String(total.clicks).padStart(7),
  ((total.views ? total.clicks / total.views : 0) * 100).toFixed(2).padStart(6) + '%');
