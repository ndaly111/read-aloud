// Live dashboard for the Amazon picks strip: one HTML page, refreshes itself every minute.
// Aggregate counts only - the same numbers the Worker stores, nothing about visitors.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (c, v) => v ? (100 * c / v).toFixed(2) + '%' : '–';
const n = x => Number(x || 0).toLocaleString('en-US');

function rows(list, label) {
  if (!list.length) return '<tr><td colspan="4" class="muted">nothing yet</td></tr>';
  return list.map(r => '<tr><td>' + esc(r[label]) + (r.keep ? ' <span class="pin" title="never benched">pinned</span>' : '') +
    '</td><td>' + n(r.views) + '</td><td>' + n(r.clicks) + '</td><td>' + pct(r.clicks, r.views) + '</td></tr>').join('');
}

export function renderDash(d) {
  const t = d.totals;
  const now = d.now.map(p => '<a class="now" href="' + esc(p.url) + '" target="_blank" rel="noopener">' +
    '<img src="' + esc(p.image) + '" alt=""><span><b>' + esc(p.title) + '</b><br>' + esc(p.hook) +
    (p.photo ? '<br><small>photo #' + p.photo + '</small>' : '') + '</span></a>').join('');
  const hours = d.hourly.map(h => '<tr><td>' + esc(h.label) + '</td><td>' + n(h.views) + '</td><td>' + n(h.clicks) + '</td><td>' + pct(h.clicks, h.views) + '</td></tr>').join('');
  const refresh = d.refresh ? esc(d.refresh.status) + ' <span class="muted">(' + esc(new Date(d.refresh.ran_at * 1000).toUTCString()) + ')</span>' : 'not run yet';
  const rotation = d.rotation ? esc(d.rotation.status) + ' <span class="muted">(' + esc(new Date(d.rotation.ran_at * 1000).toUTCString()) + ')</span>' +
    (d.rotation.detail ? '<pre>' + esc(d.rotation.detail) + '</pre>' : '') : 'first run Monday 06:07 UTC';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60">
<meta name="robots" content="noindex"><title>Worth a look · live</title>
<style>
  :root{--bg:#f3ecdd;--card:#faf4e6;--ink:#1a1c22;--muted:#6f6857;--red:#c8341e;--rule:#d6c8a8}
  body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.4 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif}
  main{max-width:900px;margin:0 auto;padding:16px}
  h1{font:600 22px/1.2 Georgia,serif;margin:0 0 2px}h1 em{color:var(--red);font-style:italic}
  h2{font:600 13px/1.2 ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:22px 0 8px}
  .sub{color:var(--muted);font-size:13px;margin:0 0 14px}
  .tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
  .tile{background:var(--card);border:1px solid var(--ink);border-radius:3px;padding:10px 12px}
  .tile b{display:block;font-size:26px;line-height:1.1}.tile span{font-size:12px;color:var(--muted)}
  .tile small{display:block;font-size:12px;color:var(--muted);margin-top:4px}
  .nowgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
  .now{display:block;background:#fff;border:2px solid #f08804;border-radius:6px;overflow:hidden;color:var(--ink);text-decoration:none;font-size:13px}
  .now img{display:block;width:100%;aspect-ratio:16/10;object-fit:cover}.now span{display:block;padding:8px 10px}
  table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--ink);font-size:14px}
  th,td{padding:7px 9px;text-align:right;border-bottom:1px solid var(--rule)}th:first-child,td:first-child{text-align:left}
  th{font:600 11px/1 ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
  tr:last-child td{border-bottom:0}.muted{color:var(--muted)}.pin{font-size:10px;color:var(--red);text-transform:uppercase;letter-spacing:.08em}
  pre{white-space:pre-wrap;font-size:12px;background:var(--card);border:1px solid var(--rule);padding:8px;margin:6px 0 0}
  .bench{font-size:13px;color:var(--muted)}
  @media(max-width:600px){.tiles,.nowgrid{grid-template-columns:1fr 1fr 1fr}.tile b{font-size:20px}.now span{font-size:12px}}
</style></head><body><main>
<h1>Worth <em>a look</em> · live</h1>
<p class="sub">read-aloud.com Amazon picks · ${esc(d.as_of)} UTC · refreshes every minute</p>
<div class="tiles">
  <div class="tile"><b>${n(t.today.views)}</b><span>views, last 24h</span><small>${n(t.week.views)} in 7 days</small></div>
  <div class="tile"><b>${n(t.today.clicks)}</b><span>clicks, last 24h</span><small>${n(t.week.clicks)} in 7 days</small></div>
  <div class="tile"><b>${pct(t.today.clicks, t.today.views)}</b><span>click rate, last 24h</span><small>${pct(t.week.clicks, t.week.views)} in 7 days</small></div>
</div>
<h2>On the page right now (since ${esc(d.hour_label)})</h2>
<div class="nowgrid">${now}</div>
<h2>Active picks · last 7 days</h2>
<table><tr><th>pick</th><th>views</th><th>clicks</th><th>rate</th></tr>${rows(d.active, 'id')}</table>
<h2>Thumbnails · last 7 days</h2>
<table><tr><th>pick · photo</th><th>views</th><th>clicks</th><th>rate</th></tr>${rows(d.photos, 'key')}</table>
<h2>By hour · last 24h</h2>
<table><tr><th>hour (UTC)</th><th>views</th><th>clicks</th><th>rate</th></tr>${hours || '<tr><td colspan="4" class="muted">nothing yet</td></tr>'}</table>
<h2>Bench (next up first)</h2>
<p class="bench">${esc(d.bench.join(', ')) || 'none'}</p>
<h2>Housekeeping</h2>
<p class="sub">Amazon product data: <b>${refresh}</b><br>Weekly rotation: <b>${rotation}</b><br>Tracking tag: <b>${esc(d.tag)}</b></p>
</main></body></html>`;
}
