/* TradeX report, trades and compare screens. */
(function (root) {
'use strict';
const IST = 19800, MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const inr = (x, d) => (x < 0 ? '−' : '') + '₹' + Math.abs(x).toLocaleString('en-IN', { maximumFractionDigits: d ?? 0, minimumFractionDigits: d ?? 0 });
const sinr = x => (x > 0 ? '+' : '') + inr(x);
const f2 = x => (Number.isFinite(x) ? x.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 }) : x === Infinity ? '∞' : '–');
const pct = x => (Number.isFinite(x) ? (x > 0 ? '+' : '') + x.toFixed(2) + '%' : '–');
const cls = x => (x > 0 ? 'up' : x < 0 ? 'down' : '');
const dstr = t => { const d = new Date((t + IST) * 1000); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const dtstr = t => { const d = new Date((t + IST) * 1000); return `${String(d.getUTCDate()).padStart(2, '0')} ${MON[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
const css = k => getComputedStyle(document.documentElement).getPropertyValue(k).trim();
const tipEl = () => document.getElementById('tip');
function tip(x, y, text) { const t = tipEl(); if (text == null) { t.classList.remove('on'); return; } t.textContent = text; t.style.left = x + 'px'; t.style.top = y + 'px'; t.classList.add('on'); }

/* ---------- small canvas charts ---------- */
function setup(cv, h) { const dpr = window.devicePixelRatio || 1, w = cv.clientWidth || cv.parentElement.clientWidth || 600; cv.style.height = h + 'px'; cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h); return { c, w, h }; }
function sample(arr, max) { const n = arr.length; if (n <= max) return { y: Array.from(arr), ix: Array.from(arr, (_, i) => i) }; const y = [], ix = [], st = n / max; for (let k = 0; k < max; k++) { const i = Math.min(n - 1, Math.round(k * st)); y.push(arr[i]); ix.push(i); } y.push(arr[n - 1]); ix.push(n - 1); return { y, ix }; }
// series: [{y:[...], color, fill, width, dash}] all same length. opts: {h, tip:(k)=>text, click:(k)=>, zero, fmt}
function lineChart(cv, series, o) {
  o = o || {}; const draw = hoverK => {
    const { c, w, h } = setup(cv, o.h || 220), L = 6, Rm = 62, T = 8, B = 20, pw = w - L - Rm, ph = h - T - B; let lo = Infinity, hi = -Infinity;
    for (const s of series) for (const v of s.y) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (o.zero !== undefined) { lo = Math.min(lo, o.zero); hi = Math.max(hi, o.zero); } if (!(hi > lo)) { hi = lo + 1; lo -= 1; } const pad = (hi - lo) * 0.06; lo -= pad; hi += o.flatTop ? 0 : pad;
    const n = series[0].y.length, X = k => L + (n > 1 ? k / (n - 1) : 0.5) * pw, Y = v => T + (hi - v) / (hi - lo) * ph;
    c.font = `11px ${css('--font')}`; c.textBaseline = 'middle'; c.strokeStyle = css('--line'); c.fillStyle = css('--muted'); c.lineWidth = 1;
    for (let g = 0; g <= 4; g++) { const v = lo + (hi - lo) * g / 4, yy = Math.round(Y(v)) + 0.5; c.beginPath(); c.moveTo(L, yy); c.lineTo(L + pw, yy); c.stroke(); c.textAlign = 'left'; c.fillText(o.fmt ? o.fmt(v) : Math.round(v).toLocaleString('en-IN'), L + pw + 6, yy); }
    if (o.xlab) { c.textAlign = 'center'; const m = Math.max(2, Math.floor(pw / 110)); for (let g = 0; g <= m; g++) { const k = Math.round((n - 1) * g / m); c.textAlign = g === 0 ? 'left' : g === m ? 'right' : 'center'; c.fillText(o.xlab(k), X(k), h - 8); } }
    for (const s of series) {
      c.beginPath(); s.y.forEach((v, k) => (k ? c.lineTo(X(k), Y(v)) : c.moveTo(X(k), Y(v)))); c.strokeStyle = s.color; c.lineWidth = s.width || 1.6; c.setLineDash(s.dash || []); c.lineJoin = 'round'; c.stroke(); c.setLineDash([]);
      if (s.fill) { const base = Y(o.zero !== undefined ? o.zero : lo); c.lineTo(X(n - 1), base); c.lineTo(X(0), base); c.closePath(); c.globalAlpha = 0.13; c.fillStyle = s.color; c.fill(); c.globalAlpha = 1; }
    }
    if (hoverK != null) { const xx = Math.round(X(hoverK)) + 0.5; c.strokeStyle = css('--muted'); c.setLineDash([3, 3]); c.beginPath(); c.moveTo(xx, T); c.lineTo(xx, T + ph); c.stroke(); c.setLineDash([]); for (const s of series) { c.fillStyle = s.color; c.beginPath(); c.arc(xx, Y(s.y[hoverK]), 3.5, 0, 7); c.fill(); } }
    cv._k = x => Math.max(0, Math.min(n - 1, Math.round((x - L) / pw * (n - 1))));
  };
  draw(null);
  cv.onmousemove = e => { const k = cv._k(e.offsetX); draw(k); if (o.tip) tip(e.clientX, e.clientY, o.tip(k)); };
  cv.onmouseleave = () => { draw(null); tip(); };
  cv.onclick = e => { if (o.click) o.click(cv._k(e.offsetX)); }; cv.style.cursor = o.click ? 'pointer' : 'crosshair'; cv._redraw = () => draw(null);
}
// vertical bars. vals: numbers, labels: strings. opts: {h, tip:(k), click:(k), color:(v,k)}
function barChart(cv, vals, o) {
  o = o || {}; let rects = [];
  const draw = hk => {
    const { c, w, h } = setup(cv, o.h || 180), L = 4, Rm = 58, T = 8, B = o.labels ? 20 : 6, pw = w - L - Rm, ph = h - T - B; let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals); if (hi === lo) hi = 1;
    const Y = v => T + (hi - v) / (hi - lo) * ph, bw = pw / vals.length; rects = [];
    c.font = `11px ${css('--font')}`; c.textBaseline = 'middle'; c.fillStyle = css('--muted'); c.strokeStyle = css('--line');
    for (const v of [hi, 0, lo]) { if (v === 0 && (hi === 0 || lo === 0)) continue; c.textAlign = 'left'; c.fillText(o.fmt ? o.fmt(v) : Math.round(v).toLocaleString('en-IN'), L + pw + 6, Y(v)); }
    c.beginPath(); c.moveTo(L, Math.round(Y(0)) + 0.5); c.lineTo(L + pw, Math.round(Y(0)) + 0.5); c.stroke();
    vals.forEach((v, k) => { const x = L + k * bw, y0 = Y(Math.max(0, v)), hh = Math.max(1, Math.abs(Y(v) - Y(0))); c.fillStyle = o.color ? o.color(v, k) : (v >= 0 ? css('--up') : css('--down')); c.globalAlpha = hk === k ? 1 : 0.8; const gap = bw > 6 ? Math.min(3, bw * 0.15) : 0; c.fillRect(x + gap, y0, Math.max(1, bw - gap * 2), hh); c.globalAlpha = 1; rects.push([x, x + bw]);
      if (o.labels && (vals.length <= 16 || k % Math.ceil(vals.length / 12) === 0)) { c.fillStyle = css('--muted'); c.textAlign = 'center'; c.fillText(o.labels[k], x + bw / 2, h - 8); } });
  };
  draw(-1); const at = x => rects.findIndex(r => x >= r[0] && x < r[1]);
  cv.onmousemove = e => { const k = at(e.offsetX); draw(k); if (k >= 0 && o.tip) tip(e.clientX, e.clientY, o.tip(k)); else tip(); };
  cv.onmouseleave = () => { draw(-1); tip(); }; cv.onclick = e => { const k = at(e.offsetX); if (k >= 0 && o.click) o.click(k); }; cv.style.cursor = o.click ? 'pointer' : 'default'; cv._redraw = () => draw(-1);
}
function scatter(cv, pts, o) { // pts: [{x,y,c,tip,ref}]
  o = o || {}; let pos = [];
  const draw = hk => {
    const { c, w, h } = setup(cv, o.h || 240), L = 6, Rm = 58, T = 8, B = 22, pw = w - L - Rm, ph = h - T - B; if (!pts.length) return;
    let x0 = 0, x1 = Math.max(...pts.map(p => p.x)) || 1, y0 = Math.min(0, ...pts.map(p => p.y)), y1 = Math.max(0, ...pts.map(p => p.y)); if (y1 === y0) y1 = y0 + 1;
    const X = v => L + (v - x0) / (x1 - x0) * pw, Y = v => T + (y1 - v) / (y1 - y0) * ph; pos = [];
    c.strokeStyle = css('--line'); c.beginPath(); c.moveTo(L, Math.round(Y(0)) + 0.5); c.lineTo(L + pw, Math.round(Y(0)) + 0.5); c.stroke();
    c.font = `11px ${css('--font')}`; c.fillStyle = css('--muted'); c.textBaseline = 'middle'; c.textAlign = 'left'; c.fillText(y1.toFixed(0), L + pw + 6, Y(y1) + 4); c.fillText(y0.toFixed(0), L + pw + 6, Y(y0) - 4); c.fillText('0', L + pw + 6, Y(0));
    c.textAlign = 'right'; c.fillText((o.xl || '') + ' ' + x1.toFixed(0), L + pw, h - 8); c.textAlign = 'left'; c.fillText('0', L, h - 8);
    pts.forEach((p, k) => { const xx = X(p.x), yy = Y(p.y); pos.push([xx, yy]); c.fillStyle = p.c; c.globalAlpha = hk === k ? 1 : 0.55; c.beginPath(); c.arc(xx, yy, hk === k ? 5 : 2.6, 0, 7); c.fill(); }); c.globalAlpha = 1;
  };
  draw(-1); const near = (x, y) => { let b = -1, bd = 144; pos.forEach((p, k) => { const d = (p[0] - x) ** 2 + (p[1] - y) ** 2; if (d < bd) { bd = d; b = k; } }); return b; };
  cv.onmousemove = e => { const k = near(e.offsetX, e.offsetY); draw(k); if (k >= 0) tip(e.clientX, e.clientY, pts[k].tip); else tip(); };
  cv.onmouseleave = () => { draw(-1); tip(); }; cv.onclick = e => { const k = near(e.offsetX, e.offsetY); if (k >= 0 && o.click) o.click(pts[k]); }; cv.style.cursor = 'pointer'; cv._redraw = () => draw(-1);
}
function hbars(rows) { // rows: [{label, value, text, sub}]
  const mx = Math.max(1e-9, ...rows.map(r => Math.abs(r.value)));
  return `<div class="bars-h">${rows.map(r => { const w = Math.abs(r.value) / mx * 50; return `<span>${esc(r.label)}</span><span class="track" title="${esc(r.sub || '')}"><i style="left:${r.value >= 0 ? 50 : 50 - w}%;width:${w}%;background:var(--${r.value >= 0 ? 'up' : 'down'})"></i></span><span class="${cls(r.value)}">${r.text}</span>`; }).join('')}</div>`;
}

/* ---------- report ---------- */
const TABS = [['overview', 'Overview'], ['performance', 'Performance'], ['analysis', 'Trade analysis'], ['calendar', 'Calendar'], ['risk', 'Risk']];
function picker(strats, cur) { return `<div class="chips">${strats.map(s => `<button class="chip" data-s="${s.id}" aria-pressed="${s.id === cur}"><i class="dot" style="background:${s.color}"></i>${esc(s.name)}</button>`).join('')}</div>`; }
function emptyState(el, title, text, btn) { el.innerHTML = `<div class="empty"><h3>${title}</h3><p>${text}</p>${btn ? `<button class="btn primary" data-go="editor">${btn}</button>` : ''}</div>`; }

function renderReport(el, strats, st, ctx) {
  const done = strats.filter(s => s.result && s.result.isStrategy);
  if (!done.length) return emptyState(el, 'No backtest yet', 'Run a strategy from the editor and its full report appears here.', 'Open the editor');
  const S = done.find(s => s.id === st.sid) || done[0]; st.sid = S.id; const M = S.metrics, R = S.result, tab = st.tab || 'overview';
  if (!S.data.t.length || !M) return emptyState(el, `No candles in ${esc(S.period || 'this period')}`, 'Pick another period at the top to see this strategy\'s results.');
  el.innerHTML = `<div class="rep-head"><h2>Report</h2>${picker(done, S.id)}<span class="spacer"></span><span class="muted">${esc(S.symbolName)}, ${S.tf} min, ${dstr(S.data.t[0])} to ${dstr(S.data.t[S.data.t.length - 1])}</span></div>
  <div class="tabs" role="tablist">${TABS.map(t => `<button data-t="${t[0]}" aria-selected="${t[0] === tab}">${t[1]}</button>`).join('')}</div><div class="scroll" style="flex:1"><div class="rep-body" id="repBody"></div></div>`;
  el.querySelectorAll('[data-s]').forEach(b => (b.onclick = () => { st.sid = b.dataset.s; renderReport(el, strats, st, ctx); }));
  el.querySelectorAll('[data-t]').forEach(b => (b.onclick = () => { st.tab = b.dataset.t; renderReport(el, strats, st, ctx); }));
  const body = el.querySelector('#repBody'), tr = R.trades, t = S.data.t;
  if (!tr.length) { body.innerHTML = `<div class="empty"><h3>The strategy took no trades</h3><p>The script ran on ${t.length.toLocaleString('en-IN')} candles without placing an order. Check the entry conditions, or try another candle size.</p></div>`; return; }
  const kpi = (label, val, sub, c, filter) => `<${filter ? 'button' : 'div'} class="kpi" ${filter ? `data-f="${filter}"` : ''}><small>${label}</small><b class="${c || ''}">${val}</b><span>${sub || ''}</span></${filter ? 'button' : 'div'}>`;
  if (tab === 'overview') {
    body.innerHTML = `<div class="kpis">
      <div class="kpi hero"><small>Net profit</small><b class="${cls(M.net)}">${sinr(M.net)}</b><span>${pct(M.netPct)} on ${inr(M.capital)}</span></div>
      ${kpi('Max drawdown', inr(-M.dd.maxDD), M.dd.maxPct.toFixed(2) + '% from peak', 'down')}
      ${kpi('Trades', M.all.n.toLocaleString('en-IN'), `${M.all.wins} won, ${M.all.losses} lost`, '', 'all')}
      ${kpi('Win rate', M.all.winRate.toFixed(1) + '%', `Long ${M.long.winRate.toFixed(0)}%, short ${M.short.winRate.toFixed(0)}%`, '', 'win')}
      ${kpi('Profit factor', f2(M.all.pf), 'Gross profit ÷ gross loss', M.all.pf >= 1 ? 'up' : 'down')}
      ${kpi('Average trade', sinr(M.expectancy), `Win ${inr(M.all.avgWin)}, loss ${inr(M.all.avgLoss)}`, cls(M.expectancy))}
      ${kpi('Sharpe ratio', f2(M.sharpe), 'Daily returns, yearly scale', '')}
      ${kpi('Yearly growth', pct(M.cagr), `Over ${M.years.toFixed(2)} years`, cls(M.cagr))}</div>
    <div class="panel"><header><h3>Equity curve</h3><p>Hover to read a point, click to open that candle on the chart.${M.buyHold ? ' Dashed line is buying and holding the index with the same capital.' : ''}</p></header><canvas id="cEq"></canvas></div>
    <div class="panel"><header><h3>Drawdown</h3><p>How far equity sat below its previous peak</p></header><canvas id="cDd"></canvas></div>
    <div class="panel"><header><h3>Month by month</h3><p>Click a month to see its trades</p></header>${monthGrid(M)}</div>`;
    const eq = sample(R.equity, 1100), c0 = S.data.c[0], bh = eq.ix.map(i => M.capital * (1 + (S.data.c[i] / c0 - 1))), series = [{ y: eq.y, color: S.color, fill: true, width: 2 }];
    if (M.buyHold) series.push({ y: bh, color: css('--muted'), dash: [4, 4], width: 1.2 });
    lineChart(el.querySelector('#cEq'), series, { h: 260, xlab: k => dstr(t[eq.ix[k]]), tip: k => `${dtstr(t[eq.ix[k]])}\nEquity ${inr(eq.y[k])}\nBuy and hold ${inr(bh[k])}`, click: k => ctx.goToTime(t[eq.ix[k]]) });
    let peak = M.capital; const ddAll = Array.from(R.equity, e => { if (e > peak) peak = e; return -(peak - e) / peak * 100; }), dds = sample(ddAll, 1100);
    lineChart(el.querySelector('#cDd'), [{ y: dds.y, color: css('--down'), fill: true }], { h: 130, zero: 0, flatTop: true, fmt: v => v.toFixed(1) + '%', xlab: k => dstr(t[dds.ix[k]]), tip: k => `${dtstr(t[dds.ix[k]])}\n${dds.y[k].toFixed(2)}% below peak`, click: k => ctx.goToTime(t[dds.ix[k]]) });
  } else if (tab === 'performance') {
    const rows = [['Net profit', s => `<span class="${cls(s.net)}">${sinr(s.net)}</span>`], ['Gross profit', s => inr(s.gp)], ['Gross loss', s => inr(-s.gl)], ['Profit factor', s => f2(s.pf)], ['Trades', s => s.n], ['Winning trades', s => `${s.wins} (${s.winRate.toFixed(1)}%)`], ['Losing trades', s => s.losses],
      ['Average trade', s => sinr(s.avg)], ['Average win', s => inr(s.avgWin)], ['Average loss', s => inr(s.avgLoss)], ['Win ÷ loss size', s => f2(s.payoff)], ['Best trade', s => sinr(s.best)], ['Worst trade', s => sinr(s.worst)], ['Points captured', s => f2(s.pts)], ['Average candles held', s => f2(s.avgBars)], ['Charges paid', s => inr(s.comm)]];
    body.innerHTML = `<div class="panel"><header><h3>All, long and short</h3></header><table class="t"><thead><tr><th></th><th>All</th><th>Long</th><th>Short</th></tr></thead><tbody>${rows.map(r => `<tr><td>${r[0]}</td><td>${r[1](M.all)}</td><td>${r[1](M.long)}</td><td>${r[1](M.short)}</td></tr>`).join('')}</tbody></table></div>
    <div class="cols"><div class="panel"><header><h3>Return and risk</h3></header><dl class="kv">
      <dt>Starting capital</dt><dd>${inr(M.capital)}</dd><dt>Ending equity</dt><dd>${inr(M.endEq)}</dd><dt>Yearly growth (CAGR)</dt><dd>${pct(M.cagr)}</dd><dt>Sharpe ratio</dt><dd>${f2(M.sharpe)}</dd><dt>Sortino ratio</dt><dd>${f2(M.sortino)}</dd><dt>Calmar ratio</dt><dd>${f2(M.calmar)}</dd><dt>Net profit ÷ max drawdown</dt><dd>${f2(M.recovery)}</dd>
      <dt>Time in the market</dt><dd>${M.exposure.toFixed(1)}%</dd><dt>Trades per day</dt><dd>${f2(M.tradesPerDay)}</dd>${M.buyHold ? `<dt>Index buy and hold</dt><dd>${pct(M.buyHold.pct)} (${f2(M.buyHold.pts)} pts)</dd>` : ''}</dl></div>
    <div class="panel"><header><h3>Streaks and days</h3></header><dl class="kv"><dt>Longest winning run</dt><dd>${M.maxWinStreak} trades</dd><dt>Longest losing run</dt><dd>${M.maxLossStreak} trades</dd><dt>Trading days</dt><dd>${M.days}</dd><dt>Profitable days</dt><dd>${M.posDays} (${M.days ? (M.posDays / M.days * 100).toFixed(1) : 0}%)</dd><dt>Losing days</dt><dd>${M.negDays}</dd><dt>Average day</dt><dd class="${cls(M.avgDay)}">${sinr(M.avgDay)}</dd><dt>Best day</dt><dd class="up">${sinr(M.bestDay)}</dd><dt>Worst day</dt><dd class="down">${sinr(M.worstDay)}</dd></dl></div></div>
    <p class="note">Test setup: quantity ${R.cfg.qtyType === 'fixed' ? R.cfg.qtyValue : R.cfg.qtyValue + ' (' + R.cfg.qtyType + ')'}, charges ${R.cfg.commValue} (${R.cfg.commType.replace(/_/g, ' ')}), slippage ${(R.cfg.slippage * 0.05).toFixed(2)} pts per fill. Results are in index points times quantity. Real futures or options trades will differ.</p>`;
  } else if (tab === 'analysis') {
    const reasons = Object.entries(M.reasons).sort((a, b) => b[1].n - a[1].n).slice(0, 8), hrs = Object.keys(M.hours).map(Number).sort((a, b) => a - b);
    const slot = k => { const m = 555 + k * 30; return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
    body.innerHTML = `<div class="cols"><div class="panel"><header><h3>Profit and loss spread</h3><p>Number of trades in each profit band</p></header><canvas id="cHist"></canvas></div>
    <div class="panel"><header><h3>Worst point against you vs result</h3><p>Each dot is a trade. Click one to open it.</p></header><canvas id="cSc"></canvas></div></div>
    <div class="cols"><div class="panel"><header><h3>By day of week</h3><p>Day the trade was entered</p></header>${hbars([1, 2, 3, 4, 5, 6].filter(d => M.dow[d].n).map(d => ({ label: DOW[d], value: M.dow[d].pnl, text: sinr(M.dow[d].pnl), sub: `${M.dow[d].n} trades, ${(M.dow[d].wins / M.dow[d].n * 100).toFixed(0)}% won` })))}</div>
    <div class="panel"><header><h3>By entry time</h3><p>Half-hour slots</p></header>${hbars(hrs.map(k => ({ label: slot(k), value: M.hours[k].pnl, text: sinr(M.hours[k].pnl), sub: `${M.hours[k].n} trades, ${(M.hours[k].wins / M.hours[k].n * 100).toFixed(0)}% won` })))}</div>
    <div class="panel"><header><h3>By exit reason</h3></header>${hbars(reasons.map(([k, v]) => ({ label: k.slice(0, 22), value: v.pnl, text: sinr(v.pnl), sub: `${v.n} trades, ${(v.wins / v.n * 100).toFixed(0)}% won` })))}</div></div>
    <div class="panel"><header><h3>Trade by trade</h3><p>Profit of every trade in order. Click a bar to open it.</p></header><canvas id="cSeq"></canvas></div>`;
    const H = Metrics.histogram(tr.map(x => x.pnl), 31);
    barChart(el.querySelector('#cHist'), H.counts, { h: 240, color: (v, k) => (H.lo + (k + 0.5) * H.w >= 0 ? css('--up') : css('--down')), tip: k => `${inr(H.lo + k * H.w)} to ${inr(H.lo + (k + 1) * H.w)}\n${H.counts[k]} trades`, labels: H.counts.map((_, k) => (k % 6 === 0 ? Math.round((H.lo + k * H.w) / 1000) + 'k' : '')) });
    scatter(el.querySelector('#cSc'), tr.map(x => ({ x: x.mae, y: x.pts, c: x.pnl >= 0 ? css('--up') : css('--down'), tip: `#${x.n} ${x.dir > 0 ? 'Long' : 'Short'} ${dtstr(x.et)}\nWent ${x.mae.toFixed(1)} pts against, best ${x.mfe.toFixed(1)} pts\nResult ${x.pts.toFixed(1)} pts`, ref: x })), { h: 240, xl: 'pts against', click: p => ctx.goToTrade(S, p.ref) });
    const last = tr.slice(-600); barChart(el.querySelector('#cSeq'), last.map(x => x.pnl), { h: 170, tip: k => `#${last[k].n} ${dtstr(last[k].xt)}\n${sinr(last[k].pnl)}`, click: k => ctx.goToTrade(S, last[k]) });
  } else if (tab === 'calendar') {
    body.innerHTML = `<div class="panel"><header><h3>Month by month</h3><p>Click a month to see its trades</p></header>${monthGrid(M)}</div>
    <div class="panel"><header><h3>Day by day</h3><p>Profit of each trading day. Click a day to open it on the chart.</p></header><canvas id="cDay"></canvas></div>
    <div class="panel"><header><h3>Running total by day</h3></header><canvas id="cCum"></canvas></div>`;
    const dayT = k => M.dayKeys[k] * 86400 - IST + 555 * 60; barChart(el.querySelector('#cDay'), M.dayPnl, { h: 200, tip: k => `${dstr(dayT(k))}\n${sinr(M.dayPnl[k])}`, click: k => ctx.goToTime(dayT(k)) });
    lineChart(el.querySelector('#cCum'), [{ y: M.dayEq.map(v => v - M.capital), color: S.color, fill: true }], { h: 180, zero: 0, xlab: k => dstr(dayT(k)), tip: k => `${dstr(dayT(k))}\n${sinr(M.dayEq[k] - M.capital)}`, click: k => ctx.goToTime(dayT(k)) });
  } else {
    const mc = Metrics.monteCarlo(tr.map(x => x.pnl), M.capital, 1000), d = M.dd;
    body.innerHTML = `<div class="cols"><div class="panel"><header><h3>Deepest drawdown</h3></header><dl class="kv"><dt>Depth</dt><dd class="down">${inr(-d.maxDD)} (${d.maxPct.toFixed(2)}%)</dd><dt>Peak before it</dt><dd>${dtstr(t[d.ddStart])}</dd><dt>Lowest point</dt><dd>${dtstr(t[d.ddEnd])}</dd><dt>Back to the peak</dt><dd>${d.recoverI > 0 ? dtstr(t[d.recoverI]) : 'Not yet recovered'}</dd><dt>Longest time below a peak</dt><dd>${d.longestDays.toFixed(0)} days</dd></dl><p style="margin:12px 0 0"><button class="btn small" id="ddGo">Show the drawdown on the chart</button></p></div>
    <div class="panel"><header><h3>If the same trades came in a different order</h3><p>${mc.runs.toLocaleString('en-IN')} reshuffles with repeats</p></header><table class="t"><thead><tr><th></th><th>Unlucky 5%</th><th>Typical</th><th>Lucky 5%</th></tr></thead><tbody><tr><td>Net profit</td><td class="${cls(mc.final.p5)}">${sinr(mc.final.p5)}</td><td class="${cls(mc.final.p50)}">${sinr(mc.final.p50)}</td><td class="${cls(mc.final.p95)}">${sinr(mc.final.p95)}</td></tr><tr><td>Max drawdown</td><td class="down">${inr(-mc.dd.p95)}</td><td>${inr(-mc.dd.p50)}</td><td>${inr(-mc.dd.p5)}</td></tr></tbody></table><p class="note" style="margin-top:10px">Chance of ending in loss: <b class="${mc.probLoss > 20 ? 'down' : ''}">${mc.probLoss.toFixed(1)}%</b>. This uses only this backtest's trades, so it shows the spread from luck, not a forecast.</p></div></div>
    <div class="panel"><header><h3>40 of the reshuffled equity paths</h3><p>The bright line is the real order</p></header><canvas id="cMc"></canvas></div>`;
    el.querySelector('#ddGo').onclick = () => ctx.showRange(d.ddStart, d.recoverI > 0 ? d.recoverI : d.ddEnd);
    const real = [M.capital]; let e = M.capital; tr.forEach((x, k) => { e += x.pnl; if ((k + 1) % mc.step === 0) real.push(e); }); const len = Math.min(real.length, ...mc.paths.map(p => p.length));
    lineChart(el.querySelector('#cMc'), mc.paths.map(p => ({ y: p.slice(0, len), color: css('--muted'), width: 0.7 })).concat([{ y: real.slice(0, len), color: S.color, width: 2.4 }]), { h: 260, xlab: k => 'Trade ' + (k * mc.step) });
  }
  body.querySelectorAll('[data-m]').forEach(b => (b.onclick = () => ctx.filterTrades(S, b.dataset.m)));
  body.querySelectorAll('[data-f]').forEach(b => (b.onclick = () => ctx.filterTrades(S, null, b.dataset.f)));
}
function monthGrid(M) {
  const keys = Object.keys(M.monthly).sort(), years = [...new Set(keys.map(k => k.slice(0, 4)))], mx = Math.max(1, ...keys.map(k => Math.abs(M.monthly[k].pnl)));
  let h = `<div class="heat"><div class="hd"></div>${MON.map(m => `<div class="hd">${m}</div>`).join('')}<div class="hd">Year</div>`;
  for (const y of years) { let tot = 0; h += `<div class="yr">${y}</div>`; for (let m = 1; m <= 12; m++) { const k = y + '-' + String(m).padStart(2, '0'), v = M.monthly[k]; if (!v) { h += '<div class="muted">–</div>'; continue; } tot += v.pnl; const a = Math.round(12 + Math.abs(v.pnl) / mx * 58); h += `<button data-m="${k}" style="background:color-mix(in srgb, var(--${v.pnl >= 0 ? 'up' : 'down'}) ${a}%, transparent)" title="${MON[m - 1]} ${y}: ${sinr(v.pnl)}, ${v.n} trades, ${(v.wins / v.n * 100).toFixed(0)}% won">${Math.abs(v.pnl) >= 1000 ? (v.pnl / 1000).toFixed(1) + 'k' : v.pnl.toFixed(0)}</button>`; } h += `<div class="${cls(tot)}" style="font-weight:600">${sinr(tot)}</div>`; }
  return h + '</div>';
}

