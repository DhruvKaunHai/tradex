/* TradeX report numbers. Pure functions, used by the browser and by tests. */
(function (root) {
'use strict';
const IST = 19800;
const dayKey = t => Math.floor((t + IST) / 86400);
const dt = t => new Date((t + IST) * 1000);
const sum = a => { let s = 0; for (const x of a) s += x; return s; };
const mean = a => (a.length ? sum(a) / a.length : 0);
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(sum(a.map(x => (x - m) * (x - m))) / (a.length - 1)); };
const pctl = (sorted, p) => { if (!sorted.length) return 0; const k = (sorted.length - 1) * p, f = Math.floor(k); return sorted[f] + (sorted[Math.min(f + 1, sorted.length - 1)] - sorted[f]) * (k - f); };

function side(tr) {
  const w = tr.filter(x => x.pnl > 0), l = tr.filter(x => x.pnl < 0);
  const gp = sum(w.map(x => x.pnl)), gl = -sum(l.map(x => x.pnl)), net = gp - gl;
  return { n: tr.length, wins: w.length, losses: l.length, flat: tr.length - w.length - l.length, net, gp, gl,
    pf: gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0), winRate: tr.length ? w.length / tr.length * 100 : 0,
    avg: tr.length ? net / tr.length : 0, avgWin: w.length ? gp / w.length : 0, avgLoss: l.length ? -gl / l.length : 0,
    payoff: l.length && w.length ? (gp / w.length) / (gl / l.length) : 0,
    best: tr.length ? Math.max(...tr.map(x => x.pnl)) : 0, worst: tr.length ? Math.min(...tr.map(x => x.pnl)) : 0,
    pts: sum(tr.map(x => x.pts * (x.qty ? 1 : 1))), avgBars: mean(tr.map(x => x.bars)), comm: sum(tr.map(x => x.comm || 0)) };
}

function drawdown(eq, t, capital) {
  let peak = capital, peakI = 0, maxDD = 0, maxPct = 0, ddStart = 0, ddEnd = 0, longest = 0, uwStart = -1, longS = 0, longE = 0, recoverI = -1;
  const n = eq.length;
  for (let i = 0; i < n; i++) {
    const e = eq[i];
    if (e >= peak) { if (uwStart >= 0) { const d = t[i] - t[uwStart]; if (d > longest) { longest = d; longS = uwStart; longE = i; } uwStart = -1; } peak = e; peakI = i; }
    else { if (uwStart < 0) uwStart = peakI; const dd = peak - e; if (dd > maxDD) { maxDD = dd; maxPct = dd / peak * 100; ddStart = peakI; ddEnd = i; recoverI = -1; } }
    if (recoverI < 0 && maxDD > 0 && i > ddEnd && e >= eq[ddStart]) recoverI = i;
  }
  if (uwStart >= 0 && n) { const d = t[n - 1] - t[uwStart]; if (d > longest) { longest = d; longS = uwStart; longE = n - 1; } }
  return { maxDD, maxPct, ddStart, ddEnd, recoverI, longestDays: longest / 86400, longS, longE };
}

function daily(eq, t, capital) {
  const days = [], vals = []; let prev = capital;
  for (let i = 0; i < eq.length; i++) { const k = dayKey(t[i]); if (days.length && days[days.length - 1] === k) vals[vals.length - 1] = eq[i]; else { days.push(k); vals.push(eq[i]); } }
  const rets = vals.map(v => { const r = (v - prev) / prev; prev = v; return r; });
  return { days, vals, rets };
}

