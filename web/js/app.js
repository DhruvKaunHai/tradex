/* TradeX workspace */
(function () {
'use strict';
const { inr, sinr, f2, pct, cls, dstr, dtstr, esc } = TXReport;
const $ = (s, r) => (r || document).querySelector(s), $$ = (s, r) => [...(r || document).querySelectorAll(s)];
const API = (window.TX_API || '').replace(/\/$/, ''), IST = 19800;
const PALETTE = ['#ffb224', '#7cc4ff', '#c59bff', '#ff8fb1', '#8be28b', '#5fe0e6', '#f59b6b', '#d6d06a'];
const SYMS = { NIFTY: 'NIFTY 50', BANKNIFTY: 'BANK NIFTY' };
const store = { get: (k, d) => { try { const v = localStorage.getItem('tx.' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }, set: (k, v) => { try { localStorage.setItem('tx.' + k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } } };
const uid = () => Math.random().toString(36).slice(2, 9);
const toast = (msg, err) => { const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg; $('#toasts').appendChild(t); setTimeout(() => t.remove(), err ? 6000 : 3200); };
const download = (name, text) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };

const settings = Object.assign({ theme: 'dark', capital: '', qty: '', commission: '', slippage: '', from: '', to: '', pooc: false }, store.get('settings', {}));
const A = { symbol: store.get('symbol', 'NIFTY'), tf: store.get('tf', 5), data: {}, status: {}, strats: [], view: 'chart', rep: {}, trd: {}, cmp: {}, marketOpen: false, serverOk: false, lastTick: 0, period: store.get('period', 'all') };
let scripts = store.get('scripts', null);
if (!scripts || !scripts.length) { scripts = TX_SAMPLES.slice(0, 2).map(s => ({ id: uid(), name: s.name, code: s.code, updated: Date.now() })); store.set('scripts', scripts); }
let curId = store.get('cur', scripts[0].id); if (!scripts.find(s => s.id === curId)) curId = scripts[0].id;
const cur = () => scripts.find(s => s.id === curId);
const saveScripts = () => store.set('scripts', scripts);
const saveOnChart = () => store.set('onchart', A.strats.map(s => ({ scriptId: s.scriptId, color: s.color, visible: s.visible, inputs: s.inputs })));

/* ---------- data ---------- */
const key = (s, tf) => s + '|' + tf;
async function loadData(sym, tf, force) {
  const k = key(sym, tf); if (A.data[k] && !force) return A.data[k];
  const r = await fetch(`${API}/api/candles?symbol=${sym}&tf=${tf}`); if (!r.ok) throw new Error('The server did not return candles');
  const j = await r.json(); return (A.data[k] = { t: j.t, o: j.o, h: j.h, l: j.l, c: j.c });
}
function applyTick(sym, bar, livePrice, oldPrice) { // bar is a 5 minute candle [t,o,h,l,c]
  let newBar = false;
  let barChanged = false;
  for (const tf of [5, 15, 30]) {
    const d = A.data[key(sym, tf)]; if (!d) continue; const n = d.t.length; let b = bar;
    if (tf !== 5) { const day = Math.floor((bar[0] + IST) / 86400), m = Math.floor(((bar[0] + IST) % 86400) / 60), t = day * 86400 - IST + (555 + Math.floor((m - 555) / tf) * tf) * 60;
      b = n && d.t[n - 1] === t ? [t, d.o[n - 1], Math.max(d.h[n - 1], bar[2]), Math.min(d.l[n - 1], bar[3]), bar[4]] : [t, bar[1], bar[2], bar[3], bar[4]]; }
    if (n && b[0] < d.t[n - 1]) continue;
    const isNew = !n || b[0] > d.t[n - 1];
    if (sym === A.symbol && tf === A.tf) { chart.updateLast(b, livePrice, oldPrice); if (isNew) newBar = true; }
    else if (isNew) { d.t.push(b[0]); d.o.push(b[1]); d.h.push(b[2]); d.l.push(b[3]); d.c.push(b[4]); } else { d.o[n - 1] = b[1]; d.h[n - 1] = b[2]; d.l[n - 1] = b[3]; d.c[n - 1] = b[4]; }
    barChanged = true;
  }
  if (newBar) {
    clearTimeout(applyTick.t);
    applyTick.t = setTimeout(() => runAll(true), 300);
  } else if (barChanged && sym === A.symbol) {
    // Intrabar tick throttle: update running strategies every 2.5s so stop/target exits reflect on chart immediately
    if (!applyTick.tickThrottle) {
      applyTick.tickThrottle = setTimeout(() => {
        applyTick.tickThrottle = null;
        runAll(true);
      }, 2500);
    }
  }
}
function connect() {
  let es; const open = () => {
    es = new EventSource(`${API}/api/stream`);
    es.onmessage = e => { const m = JSON.parse(e.data); A.serverOk = true;
      if (m.type === 'hello') { m.symbols.forEach(s => (A.status[s.symbol] = s)); A.marketOpen = m.marketOpen; paintSyms(); if (connect.was) { delete A.data[key(A.symbol, A.tf)]; switchData(true); } connect.was = true; }
      else if (m.type === 'tick') { const st = A.status[m.s] || (A.status[m.s] = {}), old = st.price; st.price = m.price; st.priceAt = m.at; if (m.prev) st.prevClose = m.prev; A.lastTick = Date.now(); A.marketOpen = true; applyTick(m.s, m.bar, m.price, old); paintSyms(m.s, old); if (m.s === A.symbol) paintLegend(); }
      else if (m.type === 'ping') A.marketOpen = m.marketOpen;
      else if (m.type === 'reload') { for (const tf of [5, 15, 30]) delete A.data[key(m.s, tf)]; if (m.s === A.symbol) switchData(true); refreshStatus(); }
      paintFeed(); };
    es.onerror = () => { A.serverOk = false; paintFeed(); };
  };
  open();
}
async function refreshStatus() { try { const j = await (await fetch(`${API}/api/status`)).json(); j.symbols.forEach(s => (A.status[s.symbol] = Object.assign(A.status[s.symbol] || {}, s))); A.marketOpen = j.marketOpen; A.serverOk = true; paintSyms(); paintFeed(); if (A.view === 'data') renderData(); } catch (e) { A.serverOk = false; paintFeed(); } }

/* ---------- top bar ---------- */
function paintSyms(tickSym, old) {
  const host = $('#syms'); if (!host.children.length) { host.innerHTML = Object.keys(SYMS).map(s => `<button class="sym" data-sym="${s}"><b>${SYMS[s]}</b><span class="px">–</span><span class="ch"></span></button>`).join(''); $$('.sym', host).forEach(b => (b.onclick = () => { A.symbol = b.dataset.sym; store.set('symbol', A.symbol); paintSyms(); switchData(); })); }
  for (const b of $$('.sym', host)) { const s = b.dataset.sym, st = A.status[s] || {}; b.setAttribute('aria-pressed', s === A.symbol);
    const px = $('.px', b), ch = $('.ch', b); if (st.price != null) { px.textContent = f2(st.price); if (s === tickSym && old != null && old !== st.price) { px.classList.remove('tick-up', 'tick-down'); void px.offsetWidth; px.classList.add(st.price > old ? 'tick-up' : 'tick-down'); }
      if (st.prevClose) { const d = st.price - st.prevClose; ch.textContent = `${d >= 0 ? '+' : ''}${d.toFixed(2)} (${pct(d / st.prevClose * 100)})`; ch.className = 'ch ' + cls(d); } } }
}
function paintFeed() {
  const el = $('#feed'), sp = $('span', el), st = A.status[A.symbol] || {}; el.className = 'feed';
  if (!A.serverOk) { el.classList.add('err'); sp.textContent = 'Server not reachable, retrying'; return; }
  if (A.marketOpen && Date.now() - A.lastTick < 20000) { el.classList.add('live'); const d = A.data[key(A.symbol, A.tf)]; let left = ''; if (d && d.t.length) { const s = d.t[d.t.length - 1] + A.tf * 60 - Date.now() / 1000; if (s > 0 && s < A.tf * 60) left = `, candle closes in ${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; } sp.textContent = 'Live' + left; }
  else if (A.marketOpen) { el.classList.add('err'); sp.textContent = st.error ? 'Live price source is not answering' : 'Waiting for live price'; }
  else sp.textContent = 'Market closed' + (st.last ? `, last candle ${dtstr(st.last)}` : '');
  el.title = st.source ? `Price source: ${st.source}${st.error ? '\nLast problem: ' + st.error : ''}` : 'Live feed';
}
function paintTf() { const seg = $('#tfs'); $$('button', seg).forEach(b => { const on = +b.dataset.tf === A.tf; b.setAttribute('aria-pressed', on); if (on) { const th = $('.thumb', seg); th.style.left = b.offsetLeft + 'px'; th.style.width = b.offsetWidth + 'px'; } }); }
$$('#tfs button').forEach(b => (b.onclick = () => { A.tf = +b.dataset.tf; store.set('tf', A.tf); paintTf(); switchData(); }));
$('#themeBtn').onclick = () => { settings.theme = settings.theme === 'dark' ? 'light' : 'dark'; applyTheme(); };
function applyTheme() { document.documentElement.dataset.theme = settings.theme; store.set('settings', settings); chart.theme(); renderView(); }

/* ---------- views ---------- */
const VIEWS = ['chart', 'editor', 'report', 'trades', 'compare', 'data', 'settings'];
function go(v) { if (!VIEWS.includes(v)) v = 'chart'; A.view = v; if (location.hash.slice(1) !== v) history.replaceState(null, '', '#' + v);
  if (v !== 'chart' && innerWidth <= 900) setDockClosed(true);
  $$('.view').forEach(x => x.classList.toggle('on', x.id === 'v-' + v));
  $$('#rail button').forEach(b => { const on = b.dataset.v === v; if (on) { b.setAttribute('aria-current', 'page'); $('#rail .glow').style.transform = `translateY(${b.offsetTop - 8}px)`; } else b.removeAttribute('aria-current'); });
  renderView(); if (v === 'chart') { chart.resize(); } if (v === 'editor') syncEditor(); }
function renderView() { const v = A.view, ctx = CTX; paintPeriod(); const PS = A.strats.map(inPeriod); if (v === 'report') TXReport.renderReport($('#v-report'), PS, A.rep, ctx); else if (v === 'trades') TXReport.renderTrades($('#v-trades'), PS, A.trd, ctx); else if (v === 'compare') TXReport.renderCompare($('#v-compare'), PS, A.cmp, ctx); else if (v === 'data') renderData(); else if (v === 'settings') renderSettings(); }
$$('#rail button').forEach(b => (b.onclick = () => go(b.dataset.v)));
document.addEventListener('click', e => { const g = e.target.closest('[data-go]'); if (g) go(g.dataset.go); });
window.addEventListener('hashchange', () => go(location.hash.slice(1)));
let rsz, wasMob = innerWidth <= 900; window.addEventListener('resize', () => { clearTimeout(rsz); rsz = setTimeout(() => { const mob = innerWidth <= 900; if (mob && !wasMob) setDockClosed(true); wasMob = mob; paintTf(); go(A.view); }, 150); });
const CTX = {
  goToTime: t => { go('chart'); setTimeout(() => chart.goToTime(t), 60); },
  goToTrade: (S, tr) => { go('chart'); S = A.strats.find(x => x.id === S.id) || S; S.visible = true; paintDock(); pushLayers(); setTimeout(() => { const off = S.offset || 0, span = Math.max(40, (tr.xi - tr.ei) * 3); chart.showRange(Math.max(0, tr.ei + off - span / 3), Math.min(chart.n - 1, tr.xi + off + span / 3)); showTradeCard(S, tr); }, 60); },
  showRange: (i0, i1) => { go('chart'); const S = A.strats.find(s => s.id === A.rep.sid), off = S ? (S.offset || 0) + (inPeriod(S).pOff || 0) : 0; setTimeout(() => chart.showRange(i0 + off, i1 + off), 60); },
  filterTrades: (S, month, side) => { A.trd = { sid: S.id, month: month || null, side: side || 'all' }; go('trades'); },
  download
};

/* ---------- period (year) filter for chart, report, trades and compare ---------- */
const PERIOD_VIEWS = ['chart', 'report', 'trades', 'compare'];
const yearOf = t => new Date((t + IST) * 1000).getUTCFullYear();
const yearSpan = y => [Date.UTC(y, 0, 1) / 1000 - IST, Date.UTC(y + 1, 0, 1) / 1000 - IST];
function periodYears() { const d = A.data[key(A.symbol, A.tf)]; if (!d || !d.t.length) return []; const ys = []; for (let y = yearOf(d.t[d.t.length - 1]); y >= yearOf(d.t[0]); y--) ys.push(y); return ys; }
function inPeriod(S) { // a copy of the strategy with candles, equity, trades and numbers cut to the chosen year
  if (A.period === 'all' || !S.result || !S.result.isStrategy || !S.data) return S;
  const [a, b] = yearSpan(+A.period), t = S.data.t, R = S.result; let p0 = 0; while (p0 < t.length && t[p0] < a) p0++; let p1 = p0; while (p1 < t.length && t[p1] < b) p1++;
  const cut = x => x.slice(p0, p1), data = { t: cut(t), o: cut(S.data.o), h: cut(S.data.h), l: cut(S.data.l), c: cut(S.data.c) };
  const cap = p0 > 0 ? R.equity[p0 - 1] : R.capital, trades = R.trades.filter(x => x.xt >= a && x.xt < b), equity = R.equity.slice(p0, p1);
  const result = Object.assign({}, R, { trades, equity, capital: cap });
  return Object.assign({}, S, { data, result, metrics: data.t.length ? Metrics.compute(trades, equity, data.t, cap, data.c) : null, pOff: p0, period: A.period });
}
function paintPeriod() {
  const el = $('#period'); if (!el) return; const ys = periodYears();
  el.classList.toggle('hide', !PERIOD_VIEWS.includes(A.view) || !ys.length);
  el.innerHTML = '<span>Period</span>' + ['all', ...ys].map(p => `<button data-p="${p}" aria-pressed="${String(A.period) === String(p)}">${p === 'all' ? 'All' : p}</button>`).join('');
  $$('button', el).forEach(b => (b.onclick = () => setPeriod(b.dataset.p)));
}
function setPeriod(p) { A.period = p; store.set('period', p); pushLayers(); paintDock(); if (A.view === 'chart') { paintPeriod(); focusPeriod(); } else renderView(); }
function focusPeriod() { const d = A.data[key(A.symbol, A.tf)]; if (!d || !d.t.length) return; if (A.period === 'all') return chart.fitAll(); const [a, b] = yearSpan(+A.period); let i0 = 0; while (i0 < d.t.length && d.t[i0] < a) i0++; let i1 = i0; while (i1 < d.t.length && d.t[i1] < b) i1++; if (i1 > i0) chart.showRange(i0, i1 - 1); }

/* ---------- chart ---------- */
const chart = new TXChart($('#chartHost'));
let crossI = -1;
chart.on('cross', e => { crossI = e.active ? e.index : -1; paintLegend(); });
chart.on('view', e => $('#goLatest').classList.toggle('hide', !e.away));
$('#goLatest').onclick = () => chart.goLatest();
chart.on('click', e => { if (e.trade) { const S = A.strats.find(s => s.id === e.layer.id); showTradeCard(S, e.trade.ref || e.trade, true); } else $('#tradeCard').innerHTML = ''; });
let legendCollapsed = localStorage.getItem('tx_legend_collapsed') !== '0';
$('#legend').addEventListener('click', e => {
  const btn = e.target.closest('#legendToggle');
  if (btn) {
    e.stopPropagation();
    legendCollapsed = !legendCollapsed;
    try { localStorage.setItem('tx_legend_collapsed', legendCollapsed ? '1' : '0'); } catch (err) {}
    paintLegend();
  }
});
let lastLegendSig = '';
function paintLegend() {
  const d = A.data[key(A.symbol, A.tf)], el = $('#legend'); if (!d || !d.t.length) { el.innerHTML = ''; lastLegendSig = ''; return; }
  const i = crossI >= 0 && crossI < d.t.length ? crossI : d.t.length - 1, ch = i > 0 ? d.c[i] - d.c[i - 1] : 0, c = d.c[i] >= d.o[i] ? 'up' : 'down';
  const activeStrats = A.strats.filter(S => S.visible && S.layer);
  const stratCount = activeStrats.length;
  const stratSig = legendCollapsed ? String(stratCount) : activeStrats.map(s => `${s.id}:${s.layer.plots.slice(0, 5).map(p => p.data[i]).join(',')}`).join('|');
  const sig = `${A.symbol}|${A.tf}|${i}|${d.o[i]}|${d.h[i]}|${d.l[i]}|${d.c[i]}|${legendCollapsed ? 1 : 0}|${stratSig}`;
  if (sig === lastLegendSig) return;
  lastLegendSig = sig;
  const toggleBtn = stratCount > 0 ? `<button class="legend-toggle${legendCollapsed ? '' : ' open'}" id="legendToggle" type="button" title="${legendCollapsed ? 'Show strategy indicators' : 'Hide strategy indicators'}"><span>${stratCount} ${stratCount === 1 ? 'Strategy' : 'Strategies'}</span><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg></button>` : '';
  let h = `<div class="row legend-ohlc"><span class="name">${SYMS[A.symbol]}</span><span class="muted">${A.tf} min, ${dtstr(d.t[i])}</span><span><b>O</b><i class="${c}" style="font-style:normal">${f2(d.o[i])}</i></span><span><b>H</b><i class="${c}" style="font-style:normal">${f2(d.h[i])}</i></span><span><b>L</b><i class="${c}" style="font-style:normal">${f2(d.l[i])}</i></span><span><b>C</b><i class="${c}" style="font-style:normal">${f2(d.c[i])}</i></span><span class="${cls(ch)}">${ch >= 0 ? '+' : ''}${ch.toFixed(2)}</span>${toggleBtn}</div>`;
  if (stratCount > 0 && !legendCollapsed) {
    let stratsHtml = '<div class="legend-strats scroll">';
    for (const S of activeStrats) {
      const vals = S.layer.plots.slice(0, 5).map(p => { const v = p.data[i]; return v === v ? `<span><b>${esc(p.title)}</b>${f2(v)}</span>` : ''; }).join('');
      stratsHtml += `<div class="row"><span><i class="dot" style="background:${S.color}"></i> ${esc(S.name)}</span>${vals}</div>`;
    }
    stratsHtml += '</div>';
    h += stratsHtml;
  }
  el.innerHTML = h;
}
$$('#ranges button').forEach(b => (b.onclick = () => { const days = +b.dataset.r; if (!days) chart.fitAll(); else chart.showLast(Math.round(days * 375 / A.tf)); }));
$('#jump').onchange = e => { if (e.target.value) chart.goToTime(Date.parse(e.target.value + 'T09:15:00+05:30') / 1000); };
function setDockClosed(closed) {
  const dock = $('#dock'), bd = $('#dockBackdrop'), tgl = $('#dockToggle');
  if (!dock) return;
  dock.classList.toggle('closed', closed);
  if (bd) bd.classList.toggle('hide', closed);
  if (tgl) tgl.setAttribute('aria-expanded', String(!closed));
  setTimeout(() => { chart.resize(); paintDockTabs(); }, 280);
}
$('#dockToggle').onclick = () => setDockClosed(!$('#dock').classList.contains('closed'));
const dockCloseBtn = $('#dockClose'); if (dockCloseBtn) dockCloseBtn.onclick = () => setDockClosed(true);
const dockBd = $('#dockBackdrop'); if (dockBd) dockBd.onclick = () => setDockClosed(true);
const touchCrossBtn = $('#touchCrossBtn');
if (touchCrossBtn) {
  touchCrossBtn.onclick = () => {
    const next = !chart.touchCross;
    chart.setTouchCross(next);
    touchCrossBtn.setAttribute('aria-pressed', String(next));
  };
}
function showTradeCard(S, tr, atCursor) {
  if (!S || !tr) return; const el = $('#tradeCard');
  const isOpen = !!(tr.open || tr.reason === 'Still open' || (tr.ref && (tr.ref.open || tr.ref.reason === 'Still open')));
  const tp = tr.tp != null ? tr.tp : (tr.ref && tr.ref.tp != null ? tr.ref.tp : null);
  const sl = tr.sl != null ? tr.sl : (tr.ref && tr.ref.sl != null ? tr.ref.sl : null);
  const tpHtml = tp != null ? `<dt>Target (TP)</dt><dd style="color:var(--up);font-weight:600">${f2(tp)}</dd>` : '';
  const slHtml = sl != null ? `<dt>Stop (SL)</dt><dd style="color:var(--down);font-weight:600">${f2(sl)}</dd>` : '';
  if (isOpen) {
    el.innerHTML = `<div class="tradecard"><b><i class="dot" style="background:#ffb224"></i> ${esc(S.name)}, trade ${tr.n || ''}</b><dl><dt>Status</dt><dd style="color:#ffb224;font-weight:700">Ongoing (Open Trade)</dd><dt>Side</dt><dd class="${tr.dir > 0 ? 'up' : 'down'}">${tr.dir > 0 ? 'Long' : 'Short'} × ${tr.qty || 1}</dd><dt>Entry</dt><dd>${f2(tr.ep)} at ${dtstr(tr.et)}</dd>${tpHtml}${slHtml}<dt>Exit</dt><dd style="color:var(--muted)">Pending (Awaiting Signal)</dd><dt>Held</dt><dd>${tr.bars || 0} candles</dd></dl></div>`;
    return;
  }
  el.innerHTML = `<div class="tradecard"><b><i class="dot" style="background:${S.color}"></i> ${esc(S.name)}, trade ${tr.n}</b><dl><dt>Side</dt><dd class="${tr.dir > 0 ? 'up' : 'down'}">${tr.dir > 0 ? 'Long' : 'Short'} × ${tr.qty}</dd><dt>Entry</dt><dd>${f2(tr.ep)} at ${dtstr(tr.et)}</dd>${tpHtml}${slHtml}<dt>Exit</dt><dd>${f2(tr.xp)} at ${dtstr(tr.xt)}</dd><dt>Points</dt><dd class="${cls(tr.pnl)}" style="font-size:1.25em;font-weight:800">${tr.pts >= 0 ? '+' : '−'}${Math.abs(tr.pts).toFixed(1)} pts</dd><dt>Money</dt><dd class="${cls(tr.pnl)}" style="opacity:.8">${sinr(tr.pnl)}</dd><dt>Best / worst</dt><dd>+${tr.mfe.toFixed(1)} / −${tr.mae.toFixed(1)} pts</dd><dt>Held</dt><dd>${tr.bars} candles</dd><dt>Exit reason</dt><dd>${esc(tr.reason || 'Signal')}</dd></dl></div>`;
  void atCursor;
}
async function switchData(keepView) {
  const sym = A.symbol, tf = A.tf; chart.emptyText = 'Loading candles'; paintFeed();
  try { const d = await loadData(sym, tf); if (sym !== A.symbol || tf !== A.tf) return; if (!d.t.length) { chart.emptyText = `No ${SYMS[sym]} candles yet. See the Data tab.`; chart.d = null; chart.n = 0; chart.draw(); } else chart.setData(d, tf, keepView === true); paintLegend(); paintPeriod(); runAll(keepView === true); }
  catch (e) { chart.emptyText = 'Could not load candles. Is the TradeX server running?'; chart.d = null; chart.draw(); A.serverOk = false; paintFeed(); }
}

/* ---------- running strategies ---------- */
const worker = new Worker('js/worker.js'), pending = new Map(); let runSeq = 0;
worker.onmessage = e => { const m = e.data, p = pending.get(m.id); if (!p) return; if (m.progress !== undefined) { if (p.onProgress) p.onProgress(m.progress); return; } pending.delete(m.id); if (m.ok) p.resolve(m.result); else p.reject(m.error); };
worker.onerror = e => { for (const p of pending.values()) p.reject({ message: 'The backtest engine stopped: ' + e.message, line: 0 }); pending.clear(); };
function runPine(code, data, opt, onProgress) { return new Promise((resolve, reject) => { const id = ++runSeq; pending.set(id, { resolve, reject, onProgress }); worker.postMessage({ id, code, data, opt }); }); }
function sliceData(d) {
  let i0 = 0, i1 = d.t.length; const ts = (s, end) => Date.parse(s + (end ? 'T23:59:59' : 'T00:00:00') + '+05:30') / 1000;
  if (settings.from) { const f = ts(settings.from); while (i0 < i1 && d.t[i0] < f) i0++; } if (settings.to) { const t = ts(settings.to, true); while (i1 > i0 && d.t[i1 - 1] > t) i1--; }
  return { offset: i0, data: i0 === 0 && i1 === d.t.length ? d : { t: d.t.slice(i0, i1), o: d.o.slice(i0, i1), h: d.h.slice(i0, i1), l: d.l.slice(i0, i1), c: d.c.slice(i0, i1) } };
}
async function runStrat(S, quiet) {
  const sc = scripts.find(x => x.id === S.scriptId), full = A.data[key(A.symbol, A.tf)]; if (!sc || !full || !full.t.length) return;
  const sym = A.symbol, tf = A.tf, { offset, data } = sliceData(full), n = full.t.length;
  S.name = sc.name;
  if (!quiet || !S.result) { S.busy = true; paintDock(); }
  const num = v => (v === '' || v == null ? null : +v);
  try {
    const r = await runPine(sc.code, data, { tf, symbol: sym, inputs: S.inputs || {}, capital: num(settings.capital), qty: num(settings.qty), commission: num(settings.commission), slippage: num(settings.slippage), pooc: settings.pooc }, p => { if (!quiet && S.scriptId === curId) $('#prog').style.width = Math.round(p * 100) + '%'; });
    if (sym !== A.symbol || tf !== A.tf) return;
    S.result = r; S.error = null; S.data = data; S.offset = offset; S.tf = tf; S.symbol = sym; S.symbolName = SYMS[sym]; if (r.meta.title && !sc.named) S.name = sc.name;
    S.metrics = r.isStrategy ? Metrics.compute(r.trades, r.equity, data.t, r.capital, data.c) : null;
    const pad = (arr, Ctor, fill) => { if (!offset && arr.length === n) return arr; const out = new Ctor(n); if (fill !== undefined) out.fill(fill); out.set(arr.subarray ? arr.subarray(0, Math.min(arr.length, n - offset)) : arr, offset); return out; };
    S.layer = { id: S.id, name: S.name, color: S.color, overlay: r.meta.overlay, visible: S.visible, plots: r.plots.map(p => ({ title: p.title, data: pad(p.data, Float64Array, NaN), ci: pad(p.ci, Uint8Array), pal: p.pal, width: p.width })), hlines: r.hlines, shapes: offset ? r.shapes.map(s => Object.assign({}, s, { i: s.i + offset })) : r.shapes, bg: offset ? r.bg.map(b => [b[0] + offset, b[1]]) : r.bg, trades: r.trades.map(t => ({ ei: t.ei + offset, xi: t.xi + offset, ep: t.ep, xp: t.xp, dir: t.dir, pnl: t.pnl, pts: t.pts, open: !!t.open, reason: t.reason, sl: t.sl != null ? t.sl : null, tp: t.tp != null ? t.tp : null, ref: t })) };
    if (r.isStrategy && r.trades) watchTradeAlerts(S, r.trades, data, sym, tf);
  } catch (err) { S.error = err; S.result = null; S.layer = null; S.metrics = null; }
  S.busy = false; paintDock(); pushLayers(); paintLegend(); if (!quiet && S.scriptId === curId) { $('#prog').style.width = '0'; afterRun(S); } if (['report', 'trades', 'compare'].includes(A.view)) renderView();
}
function pushLayers() { const yb = A.period === 'all' ? null : yearSpan(+A.period); chart.setLayers(A.strats.filter(s => s.layer).map(s => { const L = s.layer; if (!L.allTrades) L.allTrades = L.trades; return Object.assign(L, { visible: s.visible, color: s.color, trades: yb ? L.allTrades.filter(x => x.ref.xt >= yb[0] && x.ref.xt < yb[1]) : L.allTrades }); })); const c = $('#rail .count'); if (c) c.remove(); if (A.strats.length) { const b = document.createElement('i'); b.className = 'count'; b.textContent = A.strats.length; $('#rail [data-v="chart"]').appendChild(b); } }
async function runAll(quiet) { for (const S of A.strats) await runStrat(S, quiet); }
function addToChart(scriptId, inputs) { let S = A.strats.find(s => s.scriptId === scriptId); if (!S) { const used = A.strats.map(s => s.color); S = { id: uid(), scriptId, color: PALETTE.find(c => !used.includes(c)) || PALETTE[A.strats.length % PALETTE.length], visible: true, inputs: inputs || {} }; A.strats.push(S); saveOnChart(); } return S; }

let dockTab = 'chart';
let cloudStrats = [];

function paintDockTabs() {
  const seg = $('#dockTabs');
  if (!seg) return;
  const th = $('.thumb', seg);
  const activeBtn = $(`button[data-dock="${dockTab}"]`, seg) || $('button[data-dock="chart"]', seg);
  $$('button', seg).forEach(b => b.setAttribute('aria-pressed', String(b === activeBtn)));
  if (th && activeBtn) {
    const update = () => {
      if (activeBtn.offsetWidth > 0) {
        th.style.left = activeBtn.offsetLeft + 'px';
        th.style.width = activeBtn.offsetWidth + 'px';
        th.style.opacity = '1';
      }
    };
    update();
    setTimeout(update, 50);
  }
}
window.addEventListener('resize', paintDockTabs);

async function fetchCloudStrats() {
  try {
    const res = await fetch(`${API}/api/cloud-strats`);
    if (res.ok) {
      const j = await res.json();
      if (j && j.strats) cloudStrats = j.strats;
      const cc = $('#cloudCount');
      if (cc) cc.textContent = cloudStrats.length;
      paintDockTabs();
      if (dockTab === 'cloud') paintCloudList();
    }
  } catch (_) {}
}

async function deployScriptToCloud(id, name, code, inputs) {
  const err = Pine.check(code);
  if (err) return toast(`Error on line ${err.line}: ${err.message}`, true);
  toast(`Deploying "${name}" to Cloud...`);
  try {
    const res = await fetch(`${API}/api/cloud-strats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name, symbol: A.symbol, tf: A.tf, code, inputs: inputs || {} })
    });
    const j = await res.json();
    if (j && j.ok) {
      toast(`"${name}" deployed to Cloud. Running 24/7.`);
      fetchCloudStrats();
    } else {
      toast(`Failed to deploy: ${(j && j.error) || 'Server error'}`, true);
    }
  } catch (e) {
    toast(`Failed to deploy: ${e.message}`, true);
  }
}

let dockSelectMode = false;
const selectedChartIds = new Set();
const selectedCloudIds = new Set();
const selectedModalIds = new Set();

function updateBatchBar() {
  const bar = $('#dockBatchBar');
  const btn = $('#dockSelectBtn');
  if (!bar || !btn) return;

  if (!dockSelectMode) {
    bar.classList.add('hide');
    btn.textContent = 'Select';
    btn.classList.remove('primary');
    return;
  }

  bar.classList.remove('hide');
  btn.textContent = 'Cancel';
  btn.classList.add('primary');

  const countEl = $('#dockSelCount');
  const actBtn = $('#dockBatchAction');
  const selectAll = $('#dockSelectAll');

  if (dockTab === 'chart') {
    const total = A.strats.length;
    const count = selectedChartIds.size;
    if (countEl) countEl.textContent = `${count} of ${total} selected`;
    if (actBtn) {
      actBtn.textContent = `Upload to Cloud (${count})`;
      actBtn.disabled = count === 0;
      actBtn.className = 'btn small primary';
    }
    if (selectAll) selectAll.checked = total > 0 && count === total;
  } else {
    const total = cloudStrats.length;
    const count = selectedCloudIds.size;
    if (countEl) countEl.textContent = `${count} of ${total} selected`;
    if (actBtn) {
      actBtn.textContent = `Delete Selected (${count})`;
      actBtn.disabled = count === 0;
      actBtn.className = 'btn small';
      actBtn.style.color = 'var(--down)';
    }
    if (selectAll) selectAll.checked = total > 0 && count === total;
  }
}

const selBtn = $('#dockSelectBtn');
if (selBtn) {
  selBtn.onclick = () => {
    dockSelectMode = !dockSelectMode;
    if (!dockSelectMode) {
      selectedChartIds.clear();
      selectedCloudIds.clear();
    }
    updateBatchBar();
    paintDock();
    if (dockTab === 'cloud') paintCloudList();
  };
}

const selAllInp = $('#dockSelectAll');
if (selAllInp) {
  selAllInp.onchange = () => {
    if (dockTab === 'chart') {
      if (selAllInp.checked) A.strats.forEach(s => selectedChartIds.add(s.id));
      else selectedChartIds.clear();
      updateBatchBar();
      paintDock();
    } else {
      if (selAllInp.checked) cloudStrats.forEach(s => selectedCloudIds.add(s.id));
      else selectedCloudIds.clear();
      updateBatchBar();
      paintCloudList();
    }
  };
}

const batchActBtn = $('#dockBatchAction');
if (batchActBtn) {
  batchActBtn.onclick = async () => {
    if (dockTab === 'chart') {
      if (selectedChartIds.size === 0) return toast('Select at least one strategy', true);
      const toDeploy = [];
      for (const sid of selectedChartIds) {
        const S = A.strats.find(s => s.id === sid);
        if (!S) continue;
        const sc = scripts.find(x => x.id === S.scriptId);
        if (!sc) continue;
        toDeploy.push({ id: S.scriptId, name: S.name, symbol: A.symbol, tf: A.tf, code: sc.code, inputs: S.inputs || {} });
      }
      if (!toDeploy.length) return toast('No valid strategies found', true);
      toast(`Uploading ${toDeploy.length} strategies to Cloud...`);
      try {
        const res = await fetch(`${API}/api/cloud-strats`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ strats: toDeploy })
        });
        const j = await res.json();
        if (j && j.ok) {
          toast(`${j.count || toDeploy.length} strategies uploaded to Cloud.`);
          selectedChartIds.clear();
          dockSelectMode = false;
          updateBatchBar();
          paintDock();
          fetchCloudStrats();
        } else {
          toast(`Upload failed: ${(j && j.error) || 'Server error'}`, true);
        }
      } catch (e) { toast(`Upload failed: ${e.message}`, true); }
    } else {
      if (selectedCloudIds.size === 0) return toast('Select at least one strategy', true);
      if (!confirm(`Delete ${selectedCloudIds.size} strategies from Cloud?`)) return;
      try {
        const res = await fetch(`${API}/api/cloud-strats/delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [...selectedCloudIds] })
        });
        const j = await res.json();
        if (j && j.ok) {
          cloudStrats = cloudStrats.filter(s => !selectedCloudIds.has(s.id));
          selectedCloudIds.clear();
          dockSelectMode = false;
          updateBatchBar();
          const cc = $('#cloudCount'); if (cc) cc.textContent = cloudStrats.length;
          paintCloudList();
          toast('Strategies deleted from Cloud.');
        } else {
          toast('Delete failed', true);
        }
      } catch (e) { toast('Delete failed', true); }
    }
  };
}

function openBatchModal() {
  const m = $('#batchModal');
  if (!m) return;
  m.classList.remove('hide');
  selectedModalIds.clear();

  const all = [...scripts];
  TX_SAMPLES.forEach((s, i) => {
    if (!all.some(x => x.name === s.name)) {
      all.push({ id: 'sample_' + i, name: s.name, code: s.code, isSample: true });
    }
  });

  all.forEach(s => selectedModalIds.add(s.id));
  $('#batchSymSel').value = A.symbol || 'NIFTY';
  $('#batchTfSel').value = String(A.tf || 15);
  renderBatchModalList(all);
}

function renderBatchModalList(all) {
  const listEl = $('#batchModalList');
  if (!listEl) return;
  listEl.innerHTML = all.map(s => {
    const sel = selectedModalIds.has(s.id);
    return `<label class="batch-item ${sel ? 'selected' : ''}" data-mid="${s.id}">
      <input type="checkbox" class="strat-check" ${sel ? 'checked' : ''}>
      <span class="batch-title">${esc(s.name)}</span>
      ${s.isSample ? '<span class="muted" style="font-size:11px">Starter</span>' : ''}
    </label>`;
  }).join('');

  const countEl = $('#batchModalCount');
  if (countEl) countEl.textContent = `${selectedModalIds.size} of ${all.length} selected`;
  const allBox = $('#batchModalSelectAll');
  if (allBox) allBox.checked = selectedModalIds.size === all.length && all.length > 0;

  $$('.batch-item', listEl).forEach(item => {
    item.onclick = ev => {
      ev.preventDefault();
      const mid = item.dataset.mid;
      if (selectedModalIds.has(mid)) selectedModalIds.delete(mid);
      else selectedModalIds.add(mid);
      renderBatchModalList(all);
    };
  });
}

const bmClose = $('#batchModalClose');
const bmCancel = $('#batchModalCancel');
if (bmClose) bmClose.onclick = () => $('#batchModal').classList.add('hide');
if (bmCancel) bmCancel.onclick = () => $('#batchModal').classList.add('hide');

const bmSelAll = $('#batchModalSelectAll');
if (bmSelAll) {
  bmSelAll.onchange = () => {
    const all = [...scripts];
    TX_SAMPLES.forEach((s, i) => {
      if (!all.some(x => x.name === s.name)) all.push({ id: 'sample_' + i, name: s.name, code: s.code });
    });
    if (bmSelAll.checked) all.forEach(s => selectedModalIds.add(s.id));
    else selectedModalIds.clear();
    renderBatchModalList(all);
  };
}

const bmDeploy = $('#batchModalDeploy');
if (bmDeploy) {
  bmDeploy.onclick = async () => {
    if (selectedModalIds.size === 0) return toast('Select at least one strategy', true);
    const all = [...scripts];
    TX_SAMPLES.forEach((s, i) => {
      if (!all.some(x => x.name === s.name)) all.push({ id: 'sample_' + i, name: s.name, code: s.code });
    });
    const sym = $('#batchSymSel').value;
    const tf = +$('#batchTfSel').value || 15;
    const toDeploy = [];
    for (const mid of selectedModalIds) {
      const s = all.find(x => x.id === mid);
      if (!s || !s.code) continue;
      toDeploy.push({ id: s.id, name: s.name, symbol: sym, tf, code: s.code, inputs: {} });
    }
    if (!toDeploy.length) return toast('No valid strategies found', true);
    toast(`Uploading ${toDeploy.length} strategies to Cloud...`);
    try {
      const res = await fetch(`${API}/api/cloud-strats`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strats: toDeploy })
      });
      const j = await res.json();
      if (j && j.ok) {
        toast(`${j.count || toDeploy.length} strategies uploaded to Cloud.`);
        $('#batchModal').classList.add('hide');
        fetchCloudStrats();
      } else {
        toast(`Upload failed: ${(j && j.error) || 'Server error'}`, true);
      }
    } catch (e) { toast(`Upload failed: ${e.message}`, true); }
  };
}

function closeAllStratMenus() {
  $$('.strat-dropdown').forEach(m => m.classList.add('hide'));
  $$('.strat').forEach(s => s.classList.remove('menu-open'));
}
document.addEventListener('click', e => {
  if (!e.target.closest('.strat-menu')) closeAllStratMenus();
});

function stratSubHtml(S, M) {
  if (S.error) return `<span class="down">Line ${S.error.line || '?'}: ${esc(S.error.message)}</span>`;
  if (M) return `<span class="${cls(M.all.pts)}" style="font-weight:800">${M.all.pts >= 0 ? '+' : '−'}${Math.abs(M.all.pts).toLocaleString('en-IN', { maximumFractionDigits: 0 })} pts</span><span>${M.all.n} trades</span><span>${M.all.winRate.toFixed(0)}% won</span><span>DD ${M.dd.maxPct.toFixed(1)}%</span><span class="${cls(M.net)}" style="opacity:.75">${sinr(M.net)}</span>`;
  return S.result ? '<span>Indicator, no trades</span>' : '<span>Waiting</span>';
}

function stratEyeHtml(vis) {
  return vis
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 2 20 20M9.88 9.88a3 3 0 1 0 4.24 4.24M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/></svg>Hide on Chart`
    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>Show on Chart`;
}

function paintDock() {
  paintDockTabs();
  const el = $('#stratList');
  if (!A.strats.length) {
    if (el.dataset.empty !== '1') {
      el.dataset.empty = '1';
      el.dataset.sig = '';
      el.innerHTML = `<div class="empty" style="padding:20px 8px"><p>No strategy on the chart. Add as many as you like, they all run on the full history.</p><button class="btn primary" data-go="editor">Write or pick a strategy</button></div>`;
    }
  } else {
    const nextSig = (dockSelectMode ? '1:' : '0:') + A.strats.map(s => s.id).join('|');
    if (el.dataset.empty === '1' || el.dataset.sig !== nextSig) {
      el.dataset.empty = '0';
      el.dataset.sig = nextSig;
      el.innerHTML = A.strats.map(S => {
        const M = inPeriod(S).metrics;
        const isSel = selectedChartIds.has(S.id);
        return `<div class="strat ${S.visible ? '' : 'off'} ${S.busy ? 'busy' : ''} ${dockSelectMode ? 'selectable' : ''} ${isSel ? 'selected' : ''}" data-id="${S.id}" data-vis="${S.visible ? '1' : '0'}">
          ${dockSelectMode
            ? `<input type="checkbox" class="strat-check" ${isSel ? 'checked' : ''} aria-label="Select strategy">`
            : `<i class="dot" style="background:${S.color}"></i>`
          }
          <span class="nm" title="${esc(S.name || '')}">${esc(S.name || 'Strategy')}</span>
          ${dockSelectMode
            ? `<span style="width:26px"></span>`
            : `<div class="strat-menu">
                <button class="strat-menu-btn" data-m="btn" title="Options" aria-label="Strategy options">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="3" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="8" cy="13" r="1.5"/></svg>
                </button>
                <div class="strat-dropdown hide">
                  <button data-a="cloud">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>
                    Deploy to Cloud
                  </button>
                  <button data-a="eye">${stratEyeHtml(S.visible)}</button>
                  <button data-a="edit">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                    Edit Script
                  </button>
                  <div class="menu-sep"></div>
                  <button data-a="del" class="menu-danger">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                    Remove from Chart
                  </button>
                </div>
              </div>`
          }
          <span class="sub">${stratSubHtml(S, M)}</span>
        </div>`;
      }).join('');

      $$('.strat', el).forEach(row => {
        const S = A.strats.find(s => s.id === row.dataset.id);
        if (dockSelectMode) {
          row.onclick = ev => {
            ev.stopPropagation();
            if (selectedChartIds.has(S.id)) selectedChartIds.delete(S.id);
            else selectedChartIds.add(S.id);
            updateBatchBar();
            paintDock();
          };
          return;
        }
        const mBtn = row.querySelector('[data-m="btn"]');
        const mDrop = row.querySelector('.strat-dropdown');
        if (mBtn && mDrop) {
          mBtn.onclick = ev => {
            ev.stopPropagation();
            const wasHidden = mDrop.classList.contains('hide');
            closeAllStratMenus();
            if (wasHidden) {
              const r = mBtn.getBoundingClientRect();
              if (window.innerHeight - r.bottom < 190) mDrop.classList.add('drop-up');
              else mDrop.classList.remove('drop-up');
              mDrop.classList.remove('hide');
              row.classList.add('menu-open');
            }
          };
        }
        $$('.strat-dropdown button', row).forEach(b => (b.onclick = async ev => {
          ev.stopPropagation();
          closeAllStratMenus();
          const a = b.dataset.a;
          if (a === 'cloud') {
            const sc = scripts.find(x => x.id === S.scriptId);
            if (!sc) return toast('Could not find strategy script', true);
            deployScriptToCloud(S.scriptId, S.name, sc.code, S.inputs);
            return;
          }
          if (a === 'eye') { S.visible = !S.visible; }
          else if (a === 'del') { A.strats = A.strats.filter(x => x !== S); }
          else if (a === 'edit') { openScript(S.scriptId); go('editor'); return; }
          saveOnChart(); paintDock(); pushLayers(); paintLegend();
        }));
        row.onclick = () => { if (S.metrics) { A.rep.sid = S.id; go('report'); } };
        row.style.cursor = S.metrics ? 'pointer' : 'default';
      });
    } else {
      // Patch existing DOM rows in-place so sidebar never blinks or resets menus
      $$('.strat', el).forEach(row => {
        const S = A.strats.find(s => s.id === row.dataset.id);
        if (!S) return;
        const M = inPeriod(S).metrics;
        const isSel = selectedChartIds.has(S.id);
        const menuOpen = row.classList.contains('menu-open');
        const nextCls = `strat ${S.visible ? '' : 'off'} ${S.busy ? 'busy' : ''} ${dockSelectMode ? 'selectable' : ''} ${isSel ? 'selected' : ''} ${menuOpen ? 'menu-open' : ''}`.trim().replace(/\s+/g, ' ');
        if (row.className !== nextCls) row.className = nextCls;
        if (dockSelectMode) {
          const chk = row.querySelector('.strat-check');
          if (chk && chk.checked !== isSel) chk.checked = isSel;
        } else {
          const dot = row.querySelector('.dot');
          if (dot && dot.style.background !== S.color) dot.style.background = S.color;
          const eyeBtn = row.querySelector('[data-a="eye"]');
          const visStr = S.visible ? '1' : '0';
          if (eyeBtn && row.dataset.vis !== visStr) {
            row.dataset.vis = visStr;
            eyeBtn.innerHTML = stratEyeHtml(S.visible);
          }
        }
        const nm = row.querySelector('.nm');
        const nameText = S.name || 'Strategy';
        if (nm && nm.textContent !== nameText) {
          nm.textContent = nameText;
          nm.title = S.name || '';
        }
        const sub = row.querySelector('.sub');
        if (sub) {
          const nextSub = stratSubHtml(S, M);
          if (sub.dataset.html !== nextSub) {
            sub.dataset.html = nextSub;
            sub.innerHTML = nextSub;
          }
        }
        const wantCursor = S.metrics ? 'pointer' : 'default';
        if (row.style.cursor !== wantCursor) row.style.cursor = wantCursor;
      });
    }
  }
  if (dockTab === 'cloud' || !$('#cloudList')?.dataset.init) paintCloudList();
}

function paintCloudList() {
  const el = $('#cloudList');
  if (!el) return;
  const sig = JSON.stringify([dockSelectMode, [...selectedCloudIds], cloudStrats.map(cs => [cs.id, cs.name, cs.symbol, cs.tf, cs.enabled, cs.lastError])]);
  if (el.dataset.sig === sig) return;
  el.dataset.init = '1';
  el.dataset.sig = sig;
  if (!cloudStrats.length) {
    el.innerHTML = `<div class="empty" style="padding:20px 8px">
      <p style="margin-bottom:10px;line-height:1.5">No 24/7 cloud strategies active. Any strategy deployed to Cloud sends Telegram alerts 24/7 even when your browser and PC are closed.</p>
      <button class="btn small primary" id="pushCurToCloud">+ Upload Strategies to Cloud</button>
    </div>`;
    const btn = $('#pushCurToCloud');
    if (btn) btn.onclick = openBatchModal;
    return;
  }
  el.innerHTML = cloudStrats.map(cs => {
    const isSel = selectedCloudIds.has(cs.id);
    return `<div class="strat ${cs.enabled ? '' : 'off'} ${dockSelectMode ? 'selectable' : ''} ${isSel ? 'selected' : ''}" data-cid="${cs.id}">
      ${dockSelectMode
        ? `<input type="checkbox" class="strat-check" ${isSel ? 'checked' : ''} aria-label="Select strategy">`
        : `<i class="dot" style="background:${cs.enabled ? 'var(--up)' : 'var(--muted)'}"></i>`
      }
      <span class="nm" title="${esc(cs.name)}">${esc(cs.name)}</span>
      ${dockSelectMode
        ? `<span style="width:26px"></span>`
        : `<div class="strat-menu">
            <button class="strat-menu-btn" data-m="btn" title="Options" aria-label="Cloud strategy options">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="3" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="8" cy="13" r="1.5"/></svg>
            </button>
            <div class="strat-dropdown hide">
              <button data-ca="toggle">
                ${cs.enabled
                  ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>Pause 24/7 Run`
                  : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>Activate 24/7 Run`
                }
              </button>
              <button data-ca="edit">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                Edit Script
              </button>
              <div class="menu-sep"></div>
              <button data-ca="del" class="menu-danger">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                Delete from Cloud
              </button>
            </div>
          </div>`
      }
      <span class="sub">
        <span style="font-weight:600">${esc(cs.symbol || 'NIFTY')} · ${cs.tf || 15}m</span>
        <span style="color:${cs.enabled ? 'var(--up)' : 'var(--muted)'}">${cs.enabled ? 'Active 24/7' : 'Paused'}</span>
        ${cs.lastError ? `<span class="down" title="${esc(cs.lastError)}">Error</span>` : ''}
      </span>
    </div>`;
  }).join('') + `<div style="padding:8px 4px"><button class="btn small primary" style="width:100%" id="deployMoreBtn">+ Upload Strategies to Cloud</button></div>`;

  $$('.strat[data-cid]', el).forEach(row => {
    const cid = row.dataset.cid;
    const cs = cloudStrats.find(x => x.id === cid);
    if (!cs) return;
    if (dockSelectMode) {
      row.onclick = ev => {
        ev.stopPropagation();
        if (selectedCloudIds.has(cs.id)) selectedCloudIds.delete(cs.id);
        else selectedCloudIds.add(cs.id);
        updateBatchBar();
        paintCloudList();
      };
      return;
    }
    const mBtn = row.querySelector('[data-m="btn"]');
    const mDrop = row.querySelector('.strat-dropdown');
    if (mBtn && mDrop) {
      mBtn.onclick = ev => {
        ev.stopPropagation();
        const wasHidden = mDrop.classList.contains('hide');
        closeAllStratMenus();
        if (wasHidden) {
          const r = mBtn.getBoundingClientRect();
          if (window.innerHeight - r.bottom < 190) mDrop.classList.add('drop-up');
          else mDrop.classList.remove('drop-up');
          mDrop.classList.remove('hide');
          row.classList.add('menu-open');
        }
      };
    }
    $$('.strat-dropdown button', row).forEach(b => (b.onclick = async ev => {
      ev.stopPropagation();
      closeAllStratMenus();
      const ca = b.dataset.ca;
      if (ca === 'toggle') {
        try {
          const res = await fetch(`${API}/api/cloud-strats/toggle`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: cid })
          });
          const j = await res.json();
          if (j && j.ok) {
            cs.enabled = j.enabled;
            paintCloudList();
            toast(cs.enabled ? `"${cs.name}" resumed on Cloud.` : `"${cs.name}" paused on Cloud.`);
          }
        } catch (e) { toast('Toggle failed', true); }
      } else if (ca === 'edit') {
        let sc = scripts.find(x => x.id === cs.id || x.name === cs.name);
        if (!sc && cs.code) {
          sc = { id: cs.id || uid(), name: cs.name, code: cs.code, updated: Date.now() };
          scripts.unshift(sc);
          saveScripts();
        }
        if (sc) {
          openScript(sc.id);
          go('editor');
        } else {
          toast('Could not find script', true);
        }
      } else if (ca === 'del') {
        if (!confirm(`Delete "${cs.name}" from Cloud? It will stop sending alerts when PC is off.`)) return;
        try {
          const res = await fetch(`${API}/api/cloud-strats/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: cid })
          });
          const j = await res.json();
          if (j && j.ok) {
            cloudStrats = cloudStrats.filter(x => x.id !== cid);
            const cc = $('#cloudCount'); if (cc) cc.textContent = cloudStrats.length;
            paintCloudList();
            toast(`"${cs.name}" removed from Cloud.`);
          }
        } catch (e) { toast('Delete failed', true); }
      }
    }));
  });
  const dm = $('#deployMoreBtn');
  if (dm) dm.onclick = openBatchModal;
}