/* ---------- trades ---------- */
const TCOLS = [['n', '#'], ['dir', 'Side'], ['et', 'Entry time'], ['ep', 'Entry'], ['xt', 'Exit time'], ['xp', 'Exit'], ['qty', 'Qty'], ['pts', 'Points'], ['pnl', 'Profit'], ['pct', '%'], ['mfe', 'Best pts'], ['mae', 'Worst pts'], ['bars', 'Candles'], ['reason', 'Exit reason']];
function renderTrades(el, strats, st, ctx) {
  const done = strats.filter(s => s.result && s.result.isStrategy && s.result.trades.length);
  if (!done.length) return strats.some(s => s.period) ? emptyState(el, `No trades in ${esc(strats.find(s => s.period).period)}`, 'Pick another period at the top, or All.') : emptyState(el, 'No trades to list', 'Run a strategy that places orders and every trade shows up here.', 'Open the editor');
  const S = done.find(s => s.id === st.sid) || done[0]; st.sid = S.id; st.side = st.side || 'all'; st.sort = st.sort || 'n'; st.asc = st.asc ?? false;
  let rows = S.result.trades.filter(x => (st.side === 'long' ? x.dir > 0 : st.side === 'short' ? x.dir < 0 : st.side === 'win' ? x.pnl > 0 : st.side === 'loss' ? x.pnl < 0 : true));
  if (st.month) rows = rows.filter(x => { const d = new Date((x.xt + IST) * 1000); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') === st.month; });
  const k = st.sort, sg = st.asc ? 1 : -1; rows = rows.slice().sort((a, b) => (typeof a[k] === 'string' ? a[k].localeCompare(b[k]) : a[k] - b[k]) * sg);
  const net = rows.reduce((s, x) => s + x.pnl, 0), wins = rows.filter(x => x.pnl > 0).length, shown = rows.slice(0, st.limit || 400);
  el.innerHTML = `<div class="rep-head"><h2>Trades</h2>${picker(done, S.id)}<span class="spacer"></span><button class="btn small" id="csvBtn">Download CSV</button></div>
  <div class="rep-head" style="padding-top:0"><div class="chips">${[['all', 'All'], ['long', 'Long'], ['short', 'Short'], ['win', 'Winners'], ['loss', 'Losers']].map(f => `<button class="chip" data-side="${f[0]}" aria-pressed="${st.side === f[0]}">${f[1]}</button>`).join('')}${st.month ? `<button class="chip" id="clrMonth" aria-pressed="true">${MON[+st.month.slice(5) - 1]} ${st.month.slice(0, 4)} ✕</button>` : ''}</div>
  <span class="spacer"></span><span class="muted">${rows.length.toLocaleString('en-IN')} trades, ${rows.length ? (wins / rows.length * 100).toFixed(1) : 0}% won, net <b class="${cls(net)}">${sinr(net)}</b></span></div>
  <div class="scroll" style="flex:1"><table class="t"><thead><tr>${TCOLS.map(c => `<th data-k="${c[0]}" class="${c[0] === k ? 'sorted' : ''} ${c[0] === 'reason' || c[0] === 'dir' ? 'l' : ''}">${c[1]}${c[0] === k ? (st.asc ? ' ↑' : ' ↓') : ''}</th>`).join('')}</tr></thead><tbody>${shown.map(x => `<tr class="click" data-n="${x.n}"><td>${x.n}</td><td class="l ${x.dir > 0 ? 'up' : 'down'}">${x.dir > 0 ? 'Long' : 'Short'}</td><td>${dtstr(x.et)}</td><td>${f2(x.ep)}</td><td>${dtstr(x.xt)}</td><td>${f2(x.xp)}</td><td>${x.qty}</td><td class="${cls(x.pts)}">${x.pts.toFixed(2)}</td><td class="${cls(x.pnl)}">${sinr(x.pnl)}</td><td class="${cls(x.pct)}">${x.pct.toFixed(2)}</td><td>${x.mfe.toFixed(1)}</td><td>${x.mae.toFixed(1)}</td><td>${x.bars}</td><td class="l">${esc(x.reason)}</td></tr>`).join('')}</tbody></table>
  ${rows.length > shown.length ? `<p style="text-align:center;padding:14px"><button class="btn" id="moreBtn">Show ${Math.min(400, rows.length - shown.length)} more of ${rows.length - shown.length}</button></p>` : ''}</div>`;
  el.querySelectorAll('[data-s]').forEach(b => (b.onclick = () => { st.sid = b.dataset.s; st.limit = 400; renderTrades(el, strats, st, ctx); }));
  el.querySelectorAll('[data-side]').forEach(b => (b.onclick = () => { st.side = b.dataset.side; st.limit = 400; renderTrades(el, strats, st, ctx); }));
  el.querySelectorAll('th[data-k]').forEach(b => (b.onclick = () => { if (st.sort === b.dataset.k) st.asc = !st.asc; else { st.sort = b.dataset.k; st.asc = false; } renderTrades(el, strats, st, ctx); }));
  el.querySelectorAll('tr[data-n]').forEach(r => (r.onclick = () => ctx.goToTrade(S, S.result.trades.find(x => x.n === +r.dataset.n))));
  const cm = el.querySelector('#clrMonth'); if (cm) cm.onclick = () => { st.month = null; renderTrades(el, strats, st, ctx); };
  const mb = el.querySelector('#moreBtn'); if (mb) mb.onclick = () => { st.limit = (st.limit || 400) + 400; renderTrades(el, strats, st, ctx); };
  el.querySelector('#csvBtn').onclick = () => { const head = 'No,Side,Entry time,Entry price,Exit time,Exit price,Qty,Points,Profit,Percent,Best pts,Worst pts,Candles,Charges,Entry id,Exit reason'; const lines = rows.map(x => [x.n, x.dir > 0 ? 'Long' : 'Short', dtstr(x.et), x.ep.toFixed(2), dtstr(x.xt), x.xp.toFixed(2), x.qty, x.pts.toFixed(2), x.pnl.toFixed(2), x.pct.toFixed(3), x.mfe.toFixed(2), x.mae.toFixed(2), x.bars, (x.comm || 0).toFixed(2), '"' + x.id + '"', '"' + x.reason + '"'].join(',')); ctx.download(`TradeX ${S.name} trades.csv`, head + '\n' + lines.join('\n')); };
}

/* ---------- compare ---------- */
function renderCompare(el, strats, st, ctx) {
  const done = strats.filter(s => s.result && s.result.isStrategy && s.metrics && s.data.t.length);
  if (done.length < 1) return emptyState(el, 'Nothing to compare yet', 'Add two or more strategies to the chart and they line up here side by side.', 'Open the editor');
  const rows = [['Net profit', M => sinr(M.net), M => M.net], ['Return', M => pct(M.netPct), M => M.netPct], ['Max drawdown', M => inr(-M.dd.maxDD) + ' (' + M.dd.maxPct.toFixed(1) + '%)', M => -M.dd.maxDD], ['Profit ÷ drawdown', M => f2(M.recovery), M => M.recovery], ['Trades', M => M.all.n, null], ['Win rate', M => M.all.winRate.toFixed(1) + '%', M => M.all.winRate], ['Profit factor', M => f2(M.all.pf), M => M.all.pf], ['Average trade', M => sinr(M.expectancy), M => M.expectancy], ['Sharpe', M => f2(M.sharpe), M => M.sharpe], ['Sortino', M => f2(M.sortino), M => M.sortino], ['Yearly growth', M => pct(M.cagr), M => M.cagr], ['Longest losing run', M => M.maxLossStreak, M => -M.maxLossStreak], ['Worst day', M => sinr(M.worstDay), M => M.worstDay], ['Time in market', M => M.exposure.toFixed(1) + '%', null]];
  el.innerHTML = `<div class="rep-head"><h2>Compare</h2><span class="muted">${done.length} ${done.length === 1 ? 'strategy' : 'strategies'} on ${esc(done[0].symbolName)}, ${done[0].tf} min. The best value in each row is marked.</span></div><div class="scroll" style="flex:1"><div class="rep-body">
  <div class="panel"><header><h3>Equity curves</h3><p>Profit over time, all starting from zero</p></header><canvas id="cCmp"></canvas><div class="chips" style="margin-top:10px">${done.map(s => `<span class="chip"><i class="dot" style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div></div>
  <div class="panel"><table class="t"><thead><tr><th></th>${done.map(s => `<th><i class="dot" style="background:${s.color}"></i> ${esc(s.name)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => { const vs = r[2] ? done.map(s => r[2](s.metrics)) : null, best = vs && done.length > 1 ? Math.max(...vs.filter(Number.isFinite)) : null; return `<tr><td>${r[0]}</td>${done.map((s, i) => `<td style="${vs && vs[i] === best ? 'font-weight:600;color:var(--accent)' : ''}">${r[1](s.metrics)}</td>`).join('')}</tr>`; }).join('')}</tbody></table></div></div></div>`;
  const t = done[0].data.t, n = Math.min(...done.map(s => s.result.equity.length)), ix = sample(new Array(n).fill(0), 900).ix;
  lineChart(el.querySelector('#cCmp'), done.map(s => ({ y: ix.map(i => s.result.equity[i] - s.metrics.capital), color: s.color, width: 1.8 })), { h: 300, zero: 0, xlab: k => dstr(t[ix[k]]), tip: k => dtstr(t[ix[k]]) + '\n' + done.map(s => `${s.name}: ${sinr(s.result.equity[ix[k]] - s.metrics.capital)}`).join('\n'), click: k => ctx.goToTime(t[ix[k]]) });
}
root.TXReport = { renderReport, renderTrades, renderCompare, lineChart, barChart, inr, sinr, f2, pct, cls, dstr, dtstr, esc, tip };
})(window);