function compute(trades, eq, t, capital, closes) {
  const all = side(trades), long = side(trades.filter(x => x.dir > 0)), short = side(trades.filter(x => x.dir < 0));
  const n = eq.length, endEq = n ? eq[n - 1] : capital, dd = drawdown(eq, t, capital), dl = daily(eq, t, capital);
  const years = n ? Math.max((t[n - 1] - t[0]) / (365.25 * 86400), 1 / 365) : 1;
  const m = mean(dl.rets), s = sd(dl.rets), down = Math.sqrt(mean(dl.rets.map(r => (r < 0 ? r * r : 0))));
  const cagr = endEq > 0 && capital > 0 ? (Math.pow(endEq / capital, 1 / years) - 1) * 100 : -100;
  // streaks
  let cw = 0, cl = 0, mw = 0, ml = 0; for (const x of trades) { if (x.pnl > 0) { cw++; cl = 0; } else if (x.pnl < 0) { cl++; cw = 0; } if (cw > mw) mw = cw; if (cl > ml) ml = cl; }
  // groupings
  const monthly = {}, dow = Array.from({ length: 7 }, () => ({ pnl: 0, n: 0, wins: 0 })), hours = {}, reasons = {};
  for (const x of trades) {
    const d = dt(x.xt), mk = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
    const mo = monthly[mk] || (monthly[mk] = { pnl: 0, n: 0, wins: 0 }); mo.pnl += x.pnl; mo.n++; if (x.pnl > 0) mo.wins++;
    const e = dt(x.et), w = dow[e.getUTCDay()]; w.pnl += x.pnl; w.n++; if (x.pnl > 0) w.wins++;
    const hm = e.getUTCHours() * 60 + e.getUTCMinutes(), slot = Math.floor((hm - 555) / 30), hk = Math.max(0, slot);
    const h = hours[hk] || (hours[hk] = { pnl: 0, n: 0, wins: 0 }); h.pnl += x.pnl; h.n++; if (x.pnl > 0) h.wins++;
    const r = reasons[x.reason || 'Signal'] || (reasons[x.reason || 'Signal'] = { pnl: 0, n: 0, wins: 0 }); r.pnl += x.pnl; r.n++; if (x.pnl > 0) r.wins++;
  }
  const dayPnl = []; for (let i = 0; i < dl.vals.length; i++) dayPnl.push(dl.vals[i] - (i ? dl.vals[i - 1] : capital));
  const posDays = dayPnl.filter(x => x > 0).length, negDays = dayPnl.filter(x => x < 0).length;
  let bh = null; if (closes && closes.length) { const a = closes[0], b = closes[closes.length - 1]; bh = { pct: (b / a - 1) * 100, pts: b - a }; }
  const exposureBars = sum(trades.map(x => x.bars));
  return { all, long, short, capital, endEq, net: endEq - capital, netPct: (endEq - capital) / capital * 100, dd, cagr,
    sharpe: s > 0 ? m / s * Math.sqrt(252) : 0, sortino: down > 0 ? m / down * Math.sqrt(252) : 0, calmar: dd.maxPct > 0 ? cagr / dd.maxPct : 0,
    recovery: dd.maxDD > 0 ? (endEq - capital) / dd.maxDD : 0, expectancy: all.avg, maxWinStreak: mw, maxLossStreak: ml,
    monthly, dow, hours, reasons, days: dl.days.length, posDays, negDays, bestDay: dayPnl.length ? Math.max(...dayPnl) : 0, worstDay: dayPnl.length ? Math.min(...dayPnl) : 0,
    avgDay: mean(dayPnl), dayPnl, dayKeys: dl.days, dayEq: dl.vals, buyHold: bh, years, exposure: n ? Math.min(100, exposureBars / n * 100) : 0, tradesPerDay: dl.days.length ? trades.length / dl.days.length : 0 };
}

// Bootstrap: redraw the same trades in random order with repeats, to see how much the result depends on luck.
function monteCarlo(pnls, capital, runs, seed) {
  runs = runs || 1000; let s = seed || 12345; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const n = pnls.length, finals = [], dds = [], paths = []; if (!n) return null;
  const step = Math.max(1, Math.floor(n / 80));
  for (let r = 0; r < runs; r++) {
    let e = capital, peak = capital, dd = 0; const path = r < 40 ? [capital] : null;
    for (let k = 0; k < n; k++) { e += pnls[(rnd() * n) | 0]; if (e > peak) peak = e; else if (peak - e > dd) dd = peak - e; if (path && (k + 1) % step === 0) path.push(e); }
    finals.push(e - capital); dds.push(dd); if (path) paths.push(path);
  }
  finals.sort((a, b) => a - b); dds.sort((a, b) => a - b);
  const q = a => ({ p5: pctl(a, 0.05), p25: pctl(a, 0.25), p50: pctl(a, 0.5), p75: pctl(a, 0.75), p95: pctl(a, 0.95) });
  return { runs, final: q(finals), dd: q(dds), probLoss: finals.filter(x => x < 0).length / runs * 100, paths, step };
}

function histogram(vals, bins) {
  if (!vals.length) return { edges: [], counts: [] };
  const lo = Math.min(...vals), hi = Math.max(...vals), w = (hi - lo) / bins || 1, counts = new Array(bins).fill(0);
  for (const v of vals) counts[Math.min(bins - 1, Math.floor((v - lo) / w))]++;
  return { lo, hi, w, counts };
}
const api = { compute, monteCarlo, histogram, drawdown };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Metrics = api;
})(typeof self !== 'undefined' ? self : this);
