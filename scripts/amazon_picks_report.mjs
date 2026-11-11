// Views, clicks and click-through rate per Amazon pick, plus the active/bench pool and the
// last weekly rotation, from the Worker's aggregate counters.
// Usage (from the repo root):  node scripts/amazon_picks_report.mjs [days]
// Reads the remote D1 database through wrangler; prints active picks best CTR first.
import { execFileSync } from 'node:child_process';

const days = Math.max(1, Number(process.argv[2]) || 7);
const sinceHour = Math.floor(Date.now() / 3600000) - days * 24;
const cwd = new URL('../worker/amazon-picks/', import.meta.url);
const query = sql => {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'read-aloud-picks', '--remote', '--json',
    '--command', process.platform === 'win32' ? '"' + sql + '"' : sql], { cwd, encoding: 'utf8', shell: process.platform === 'win32' });
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
};
const pool = query('SELECT id, status, since FROM pick_pool ORDER BY status, since, id');
const events = query('SELECT pick, event, SUM(count) AS n FROM pick_events WHERE hour >= ' + sinceHour + ' GROUP BY pick, event');
const rotation = query('SELECT ran_at, status, detail FROM pick_rotations ORDER BY ran_at DESC LIMIT 1')[0];

const stats = {};
for (const r of events) {
  stats[r.pick] ||= { views: 0, clicks: 0 };
  stats[r.pick][r.event === 'click' ? 'clicks' : 'views'] += Number(r.n);
}
const row = id => { const s = stats[id] || { views: 0, clicks: 0 }; return { id, ...s, ctr: s.views ? s.clicks / s.views : 0 }; };
const pct = x => (x * 100).toFixed(2).padStart(6) + '%';
const active = pool.filter(p => p.status === 'active').map(p => row(p.id)).sort((a, b) => b.ctr - a.ctr);
console.log('ACTIVE (last ' + days + ' days)');
console.log('pick'.padEnd(20), 'views'.padStart(7), 'clicks'.padStart(7), 'ctr'.padStart(7));
for (const r of active) console.log(r.id.padEnd(20), String(r.views).padStart(7), String(r.clicks).padStart(7), pct(r.ctr));
const total = active.reduce((a, r) => ({ views: a.views + r.views, clicks: a.clicks + r.clicks }), { views: 0, clicks: 0 });
console.log('total'.padEnd(20), String(total.views).padStart(7), String(total.clicks).padStart(7), pct(total.views ? total.clicks / total.views : 0));
// Dated event cards (Black Friday etc.) are outside the pool; show any that have counts.
const pooled = new Set(pool.map(p => p.id));
for (const r of Object.keys(stats).filter(id => !pooled.has(id)).map(row)) {
  console.log(('(event) ' + r.id).padEnd(20), String(r.views).padStart(7), String(r.clicks).padStart(7), pct(r.ctr));
}
console.log('\nBENCH (next up first):', pool.filter(p => p.status === 'bench').map(p => p.id).join(', ') || 'none');
console.log('\nLAST ROTATION:', rotation ? new Date(rotation.ran_at * 1000).toISOString() + ' ' + rotation.status + ' ' + (rotation.detail || '') : 'none yet');

// Per-photo comparison for picks that rotate several stock photos.
const photoRows = query('SELECT pick, photo, event, SUM(count) AS n FROM pick_photo_events WHERE hour >= ' + sinceHour + ' GROUP BY pick, photo, event');
const photos = {};
for (const r of photoRows) {
  const key = r.pick + ' #' + r.photo;
  photos[key] ||= { views: 0, clicks: 0 };
  photos[key][r.event === 'click' ? 'clicks' : 'views'] += Number(r.n);
}
const photoList = Object.entries(photos).map(([k, c]) => ({ k, ...c, ctr: c.views ? c.clicks / c.views : 0 })).sort((a, b) => a.k.localeCompare(b.k));
if (photoList.length) {
  console.log('\nPHOTOS (last ' + days + ' days)');
  for (const r of photoList) console.log(r.k.padEnd(24), String(r.views).padStart(7), String(r.clicks).padStart(7), pct(r.ctr));
}

// Where the strip is seen: homepage vs guide pages (counted from 11/11).
try {
  const surf = query('SELECT surface, event, SUM(count) AS n FROM pick_surface_events WHERE hour >= ' + sinceHour + ' GROUP BY surface, event');
  if (surf.length) {
    console.log('\nPAGES (card views/clicks by page type)');
    const by = {};
    for (const r of surf) { by[r.surface] ||= { views: 0, clicks: 0 }; by[r.surface][r.event === 'click' ? 'clicks' : 'views'] += Number(r.n); }
    for (const [k, c] of Object.entries(by)) console.log(k.padEnd(24), String(c.views).padStart(7), String(c.clicks).padStart(7), pct(c.views ? c.clicks / c.views : 0));
  }
} catch (_) {}