// Wire dock tabs
const dtChart = $('[data-dock="chart"]');
const dtCloud = $('[data-dock="cloud"]');
if (dtChart && dtCloud) {
  dtChart.onclick = () => {
    dockTab = 'chart';
    paintDockTabs();
    $('#stratList').classList.remove('hide');
    $('#cloudList').classList.add('hide');
    updateBatchBar();
    paintDock();
  };
  dtCloud.onclick = () => {
    dockTab = 'cloud';
    paintDockTabs();
    $('#stratList').classList.add('hide');
    $('#cloudList').classList.remove('hide');
    updateBatchBar();
    fetchCloudStrats();
  };
}
$('#addStrat').onclick = () => go('editor');

/* ---------- editor ---------- */
const ta = $('#code'), hlEl = $('#hl'), gut = $('#gutter');
const KW = /^(if|else|for|to|by|while|var|varip|and|or|not|true|false|na|switch|break|continue|in)$/, NS = /^(ta|math|strategy|input|color|str|array|timeframe|syminfo|barstate|request|plot|shape|location|size|session|hline|dayofweek)$/;
function highlight(code) {
  const re = /(\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?)|(#[0-9a-fA-F]{6,8}\b|\b\d+\.?\d*(?:[eE][+-]?\d+)?\b)|([A-Za-z_]\w*)/g; let out = '', last = 0, m;
  while ((m = re.exec(code))) { out += esc(code.slice(last, m.index)); last = re.lastIndex; const t = m[0];
    if (m[1]) out += `<span class="t-c">${esc(t)}</span>`; else if (m[2]) out += `<span class="t-s">${esc(t)}</span>`; else if (m[3]) out += `<span class="t-n">${esc(t)}</span>`;
    else if (KW.test(t)) out += `<span class="t-k">${t}</span>`; else if (NS.test(t) && code[last] === '.') out += `<span class="t-ns">${t}</span>`; else if (code[last] === '(') out += `<span class="t-f">${t}</span>`; else out += t; }
  return out + esc(code.slice(last)) + '\n';
}
let errLineNo = 0;
function paintCode() { const v = ta.value; hlEl.innerHTML = highlight(v); const n = v.split('\n').length; gut.innerHTML = Array.from({ length: n }, (_, i) => (i + 1 === errLineNo ? `<span class="bad">${i + 1}</span>` : i + 1)).join('\n'); syncScroll(); }
function syncScroll() { hlEl.scrollTop = ta.scrollTop; hlEl.scrollLeft = ta.scrollLeft; gut.scrollTop = ta.scrollTop; const el = $('#errLine'); if (errLineNo) { el.classList.remove('hide'); el.style.top = `calc(12px + ${(errLineNo - 1) * 1.6}em - ${ta.scrollTop}px)`; } else el.classList.add('hide'); }
function setErr(line) { errLineNo = line || 0; paintCode(); }
function allErrors(code) { // keep checking: neutralise each faulty line and look again, so every line with a problem is listed
  const out = [], seen = new Set(), src = code.split('\n');
  for (let k = 0; k < 40; k++) {
    const e = Pine.check(src.join('\n')); if (!e) break; let ln = (e.line || 0) - 1;
    for (let j = ln - 1; j >= 0 && j >= ln - 6; j--) { const L = src[j].replace(/\/\/.*$/, '').replace(/"[^"]*"|'[^']*'/g, ''); if (!L.trim()) continue; const open = (L.match(/[([]/g) || []).length - (L.match(/[)\]]/g) || []).length; if (open > 0 || /([+\-*/%<>=,?:]|\b(and|or|not))\s*$/.test(L)) ln = j; else break; }
    e.line = ln + 1; const id = e.line + '|' + e.message; if (seen.has(id)) break; seen.add(id); out.push({ line: e.line, message: e.message, text: code.split('\n')[ln] || '' });
    if (ln < 0 || ln >= src.length || /^\s*(na|if true)\s*$/.test(src[ln])) break;
    const ind = /^\s*/.exec(src[ln])[0]; let nx = ln + 1; while (nx < src.length && !src[nx].trim()) nx++;
    src[ln] = ind + (nx < src.length && /^\s*/.exec(src[nx])[0].length > ind.length ? 'if true' : 'na');
  }
  return out;
}
let lastErrs = [];
function paintErrors() {
  const s = cur(), S = A.strats.find(x => x.scriptId === curId), errs = allErrors(ta.value);
  if (S && S.error && !errs.some(e => e.line === S.error.line && e.message === S.error.message)) errs.push({ line: S.error.line, message: S.error.message, text: ta.value.split('\n')[(S.error.line || 1) - 1] || '', run: true });
  lastErrs = errs; const badge = $('#ecount'); badge.textContent = errs.length; badge.classList.toggle('hide', !errs.length);
  const el = $('#p-errors');
  if (!errs.length) { el.innerHTML = `<p class="note">No errors found in "${esc(s.name)}".</p>`; return; }
  el.innerHTML = `<div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn small primary" id="copyErrs">Copy errors</button><button class="btn small" id="copyErrsAll">Copy errors + full script</button></div>
  <p class="note">${errs.length} line${errs.length === 1 ? '' : 's'} with a problem in "${esc(s.name)}". Click one to jump to it. Later errors can be knock-on effects of an earlier one.</p>
  <div class="err-list">${errs.map((e, i) => `<button class="err-item" data-ei="${i}"><b>Line ${e.line || '?'}${e.run ? ' (while running)' : ''}</b><span>${esc(e.message)}</span>${e.text.trim() ? `<code>${esc(e.text.trim())}</code>` : ''}</button>`).join('')}</div>`;
  $$('[data-ei]', el).forEach(b => (b.onclick = () => { const e = errs[+b.dataset.ei], lines = ta.value.split('\n'); let pos = 0; for (let i = 0; i < (e.line || 1) - 1 && i < lines.length; i++) pos += lines[i].length + 1; ta.focus(); ta.setSelectionRange(pos, pos + (lines[(e.line || 1) - 1] || '').length); ta.scrollTop = Math.max(0, ((e.line || 1) - 4) * parseFloat(getComputedStyle(ta).lineHeight || 20)); syncScroll(); }));
  $('#copyErrs').onclick = () => copyErrors(false); $('#copyErrsAll').onclick = () => copyErrors(true);
}
function copyErrors(withCode) {
  const s = cur(); let txt = `TradeX Pine script "${s.name}" has ${lastErrs.length} error${lastErrs.length === 1 ? '' : 's'}:\n` + lastErrs.map((e, i) => `${i + 1}. Line ${e.line || '?'}${e.run ? ' (while running)' : ''}: ${e.message}${e.text.trim() ? '\n   > ' + e.text.trim() : ''}`).join('\n');
  if (withCode) txt += '\n\nFull script (line numbers added for reference):\n' + ta.value.split('\n').map((l, i) => String(i + 1).padStart(3, ' ') + ' | ' + l).join('\n');
  const done = () => toast('Copied, paste it into any AI chat'); if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(txt).then(done, () => fallbackCopy(txt, done)); else fallbackCopy(txt, done);
}
function fallbackCopy(txt, done) { const t = document.createElement('textarea'); t.value = txt; t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); done(); } catch (e) { toast('Could not copy, select the text manually', true); } t.remove(); }
function setMsg(text, kind) { const m = $('#edMsg'); m.textContent = text; m.className = 'msg ' + (kind || ''); }
let checkT;
ta.addEventListener('input', () => { cur().code = ta.value; cur().updated = Date.now(); cur().dirty = true; paintCode(); clearTimeout(checkT); checkT = setTimeout(() => { saveScripts(); const e = Pine.check(ta.value); if (e) { setErr(e.line); setMsg(`Line ${e.line}: ${e.message}`, 'err'); } else { setErr(0); setMsg('No syntax problems. Press Ctrl+Enter to run.', ''); } paintErrors(); }, 500); });
ta.addEventListener('scroll', syncScroll);
ta.addEventListener('keydown', e => {
  if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('    ', s, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input')); }
  else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) { const s = ta.selectionStart, line = ta.value.slice(ta.value.lastIndexOf('\n', s - 1) + 1, s), ind = /^\s*/.exec(line)[0] + (/(=>|\bif\b.*|\belse\b|\bfor\b.*|\bwhile\b.*|\bswitch\b.*)\s*$/.test(line) && !/=>\s*\S/.test(line) ? '    ' : ''); e.preventDefault(); ta.setRangeText('\n' + ind, s, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input')); }
});
document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && A.view === 'editor') { e.preventDefault(); runCurrent(); } if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && A.view === 'editor') { e.preventDefault(); saveCurrent(); } });
function syncEditor() { const s = cur(); if (ta.value !== s.code) ta.value = s.code; $('#scriptName').value = s.name; paintCode(); paintLib(); paintInputs(); paintSetup(); paintErrors(); const S = A.strats.find(x => x.scriptId === curId); if (S && (S.result || S.error)) afterRun(S, true); else { $('#quick').classList.add('hide'); $('#openReport').classList.add('hide'); $('#showOnChart').classList.add('hide'); setMsg('Press Ctrl+Enter or Run backtest. The test uses every loaded candle.', ''); setErr(0); } }
function openScript(id) { curId = id; store.set('cur', id); syncEditor(); }
function saveCurrent() { const s = cur(); s.code = ta.value; s.name = $('#scriptName').value.trim() || 'Untitled'; s.dirty = false; saveScripts(); paintLib(); toast('Saved'); }
$('#scriptName').onchange = () => { cur().name = $('#scriptName').value.trim() || 'Untitled'; cur().named = true; saveScripts(); paintLib(); const S = A.strats.find(x => x.scriptId === curId); if (S) { S.name = cur().name; paintDock(); } };
$('#saveBtn').onclick = saveCurrent; $('#runBtn').onclick = () => runCurrent();
const cb = $('#cloudBtn'); if (cb) cb.onclick = () => deployScriptToCloud(curId, $('#scriptName').value.trim() || 'Strategy', ta.value, {});
$('#sideBtn').onclick = () => $('#v-editor').classList.toggle('side');
const sideCloseBtn = $('#sideCloseBtn'); if (sideCloseBtn) sideCloseBtn.onclick = () => $('#v-editor').classList.remove('side');
$('#openReport').onclick = () => { const S = A.strats.find(x => x.scriptId === curId); if (S) A.rep.sid = S.id; go('report'); };
$('#showOnChart').onclick = () => go('chart');
async function runCurrent() {
  const s = cur(); s.code = ta.value; s.name = $('#scriptName').value.trim() || 'Untitled'; saveScripts();
  const e = Pine.check(s.code); paintErrors(); if (e) { setErr(e.line); setMsg(`Line ${e.line}: ${e.message}`, 'err'); log(`Line ${e.line}: ${e.message}`, 'e'); return; }
  if (!A.data[key(A.symbol, A.tf)] || !A.data[key(A.symbol, A.tf)].t.length) { setMsg(`No ${SYMS[A.symbol]} candles are loaded, so there is nothing to test on.`, 'err'); return; }
  $('#runBtn').disabled = true; setMsg('Running on ' + A.data[key(A.symbol, A.tf)].t.length.toLocaleString('en-IN') + ' candles', ''); setErr(0);
  const S = addToChart(s.id); S.visible = true; await runStrat(S); $('#runBtn').disabled = false; paintLib();
}
function log(text, k) { const c = $('#console'); if (c.dataset.fresh !== '1') { c.innerHTML = ''; c.dataset.fresh = '1'; } const d = document.createElement('div'); d.className = k || ''; d.textContent = new Date().toTimeString().slice(0, 8) + '  ' + text; c.prepend(d); }
function afterRun(S, silent) {
  const q = $('#quick'); if (S.scriptId === curId) paintErrors();
  if (S.error) { setErr(S.error.line); setMsg(`Line ${S.error.line || '?'}: ${S.error.message}`, 'err'); q.classList.add('hide'); $('#openReport').classList.add('hide'); $('#showOnChart').classList.add('hide'); if (!silent) { log(`Line ${S.error.line || '?'}: ${S.error.message}`, 'e'); sidePane('console'); } return; }
  const r = S.result, M = S.metrics; setErr(0);
  if (!silent) { log(`${S.name}: ${S.data.t.length.toLocaleString('en-IN')} candles of ${S.symbolName} ${S.tf} min in ${Math.round(r.ms)} ms, ${r.trades.length} trades`, 'o'); r.warnings.forEach(w => log(w, 'w')); }
  $('#showOnChart').classList.remove('hide'); paintInputs();
  if (!M) { q.classList.add('hide'); $('#openReport').classList.add('hide'); setMsg(`Indicator drawn with ${r.plots.length} line${r.plots.length === 1 ? '' : 's'}. It places no orders, so there is no report.`, 'ok'); return; }
  $('#openReport').classList.remove('hide'); q.classList.remove('hide');
  q.innerHTML = `<div><small>Net profit</small><b class="${cls(M.net)}">${sinr(M.net)}</b></div><div><small>Trades and win rate</small><b>${M.all.n} at ${M.all.winRate.toFixed(1)}%</b></div><div><small>Profit factor</small><b>${f2(M.all.pf)}</b></div><div><small>Max drawdown</small><b class="down">${M.dd.maxPct.toFixed(2)}%</b></div>`;
  setMsg(`Tested ${S.symbolName} ${S.tf} min from ${dstr(S.data.t[0])} to ${dstr(S.data.t[S.data.t.length - 1])}${r.warnings.length ? '. ' + r.warnings.length + ' note in the console' : ''}`, 'ok');
}
function sidePane(p) { $$('#sideTabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.p === p)); $$('.ed-side .pane').forEach(x => x.classList.toggle('on', x.id === 'p-' + p)); }
$$('#sideTabs button[data-p]').forEach(b => (b.onclick = () => sidePane(b.dataset.p)));
function paintLib() {
  const el = $('#p-lib');
  el.innerHTML = `<div style="display:flex;gap:6px"><button class="btn small primary" id="newScript">New script</button><button class="btn small" id="dupScript">Duplicate</button><button class="btn small" id="delScript">Delete</button></div>
  <div class="lib-head">Your scripts</div>${scripts.map(s => `<button class="lib-item" data-id="${s.id}" aria-current="${s.id === curId}"><span class="nm">${esc(s.name)}</span>${A.strats.some(x => x.scriptId === s.id) ? '<small>on chart</small>' : ''}</button>`).join('')}
  <div class="lib-head">Starters, click to copy into your scripts</div>${TX_SAMPLES.map((s, i) => `<button class="lib-item" data-sample="${i}"><span class="nm">${esc(s.name)}</span><small>copy</small></button>`).join('')}
  <div class="lib-head">Open a .pine or .txt file</div><input type="file" id="pineFile" accept=".pine,.txt" class="inp">`;
  $$('[data-id]', el).forEach(b => (b.onclick = () => openScript(b.dataset.id)));
  $$('[data-sample]', el).forEach(b => (b.onclick = () => { const s = TX_SAMPLES[+b.dataset.sample], n = { id: uid(), name: s.name, code: s.code, updated: Date.now() }; scripts.unshift(n); saveScripts(); openScript(n.id); }));
  $('#newScript').onclick = () => { const n = { id: uid(), name: 'New strategy', code: '//@version=5\nstrategy("New strategy", overlay=true, initial_capital=500000, default_qty_value=75)\n\n// Write your rules below\nif ta.crossover(close, ta.sma(close, 20))\n    strategy.entry("Long", strategy.long)\nif ta.crossunder(close, ta.sma(close, 20))\n    strategy.close("Long")\n', updated: Date.now() }; scripts.unshift(n); saveScripts(); openScript(n.id); ta.focus(); };
  $('#dupScript').onclick = () => { const s = cur(), n = { id: uid(), name: s.name + ' copy', code: s.code, updated: Date.now() }; scripts.unshift(n); saveScripts(); openScript(n.id); };
  $('#delScript').onclick = () => { if (scripts.length < 2) return toast('Keep at least one script', true); if (!confirm(`Delete "${cur().name}"? This cannot be undone.`)) return; A.strats = A.strats.filter(x => x.scriptId !== curId); scripts = scripts.filter(s => s.id !== curId); saveScripts(); saveOnChart(); paintDock(); pushLayers(); openScript(scripts[0].id); };
  $('#pineFile').onchange = async e => { const f = e.target.files[0]; if (!f) return; const n = { id: uid(), name: f.name.replace(/\.(pine|txt)$/i, ''), code: await f.text(), updated: Date.now() }; scripts.unshift(n); saveScripts(); openScript(n.id); };
}
let inpT;
function paintInputs() {
  const el = $('#p-inputs'), S = A.strats.find(x => x.scriptId === curId), ins = S && S.result ? S.result.inputs : [];
  if (!ins.length) { el.innerHTML = '<p class="note">Inputs declared in the script with input.int, input.float and the like show here after a run. Change one and the test runs again.</p>'; return; }
  el.innerHTML = ins.map((x, i) => { const v = x.value, id = 'in' + i;
    if (x.type === 'bool') return `<label class="check"><input type="checkbox" data-in="${esc(x.title)}" ${v ? 'checked' : ''}>${esc(x.title)}</label>`;
    if (x.options && Array.isArray(x.options)) return `<label class="field">${esc(x.title)}<select data-in="${esc(x.title)}">${x.options.map(o => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
    if (x.type === 'source') return `<label class="field">${esc(x.title)}<select data-in="${esc(x.title)}">${['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4', 'hlcc4'].map(o => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`;
    const numeric = x.type === 'int' || x.type === 'float'; return `<label class="field" for="${id}">${esc(x.title)}<input id="${id}" data-in="${esc(x.title)}" type="${numeric ? 'number' : 'text'}" value="${esc(v)}" ${numeric ? `step="${x.step || (x.type === 'int' ? 1 : 'any')}" ${x.minval != null ? `min="${x.minval}"` : ''} ${x.maxval != null ? `max="${x.maxval}"` : ''}` : ''}></label>`; }).join('') + '<button class="btn small" id="resetIn">Back to script defaults</button>';
  $$('[data-in]', el).forEach(i => (i.oninput = i.onchange = () => { S.inputs = S.inputs || {}; S.inputs[i.dataset.in] = i.type === 'checkbox' ? i.checked : i.value; saveOnChart(); clearTimeout(inpT); inpT = setTimeout(() => runStrat(S), 350); }));
  $('#resetIn').onclick = () => { S.inputs = {}; saveOnChart(); runStrat(S); };
}
function paintSetup() {
  const el = $('#p-setup'), f = (k, label, ph, type) => `<label class="field">${label}<input data-set="${k}" type="${type || 'number'}" value="${esc(settings[k])}" placeholder="${ph || ''}" ${type ? '' : 'min="0" step="any"'}></label>`;
  el.innerHTML = `<p class="note">These apply to every strategy. Leave a box empty to use what the script itself says.</p><div class="grid2">${f('capital', 'Starting capital (₹)', 'From script')}${f('qty', 'Quantity per order', 'From script')}${f('commission', 'Charges per order (₹)', 'From script')}${f('slippage', 'Slippage (points)', 'From script')}${f('from', 'Test from', '', 'date')}${f('to', 'Test up to', '', 'date')}</div>
  <label class="check"><input type="checkbox" data-set="pooc" ${settings.pooc ? 'checked' : ''}>Fill orders at the signal candle's close</label><p class="note">Normally an order fills at the next candle's open, the same as TradingView. NIFTY lot is 75 and BANK NIFTY 35 in the starters; set your own quantity if the exchange lot has changed.</p><button class="btn small primary" id="applySetup">Apply and run again</button>`;
  $$('[data-set]', el).forEach(i => (i.onchange = () => { settings[i.dataset.set] = i.type === 'checkbox' ? i.checked : i.value; store.set('settings', settings); }));
  $('#applySetup').onclick = () => { runAll(false); toast('Test setup applied'); };
}

/* ---------- data tab ---------- */
async function renderData() {
  const el = $('#v-data'), syms = Object.keys(SYMS);
  el.innerHTML = `<div class="rep-head"><h2>Data</h2><span class="muted">What is loaded and where it comes from</span><span class="spacer"></span><button class="btn small" id="refData">Refresh</button></div><div class="scroll" style="flex:1"><div class="rep-body"><div class="data-cards">${syms.map(s => { const st = A.status[s] || {}; return `<div class="panel"><header><h3>${SYMS[s]}</h3><p>${st.candles ? 'Loaded' : 'No candles yet'}</p></header><dl class="kv"><dt>5 minute candles</dt><dd>${(st.candles || 0).toLocaleString('en-IN')}</dd><dt>Trading days</dt><dd>${st.days || 0}</dd><dt>First candle</dt><dd>${st.first ? dtstr(st.first) : '–'}</dd><dt>Last candle</dt><dd>${st.last ? dtstr(st.last) : '–'}</dd><dt>Last price</dt><dd>${st.price != null ? f2(st.price) : '–'}${st.priceAt ? ' at ' + dtstr(st.priceAt) : ''}</dd><dt>Live price source</dt><dd>${esc(st.source || 'Not connected yet')}</dd>${st.error ? `<dt>Last problem</dt><dd class="down">${esc(st.error)}</dd>` : ''}</dl><div class="cover" id="cov-${s}" title="Trading days loaded in each month"></div><p class="note" id="covn-${s}" style="margin-top:6px"></p>
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px"><button class="btn small" data-dl="${s}">Download ${A.tf} min candles as CSV</button><label class="btn small">Import CSV<input type="file" accept=".csv,.txt" data-imp="${s}" hidden></label></div></div>`; }).join('')}</div>
  <div class="panel"><header><h3>How the data works</h3></header><p class="note" style="line-height:1.7">History is kept as 5 minute candles. The 15 and 30 minute candles are built from them, so all three always agree.<br>The live price comes from Yahoo Finance and is checked every 2 seconds during market hours (9:15 to 15:30, Monday to Friday). It is a free source and can lag the exchange by a few seconds.<br>CSV import accepts files with date, time, open, high, low and close columns (1, 3 or 5 minute candles, exchange time). Existing candles are kept, only missing ones are added.</p></div></div></div>`;
  $('#refData').onclick = refreshStatus;
  $$('[data-dl]', el).forEach(b => (b.onclick = async () => { const d = await loadData(b.dataset.dl, A.tf); const rows = ['datetime,open,high,low,close']; for (let i = 0; i < d.t.length; i++) rows.push(`${new Date((d.t[i] + IST) * 1000).toISOString().slice(0, 16).replace('T', ' ')},${d.o[i]},${d.h[i]},${d.l[i]},${d.c[i]}`); download(`${b.dataset.dl}_${A.tf}min.csv`, rows.join('\n')); }));
  $$('[data-imp]', el).forEach(inp => (inp.onchange = async () => { const f = inp.files[0]; if (!f) return; toast('Importing ' + f.name); try { const r = await fetch(`${API}/api/import?symbol=${inp.dataset.imp}`, { method: 'POST', body: await f.text() }), j = await r.json(); if (!r.ok) throw new Error(j.error); toast(`${j.added.toLocaleString('en-IN')} new candles added from ${j.rows.toLocaleString('en-IN')} rows`); for (const tf of [5, 15, 30]) delete A.data[key(inp.dataset.imp, tf)]; await refreshStatus(); if (inp.dataset.imp === A.symbol) switchData(); } catch (e) { toast('Import failed: ' + e.message, true); } }));
  for (const s of syms) { try { const d = await loadData(s, 30), months = {}; for (const t of d.t) { const x = new Date((t + IST) * 1000), k = x.getUTCFullYear() * 12 + x.getUTCMonth(); (months[k] || (months[k] = new Set())).add(x.getUTCDate()); }
      const ks = Object.keys(months).map(Number); if (!ks.length) { $('#covn-' + s).textContent = 'Nothing loaded yet.'; continue; } const a = Math.min(...ks), b = Math.max(...ks); let h = '', low = 0; for (let k = a; k <= b; k++) { const n = months[k] ? months[k].size : 0; if (n < 15 && k !== b && k !== a) low++; h += `<i class="${n < 15 && k !== b && k !== a ? 'low' : ''}" style="height:${Math.max(4, n / 23 * 100)}%" title="${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][k % 12]} ${Math.floor(k / 12)}: ${n} days"></i>`; }
      const c = $('#cov-' + s); if (c) { c.innerHTML = h; $('#covn-' + s).textContent = `Each bar is a month, height is the number of trading days loaded.${low ? ` ${low} month${low > 1 ? 's look' : ' looks'} incomplete (red).` : ''}`; } } catch (e) { /* card already shows the status */ } }
}

/* ---------- telegram alerts ---------- */
let tgConfig = {
  ownerActive: true,
  extraChatIds: [],
  friends: [],
  enabled: true,
  notifyEntries: true,
  notifyExits: true,
  notifyMarket: true,
  configured: false
};
let tgSyncSettingsUi = null;
async function fetchTgConfig(syncUi = true) {
  try {
    const res = await fetch(`${API}/api/telegram/config`);
    if (res.ok) {
      const j = await res.json();
      if (j && j.config) {
        tgConfig = Object.assign(tgConfig, j.config);
        if (!Array.isArray(tgConfig.friends)) {
          tgConfig.friends = (tgConfig.extraChatIds || []).map(id => ({ id, name: '', welcomed: false }));
        }
        if (syncUi && A.view === 'settings' && typeof tgSyncSettingsUi === 'function') {
          tgSyncSettingsUi();
        }
      }
    }
  } catch (_) {}
}
function fmtIST(epochSec) {
  if (!epochSec) return '';
  const d = new Date((epochSec + IST) * 1000);
  let h = d.getUTCHours(), m = d.getUTCMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ampm}`;
}

function watchTradeAlerts(S, trades, data, sym, tf) {
  // Client browser alert dispatcher disabled to prevent duplicate alerts.
  // The cloud server index.js (runCloudStrats) runs 24/7 on Render and delivers single, reliable push alerts.
  return;
}

/* ---------- settings tab ---------- */
function renderSettings() {
  const el = $('#v-settings');
  el.innerHTML = `<div class="rep-head"><h2>Settings</h2></div><div class="scroll" style="flex:1"><div class="rep-body"><div class="cols">
  <div class="panel" style="grid-column:1/-1">
    <header><h3>Telegram Alerts</h3><p>Instant trading alerts and daily market summaries delivered to your Telegram</p></header>
    <div style="display:flex;flex-direction:column;gap:12px;margin-top:12px">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="font-weight:600;font-size:12px;min-width:90px">Telegram Bot:</span>
        <span style="font-size:12px;color:var(--text);display:inline-flex;align-items:center;gap:6px">
          <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#35d6ae"></span>
          <b>@TradeX_terminal_bot</b> <span class="muted">(Secured on Server)</span>
        </span>
      </div>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="font-weight:600;font-size:12px;min-width:90px">Owner Alerts:</span>
        <span style="font-size:12px;color:var(--up);display:inline-flex;align-items:center;gap:6px">
          <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#35d6ae"></span>
          <b id="tgOwnerState">${tgConfig.ownerActive ? 'Secured & Locked on Server' : 'Server Env Protected'}</b>
          <span class="muted">(Cannot be viewed or removed from browser)</span>
        </span>
      </div>
      <div style="display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap">
        <span style="font-weight:600;font-size:12px;min-width:90px;padding-top:4px">Friends:</span>
        <div id="tgFriendsList" style="flex:1;min-width:190px;display:flex;gap:6px;flex-wrap:wrap;align-items:center"></div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <label style="font-weight:600;font-size:12px;min-width:90px">Add Friend:</label>
        <input type="text" id="tgAddFriendInp" class="inp" style="flex:1;min-width:190px;font-family:monospace;font-size:12px" placeholder="Enter friend's Telegram Chat ID (e.g. 1148568929)">
        <button type="button" class="btn primary small" id="tgAddFriendBtn">Add Friend</button>
        <button type="button" class="btn small" id="tgDetectBtn" title="Auto-detect latest friend Chat ID from Telegram">Auto-Detect Friend ID</button>
      </div>
      <details style="margin-top:2px">
        <summary style="font-size:12px;color:var(--muted);cursor:pointer;user-select:none">Change or Rotate Bot Token</summary>
        <div style="display:flex;align-items:center;gap:10px;margin-top:8px">
          <label style="font-weight:600;font-size:12px;min-width:90px">Bot Token:</label>
          <input type="password" id="tgTokenInp" class="inp" style="flex:1;min-width:220px;font-family:monospace;font-size:12px" placeholder="Paste new token from @BotFather">
        </div>
      </details>
      <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:12px;margin:4px 0">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="tgEnableInp" ${tgConfig.enabled ? 'checked' : ''}> Enable Notifications</label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="tgEntryInp" ${tgConfig.notifyEntries ? 'checked' : ''}> Trade Entries (BUY / SELL)</label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="tgExitInp" ${tgConfig.notifyExits ? 'checked' : ''}> Trade Exits (Points & Win/Loss)</label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="tgMarketInp" ${tgConfig.notifyMarket ? 'checked' : ''}> Market Open / Close (09:15 / 15:30)</label>
      </div>
      <div id="tgStatusMsg" style="font-size:12px;min-height:18px;font-weight:500"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px">
        <button class="btn primary small" id="tgSaveBtn">Save Settings</button>
        <button class="btn small" id="tgTestBtn">Send Test Alert</button>
        <a href="https://t.me/TradeX_terminal_bot" target="_blank" class="btn small" style="text-decoration:none">Open @TradeX_terminal_bot</a>
      </div>
      <p class="note" style="margin-top:6px;line-height:1.6">
        <b>How to add a Friend's Telegram ID:</b><br>
        1. Ask your friend to open <a href="https://t.me/TradeX_terminal_bot" target="_blank" style="color:var(--accent)">@TradeX_terminal_bot</a> in Telegram and tap <b>Start</b>.<br>
        2. Click <b>Auto-Detect Friend ID</b> (or paste their numeric Chat ID into <b>Add Friend</b>) and click <b>Add Friend</b>.<br>
        3. New friends automatically receive a TradeX introduction message (built by Dhruv) as their very first message, followed by live trade alerts.
      </p>
    </div>
  </div>
  <div class="panel"><header><h3>Look</h3></header><div class="chips"><button class="chip" data-th="dark" aria-pressed="${settings.theme === 'dark'}">Dark</button><button class="chip" data-th="light" aria-pressed="${settings.theme === 'light'}">Light</button></div></div>
  <div class="panel"><header><h3>Keyboard</h3></header><dl class="kv"><dt>Run the backtest</dt><dd><kbd>Ctrl</kbd> <kbd>Enter</kbd></dd><dt>Save the script</dt><dd><kbd>Ctrl</kbd> <kbd>S</kbd></dd><dt>Move the chart</dt><dd><kbd>←</kbd> <kbd>→</kbd> or drag</dd><dt>Zoom</dt><dd>Mouse wheel, <kbd>+</kbd> <kbd>−</kbd></dd><dt>Latest candles</dt><dd><kbd>End</kbd> or double click</dd><dt>Whole history</dt><dd><kbd>Home</kbd></dd></dl></div>
  <div class="panel"><header><h3>Pine support</h3><p>${Pine.functions.length} built-in functions</p></header><p class="note" style="line-height:1.7">Works: strategy and indicator scripts in v5 or v6 style, inputs, var, if, for, while, switch, your own functions, arrays, history like close[1], the common ta.* and math.* functions, strategy.entry, exit (stop, target, trailing), close, close_all, plot, plotshape, hline and bgcolor.<br>Not available: request.security, libraries, tables, labels and boxes (drawings are skipped, the logic still runs), matrices and maps. The editor names the line when a script uses something missing.</p></div>
  <div class="panel"><header><h3>Workspace</h3></header><dl class="kv"><dt>Server address</dt><dd>${esc(API || location.origin)}</dd><dt>Scripts saved in this browser</dt><dd>${scripts.length}</dd></dl><p style="margin:12px 0 0;display:flex;gap:8px;flex-wrap:wrap"><button class="btn small" id="expAll">Back up all scripts</button><button class="btn small" id="resetAll">Clear this browser's TradeX data</button></p><p class="note" style="margin-top:8px">Scripts and settings live in this browser only. Back them up before clearing browser data or moving to another computer.</p></div></div></div></div>`;

  let togglesDirty = false;
  let userActed = false;
  let detectedHint = null; // { chatId, name }

  const setTgStatus = (msg, isErr, isOk, colorOverride) => {
    const s = $('#tgStatusMsg'); if (!s) return;
    s.innerHTML = msg;
    s.style.color = colorOverride || (isErr ? 'var(--down)' : isOk ? 'var(--up)' : 'var(--muted)');
  };

  const getFriends = () => Array.isArray(tgConfig.friends) && tgConfig.friends.length
    ? tgConfig.friends
    : (tgConfig.extraChatIds || []).map(id => ({ id, name: '', welcomed: false }));

  const renderFriends = () => {
    const host = $('#tgFriendsList'); if (!host) return;
    const list = getFriends();
    if (!list.length) {
      host.innerHTML = '<span class="muted" style="font-size:12px">No friends added yet.</span>';
      return;
    }
    host.innerHTML = list.map(f => {
      const badgeColor = f.welcomed ? 'var(--up)' : '#f5a623';
      const badgeText = f.welcomed ? 'Active' : 'Waiting for Start';
      return `<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:999px;border:1px solid var(--line);background:var(--bg);font-size:12px">
        <span style="width:6px;height:6px;border-radius:50%;background:${badgeColor};display:inline-block"></span>
        <span style="font-family:monospace;font-weight:600">${esc(f.id)}</span>
        ${f.name ? `<span class="muted">(${esc(f.name)})</span>` : ''}
        <span style="font-size:11px;color:${badgeColor}">${badgeText}</span>
        <button type="button" class="tg-rm-friend" data-id="${esc(f.id)}" title="Remove friend ${esc(f.id)}" style="background:none;border:0;color:var(--muted);cursor:pointer;padding:0 2px;font-size:14px;line-height:1">×</button>
      </span>`;
    }).join('');
    $$('.tg-rm-friend', host).forEach(btn => {
      btn.onclick = async () => {
        const fid = btn.dataset.id;
        userActed = true;
        btn.disabled = true;
        setTgStatus(`Removing friend ${esc(fid)}...`, false, false);
        try {
          const res = await fetch(`${API}/api/telegram/friends/remove`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId: fid })
          });
          const j = await res.json();
          if (j && j.ok) {
            if (j.config) tgConfig = Object.assign(tgConfig, j.config);
            renderFriends();
            setTgStatus(`Removed friend <b>${esc(fid)}</b> from TradeX alerts.`, false, true);
          } else {
            btn.disabled = false;
            setTgStatus(`Failed to remove: ${esc((j && j.error) || 'Server error')}`, true);
          }
        } catch (e) {
          btn.disabled = false;
          setTgStatus(`Failed to remove: ${esc(e.message)}`, true);
        }
      };
    });
  };

  const renderSummaryStatus = () => {
    const cnt = getFriends().length;
    setTgStatus(
      `Owner notifications active & secured on server (@TradeX_terminal_bot)${cnt ? ` + ${cnt} friend${cnt > 1 ? 's' : ''}` : ''}`,
      false,
      true
    );
  };

  tgSyncSettingsUi = () => {
    if (!$('#tgFriendsList')) return;
    if ($('#tgOwnerState')) $('#tgOwnerState').textContent = tgConfig.ownerActive ? 'Secured & Locked on Server' : 'Server Env Protected';
    renderFriends();
    if (!togglesDirty) {
      if ($('#tgEnableInp')) $('#tgEnableInp').checked = !!tgConfig.enabled;
      if ($('#tgEntryInp')) $('#tgEntryInp').checked = !!tgConfig.notifyEntries;
      if ($('#tgExitInp')) $('#tgExitInp').checked = !!tgConfig.notifyExits;
      if ($('#tgMarketInp')) $('#tgMarketInp').checked = !!tgConfig.notifyMarket;
    }
    if (!userActed) renderSummaryStatus();
  };

  ['tgEnableInp', 'tgEntryInp', 'tgExitInp', 'tgMarketInp'].forEach(id => {
    const cb = $('#' + id);
    if (cb) cb.onchange = () => { togglesDirty = true; };
  });

  renderFriends();
  renderSummaryStatus();
  fetchTgConfig(true);

  const addFriendFromInput = async () => {
    const inp = $('#tgAddFriendInp');
    const raw = inp ? inp.value.trim() : '';
    if (!raw) {
      setTgStatus('Enter your friend\'s numeric Telegram Chat ID or click Auto-Detect Friend ID.', true);
      return { ok: false, empty: true };
    }
    const tokens = raw.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
    const bad = tokens.find(t => !/^-?\d+$/.test(t));
    if (bad) {
      setTgStatus(`Invalid Chat ID "<b>${esc(bad)}</b>". Telegram IDs contain numbers only — ask your friend to tap Start on @TradeX_terminal_bot, then click Auto-Detect Friend ID.`, true);
      return { ok: false };
    }
    const btn = $('#tgAddFriendBtn');
    userActed = true;
    if (btn) btn.disabled = true;
    setTgStatus('Adding friend and sending TradeX welcome message...', false, false);
    try {
      const hintName = (detectedHint && tokens.length === 1 && detectedHint.chatId === tokens[0]) ? detectedHint.name : '';
      const res = await fetch(`${API}/api/telegram/friends/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatIds: tokens, name: hintName })
      });
      const j = await res.json();
      if (j && j.config) tgConfig = Object.assign(tgConfig, j.config);
      renderFriends();
      if (!j || !j.ok) {
        setTgStatus(`${esc((j && j.error) || 'Failed to add friend')}`, true);
        return { ok: false };
      }
      if (inp) inp.value = '';
      detectedHint = null;
      const results = j.results || [];
      const sentNow = results.filter(r => r.welcomeSent);
      const waitingStart = results.filter(r => r.needsStart);
      const alreadyReady = results.filter(r => !r.welcomeSent && r.welcomed);
      const errored = results.filter(r => !r.welcomed && !r.needsStart);
      if (waitingStart.length && !sentNow.length) {
        setTgStatus(
          `Friend <b>${esc(waitingStart.map(r => r.chatId).join(', '))}</b> added! Ask them to open <a href="https://t.me/TradeX_terminal_bot" target="_blank" style="color:var(--accent)">@TradeX_terminal_bot</a> and tap <b>Start</b> — TradeX will send the welcome intro (built by Dhruv) as their very first message.`,
          false,
          false,
          '#f5a623'
        );
      } else if (errored.length && !sentNow.length && !alreadyReady.length) {
        setTgStatus(`Friend saved, but Telegram returned: ${esc(errored[0].error || 'Unknown error')}`, true);
      } else if (sentNow.length) {
        const names = sentNow.map(r => `${esc(r.chatId)}${r.name ? ` (${esc(r.name)})` : ''}`).join(', ');
        const extra = waitingStart.length ? ` • Waiting for Start: ${esc(waitingStart.map(r => r.chatId).join(', '))}` : '';
        setTgStatus(`Friend <b>${names}</b> added &amp; TradeX welcome intro delivered as their first message!${extra}`, false, true);
      } else {
        const names = alreadyReady.map(r => `${esc(r.chatId)}${r.name ? ` (${esc(r.name)})` : ''}`).join(', ');
        setTgStatus(`Friend <b>${names}</b> is active in TradeX alerts.`, false, true);
      }
      return { ok: true, results };
    } catch (e) {
      setTgStatus(`Failed to add friend: ${esc(e.message)}`, true);
      return { ok: false };
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  $('#tgAddFriendBtn').onclick = () => addFriendFromInput();
  $('#tgAddFriendInp').onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addFriendFromInput(); }
  };

  $('#tgSaveBtn').onclick = async () => {
    userActed = true;
    if ($('#tgAddFriendInp') && $('#tgAddFriendInp').value.trim()) {
      const addRes = await addFriendFromInput();
      if (!addRes.ok) return;
    }
    tgConfig.enabled = $('#tgEnableInp').checked;
    tgConfig.notifyEntries = $('#tgEntryInp').checked;
    tgConfig.notifyExits = $('#tgExitInp').checked;
    tgConfig.notifyMarket = $('#tgMarketInp').checked;
    const newTok = $('#tgTokenInp') ? $('#tgTokenInp').value.trim() : '';
    const payload = {
      enabled: tgConfig.enabled,
      notifyEntries: tgConfig.notifyEntries,
      notifyExits: tgConfig.notifyExits,
      notifyMarket: tgConfig.notifyMarket
    };
    if (newTok) payload.token = newTok;
    try {
      const res = await fetch(`${API}/api/telegram/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const j = await res.json();
      if (j && j.ok) {
        togglesDirty = false;
        if (j.config) tgConfig = Object.assign(tgConfig, j.config);
        renderFriends();
        if (newTok) {
          $('#tgTokenInp').value = '';
          setTgStatus('Telegram token and settings updated successfully.', false, true);
        } else {
          setTgStatus('Telegram settings saved. Owner alerts remain locked on server.', false, true);
        }
      } else {
        setTgStatus(`Failed to save: ${esc(j ? j.error : 'Server error')}`, true);
      }
    } catch (e) {
      setTgStatus(`Failed to save: ${esc(e.message)}`, true);
    }
  };

  $('#tgDetectBtn').onclick = async () => {
    userActed = true;
    const btn = $('#tgDetectBtn');
    if (btn) btn.disabled = true;
    setTgStatus('Checking Telegram for latest friend Chat ID...', false, false);
    try {
      const res = await fetch(`${API}/api/telegram/detect`);
      const j = await res.json();
      if (j && j.ok && j.chatId) {
        detectedHint = { chatId: j.chatId, name: j.name || '' };
        if ($('#tgAddFriendInp')) $('#tgAddFriendInp').value = j.chatId;
        const label = `${esc(j.chatId)}${j.name ? ` (${esc(j.name)})` : ''}`;
        if (j.alreadyAdded) {
          setTgStatus(`Detected Friend ID: <b>${label}</b> (already in your Friends list).`, false, true);
        } else {
          setTgStatus(`Detected Friend Chat ID: <b>${label}</b>. Click <b>Add Friend</b> to activate &amp; send their TradeX welcome message.`, false, true);
          if ($('#tgAddFriendBtn')) $('#tgAddFriendBtn').focus();
        }
      } else {
        setTgStatus(`${esc((j && j.error) || 'Could not find message. Ask your friend to open @TradeX_terminal_bot and tap Start.')}`, true);
      }
    } catch (e) {
      setTgStatus(`Error detecting chat: ${esc(e.message)}`, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  $('#tgTestBtn').onclick = async () => {
    userActed = true;
    if ($('#tgAddFriendInp') && $('#tgAddFriendInp').value.trim()) {
      const addRes = await addFriendFromInput();
      if (!addRes.ok) return;
    }
    const btn = $('#tgTestBtn');
    if (btn) btn.disabled = true;
    setTgStatus('Sending test alert to Telegram...', false, false);
    try {
      const res = await fetch(`${API}/api/telegram/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const j = await res.json();
      await fetchTgConfig(false);
      renderFriends();
      if (j && (j.ok || j.allDelivered)) {
        const fr = j.friendResults || [];
        const okFriends = fr.filter(f => f.ok);
        const needsStart = fr.filter(f => !f.ok && f.needsStart);
        const failed = fr.filter(f => !f.ok && !f.needsStart);
        if (!needsStart.length && !failed.length && j.ownerOk !== false) {
          setTgStatus(
            `Test alert delivered to Owner${okFriends.length ? ` &amp; ${okFriends.length} friend${okFriends.length > 1 ? 's' : ''}` : ''}. Check Telegram!`,
            false,
            true
          );
        } else {
          const parts = [];
          if (j.ownerOk) parts.push('Owner delivered');
          if (okFriends.length) parts.push(`${okFriends.length} friend${okFriends.length > 1 ? 's' : ''} delivered`);
          if (needsStart.length) parts.push(`Friend ${esc(needsStart.map(f => f.chatId).join(', '))} must tap Start on @TradeX_terminal_bot first`);
          if (failed.length) parts.push(`Failed for ${esc(failed.map(f => `${f.chatId} (${f.error || 'error'})`).join(', '))}`);
          setTgStatus(parts.join(' • '), false, false, needsStart.length ? '#f5a623' : 'var(--down)');
        }
      } else {
        setTgStatus(`Delivery failed: ${esc((j && j.error) || 'Telegram API error')}`, true);
      }
    } catch (e) {
      setTgStatus(`Delivery failed: ${esc(e.message)}`, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  $$('[data-th]', el).forEach(b => (b.onclick = () => { settings.theme = b.dataset.th; applyTheme(); }));
  $('#expAll').onclick = () => download('TradeX scripts backup.json', JSON.stringify(scripts, null, 1));
  $('#resetAll').onclick = () => { if (confirm('Delete all scripts and settings saved in this browser? This cannot be undone.')) { Object.keys(localStorage).filter(k => k.startsWith('tx.')).forEach(k => localStorage.removeItem(k)); location.reload(); } };
}

/* ---------- start ---------- */
for (const o of store.get('onchart', [])) if (scripts.find(s => s.id === o.scriptId)) A.strats.push({ id: uid(), scriptId: o.scriptId, color: o.color, visible: o.visible !== false, inputs: o.inputs || {}, name: scripts.find(s => s.id === o.scriptId).name });
if (innerWidth <= 900) setDockClosed(true);
paintSyms(); paintDock(); pushLayers(); go(location.hash.slice(1) || 'chart'); requestAnimationFrame(() => { paintTf(); paintDockTabs(); }); if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { paintTf(); paintDockTabs(); });
fetchTgConfig();
fetchCloudStrats();
refreshStatus().then(() => switchData()); connect(); setInterval(paintFeed, 1000); setInterval(refreshStatus, 30000);
window.TX = { A, chart };
})();
