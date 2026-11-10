/* TradeX candle chart, drawn on canvas. Index-based x axis (no gaps between sessions). */
(function (root) {
'use strict';
const IST = 19800, AXW = 68, AXH = 26, MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const d2 = x => String(x).padStart(2, '0');
function fmtTime(t, withDate) { const d = new Date((t + IST) * 1000), hm = d2(d.getUTCHours()) + ':' + d2(d.getUTCMinutes()); return withDate ? `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}  ${hm}` : hm; }
function niceStep(range, target) { const raw = range / target, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p; return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p; }

class TXChart {
  constructor(el) {
    this.el = el; this.cv = document.createElement('canvas'); this.cv.className = 'tx-chart'; this.cv.tabIndex = 0; el.appendChild(this.cv);
    this.ctx = this.cv.getContext('2d'); this.d = null; this.n = 0; this.bw = 8; this.right = 0; this.layers = []; this.cross = null; this.h = {};
    this.vel = 0; this.anim = null; this.dirty = false; this.follow = true; this.subH = 0; this.hit = [];
    new ResizeObserver(() => this.resize()).observe(el); this.bind(); this.theme(); this.resize();
  }
  on(ev, fn) { this.h[ev] = fn; return this; }
  emit(ev, a) { if (this.h[ev]) this.h[ev](a); }
  theme() { const cs = getComputedStyle(this.el), g = k => cs.getPropertyValue(k).trim(); this.col = { bg: g('--surface') || '#15131c', grid: g('--line') || '#262233', text: g('--text') || '#eee', muted: g('--muted') || '#888', up: g('--up') || '#35d6ae', down: g('--down') || '#ff5f7a', accent: g('--accent') || '#ffb224', font: g('--font') || 'sans-serif' }; this.draw(); }
  resize() { const r = this.el.getBoundingClientRect(), dpr = window.devicePixelRatio || 1; if (!r.width || !r.height) return; this.W = r.width; this.H = r.height; this.cv.width = Math.round(r.width * dpr); this.cv.height = Math.round(r.height * dpr); this.cv.style.width = r.width + 'px'; this.cv.style.height = r.height + 'px'; this.dpr = dpr; this.clamp(); this.draw(); }
  get pw() { return this.W - AXW; }
  setData(d, tf, keepView) {
    const first = !this.d || !keepView; this.d = d; this.n = d.t.length; this.tf = tf;
    this.rank = new Uint8Array(this.n); let pd = null;
    for (let i = 0; i < this.n; i++) { const x = new Date((d.t[i] + IST) * 1000), k = [x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()]; this.rank[i] = !pd ? 3 : k[0] !== pd[0] ? 4 : k[1] !== pd[1] ? 3 : k[2] !== pd[2] ? 2 : (x.getUTCMinutes() === 15 && tf < 30 ? 1 : 0); pd = k; }
    if (first) { this.bw = 8; this.right = this.n - 1 + 6; this.follow = true; } this.clamp(); this.draw();
  }
  updateLast(bar) { // bar: [t,o,h,l,c] for the chart's own timeframe
    const d = this.d; if (!d) return; const n = this.n;
    if (n && d.t[n - 1] === bar[0]) { d.o[n - 1] = bar[1]; d.h[n - 1] = bar[2]; d.l[n - 1] = bar[3]; d.c[n - 1] = bar[4]; }
    else if (!n || bar[0] > d.t[n - 1]) { d.t.push(bar[0]); d.o.push(bar[1]); d.h.push(bar[2]); d.l.push(bar[3]); d.c.push(bar[4]); this.n++; const r = new Uint8Array(this.n); r.set(this.rank); r[this.n - 1] = n && Math.floor((bar[0] + IST) / 86400) !== Math.floor((d.t[n - 1] + IST) / 86400) ? 2 : 0; this.rank = r; if (this.follow) this.right += 1; }
    this.flash = performance.now(); this.draw();
  }
  setLayers(layers) { this.layers = layers || []; this.draw(); }
  clamp() { if (!this.n) return; const minBw = Math.max(0.01, this.pw / (this.n + 12)); this.bw = Math.min(140, Math.max(minBw, this.bw)); const vis = this.pw / this.bw; this.right = Math.min(this.n - 1 + vis * 0.6, Math.max(Math.min(vis * 0.4, this.n - 1), this.right)); this.follow = this.right >= this.n - 1; }
  x(i) { return this.pw - (this.right - i) * this.bw - this.bw / 2; }
  idx(x) { return Math.round(this.right - (this.pw - x - this.bw / 2) / this.bw); }
  animateTo(right, bw, ms) {
    cancelAnimationFrame(this.anim); const r0 = this.right, b0 = this.bw, t0 = performance.now(); ms = ms || 420;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) ms = 1;
    const step = now => { const k = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - k, 3); this.bw = Math.exp(Math.log(b0) + (Math.log(bw) - Math.log(b0)) * e); this.right = r0 + (right - r0) * e; this.clamp(); this.draw(); if (k < 1) this.anim = requestAnimationFrame(step); };
    this.anim = requestAnimationFrame(step);
  }
  goToIndex(i, bw) { bw = bw || Math.max(this.bw, 7); this.animateTo(i + this.pw / bw / 2, bw); }
  goToTime(t) { const d = this.d; if (!d) return; let lo = 0, hi = this.n - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (d.t[m] < t) lo = m + 1; else hi = m; } this.goToIndex(lo); }
  showRange(i0, i1) { const span = Math.max(10, i1 - i0 + 1), bw = this.pw / (span * 1.08); this.animateTo(i1 + span * 0.04, bw); }
  showLast(bars) { this.showRange(Math.max(0, this.n - bars), this.n - 1); }
  fitAll() { this.showRange(0, this.n - 1); }
  goLatest() { if (!this.n) return; const vis = this.pw / this.bw; this.animateTo(this.n - 1 + Math.min(6, vis * 0.15), this.bw, 520); }
  zoom(f, cx) { if (this.n) { const lx = this.x(this.n - 1); if (cx > lx && lx > 0) cx = lx; } const i = this.right - (this.pw - cx) / this.bw; this.bw *= f; this.clamp(); this.right = i + (this.pw - cx) / this.bw; this.clamp(); this.draw(); }
  bind() {
    const cv = this.cv, pts = new Map(); let lastX = 0, lastT = 0, pinch = 0, moved = 0;
    cv.addEventListener('wheel', e => { e.preventDefault(); cancelAnimationFrame(this.anim); if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) { this.right += e.deltaX / this.bw; this.clamp(); this.draw(); } else this.zoom(Math.exp(-e.deltaY * 0.0016), Math.min(e.offsetX, this.pw)); }, { passive: false });
    cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); pts.set(e.pointerId, e.offsetX); lastX = e.offsetX; lastT = e.timeStamp; this.vel = 0; moved = 0; cancelAnimationFrame(this.anim); if (pts.size === 2) { const v = [...pts.values()]; pinch = Math.abs(v[0] - v[1]); } cv.classList.add('grab'); });
    cv.addEventListener('pointermove', e => {
      if (pts.has(e.pointerId)) {
        pts.set(e.pointerId, e.offsetX);
        if (pts.size === 2) { const v = [...pts.values()], dist = Math.abs(v[0] - v[1]); if (pinch > 10 && dist > 10) this.zoom(dist / pinch, (v[0] + v[1]) / 2); pinch = dist; return; }
        const dx = e.offsetX - lastX, dtm = Math.max(1, e.timeStamp - lastT); moved += Math.abs(dx); this.right -= dx / this.bw; this.vel = dx / dtm; lastX = e.offsetX; lastT = e.timeStamp; this.clamp();
      }
      this.cross = { x: e.offsetX, y: e.offsetY }; this.draw(); this.emitCross();
    });
    const up = e => { if (!pts.has(e.pointerId)) return; pts.delete(e.pointerId); cv.classList.remove('grab'); if (moved < 4) { const hit = this.hit.find(q => Math.abs(q.x - e.offsetX) < 9 && Math.abs(q.y - e.offsetY) < 11); this.emit('click', { index: this.idx(e.offsetX), trade: hit ? hit.trade : null, layer: hit ? hit.layer : null }); } else if (Math.abs(this.vel) > 0.25 && e.timeStamp - lastT < 60) this.fling(); };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', () => { this.cross = null; this.draw(); this.emitCross(); });
    cv.addEventListener('dblclick', () => this.showLast(Math.round(this.pw / 8)));
    cv.addEventListener('keydown', e => { const k = e.key; if (k === 'ArrowLeft' || k === 'ArrowRight') { this.right += (k === 'ArrowLeft' ? -1 : 1) * Math.max(1, 40 / this.bw); this.clamp(); this.draw(); e.preventDefault(); } else if (k === '+' || k === '=') this.zoom(1.25, this.pw / 2); else if (k === '-') this.zoom(0.8, this.pw / 2); else if (k === 'End') this.showLast(Math.round(this.pw / this.bw)); else if (k === 'Home') this.fitAll(); });
  }
  fling() { let v = this.vel * 16; const step = () => { v *= 0.93; this.right -= v / this.bw; this.clamp(); this.draw(); if (Math.abs(v) > 0.4) this.anim = requestAnimationFrame(step); }; this.anim = requestAnimationFrame(step); }
  emitCross() { if (!this.d) return; let i = this.cross ? this.idx(this.cross.x) : this.n - 1; i = Math.max(0, Math.min(this.n - 1, i)); this.emit('cross', { index: i, active: !!this.cross }); }
  draw() { if (this.dirty) return; this.dirty = true; requestAnimationFrame(() => { this.dirty = false; this.paint(); const away = !!this.n && this.right < this.n - 1.5; if (away !== this._away) { this._away = away; this.emit('view', { away }); } }); }
  paint() {
    const c = this.ctx, W = this.W, H = this.H, col = this.col, d = this.d; if (!W || !H) return;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); c.fillStyle = col.bg; c.fillRect(0, 0, W, H);
    if (!d || !this.n) { c.fillStyle = col.muted; c.font = `14px ${col.font}`; c.textAlign = 'center'; c.fillText(this.emptyText || 'Loading candles', W / 2, H / 2); return; }
    const pw = this.pw, bw = this.bw, subs = this.layers.filter(L => L.visible !== false && !L.overlay && L.plots && L.plots.length);
    const subH = subs.length ? Math.round((H - AXH) * 0.26) : 0, mainH = H - AXH - subH; this.mainH = mainH;
    const i0 = Math.max(0, Math.floor(this.right - pw / bw) - 1), i1 = Math.min(this.n - 1, Math.ceil(this.right) + 1);
    let lo = Infinity, hi = -Infinity; for (let i = i0; i <= i1; i++) { if (d.l[i] < lo) lo = d.l[i]; if (d.h[i] > hi) hi = d.h[i]; }
    if (!(hi > lo)) { hi = lo + 1; lo -= 1; }
    const span0 = hi - lo;
    for (const L of this.layers) if (L.visible !== false && L.overlay && L.plots) for (const p of L.plots) { const st = Math.max(1, Math.floor((i1 - i0) / 400)); for (let i = i0; i <= i1; i += st) { const v = p.data[i]; if (v === v && v > lo - span0 * 0.6 && v < hi + span0 * 0.6) { if (v < lo) lo = v; if (v > hi) hi = v; } } }
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    const y = v => 8 + (hi - v) / (hi - lo) * (mainH - 16); this.yv = py => hi - (py - 8) / (mainH - 16) * (hi - lo);
    c.save(); c.beginPath(); c.rect(0, 0, pw, mainH); c.clip();
    // background bands from scripts
    for (const L of this.layers) if (L.visible !== false && L.bg && L.bg.length && bw > 0.6) { for (const b of L.bg) { if (b[0] < i0 || b[0] > i1) continue; c.fillStyle = b[1]; c.fillRect(this.x(b[0]) - bw / 2, 0, Math.max(1, bw), mainH); } }
    // grid
    c.strokeStyle = col.grid; c.lineWidth = 1; c.beginPath(); const ps = niceStep(hi - lo, mainH / 56), pticks = [];
    for (let v = Math.ceil(lo / ps) * ps; v < hi; v += ps) { const yy = Math.round(y(v)) + 0.5; c.moveTo(0, yy); c.lineTo(pw, yy); pticks.push([v, yy]); }
    c.stroke();
    // time ticks
    const maxT = Math.max(2, Math.floor(pw / 96)), cnt = [0, 0, 0, 0, 0]; for (let i = i0; i <= i1; i++) cnt[this.rank[i]]++;
    let lvl = 4, acc = 0; for (let r = 4; r >= 0; r--) { acc += cnt[r]; if (acc <= maxT) lvl = r; else break; }
    const tt = []; let lastTx = -1e9; for (let i = i0; i <= i1; i++) if (this.rank[i] >= lvl) { const xx = this.x(i); if (xx - lastTx < 64) continue; lastTx = xx; tt.push([i, xx]); }
    if (lvl === 0 && !tt.length) { const stp = Math.max(1, Math.round(96 / bw)); for (let i = Math.ceil(i0 / stp) * stp; i <= i1; i += stp) tt.push([i, this.x(i)]); }
    c.beginPath(); for (const [i, xx] of tt) { if (this.rank[i] >= 2) { c.moveTo(Math.round(xx - bw / 2) + 0.5, 0); c.lineTo(Math.round(xx - bw / 2) + 0.5, mainH); } } c.globalAlpha = 0.7; c.stroke(); c.globalAlpha = 1;
    // candles
    if (bw >= 2.2) {
      const body = Math.max(1, Math.floor(bw * 0.72));
      for (const dir of [1, -1]) { c.fillStyle = c.strokeStyle = dir > 0 ? col.up : col.down; c.beginPath(); for (let i = i0; i <= i1; i++) { const up = d.c[i] >= d.o[i]; if ((dir > 0) !== up) continue; const xx = Math.round(this.x(i)), yo = y(d.o[i]), yc = y(d.c[i]), top = Math.min(yo, yc); c.rect(xx - Math.floor(body / 2), top, body, Math.max(1, Math.abs(yc - yo))); c.rect(xx, y(d.h[i]), 1, y(d.l[i]) - y(d.h[i])); } c.fill(); }
    } else { // many candles per pixel: draw the high-low range of each pixel column
      let px = -1, mn = 0, mx = 0, fo = 0, lc = 0; const flush = () => { if (px < 0) return; c.fillStyle = lc >= fo ? col.up : col.down; c.fillRect(px, y(mx), 1, Math.max(1, y(mn) - y(mx))); };
      for (let i = i0; i <= i1; i++) { const xx = Math.round(this.x(i)); if (xx !== px) { flush(); px = xx; mn = d.l[i]; mx = d.h[i]; fo = d.o[i]; } else { if (d.l[i] < mn) mn = d.l[i]; if (d.h[i] > mx) mx = d.h[i]; } lc = d.c[i]; } flush();
    }
    // script plots on price
    const line = (p, yf, defCol) => {
      const st = bw < 1 ? Math.max(1, Math.floor(1 / bw)) : 1; c.lineWidth = Math.min(4, p.width || 1) + 0.4; c.lineJoin = 'round'; let cur = -1, open = false;
      for (let i = i0; i <= i1; i += st) { const v = p.data[i]; if (v !== v) { if (open) { c.stroke(); open = false; } cur = -1; continue; } const ci = p.ci ? p.ci[i] : 0, xx = this.x(i), yy = yf(v);
        if (ci !== cur || !open) { if (open) { c.lineTo(xx, yy); c.stroke(); } c.beginPath(); c.strokeStyle = (p.pal && p.pal[ci]) || defCol; c.moveTo(xx, yy); open = true; cur = ci; } else c.lineTo(xx, yy); }
      if (open) c.stroke();
    };
    this.hit = [];
    for (const L of this.layers) {
      if (L.visible === false) continue;
      if (L.overlay && L.plots) for (const p of L.plots) line(p, y, L.color);
      if (L.overlay && L.hlines) for (const hl of L.hlines) { c.strokeStyle = hl.color || L.color; c.setLineDash([4, 4]); c.beginPath(); c.moveTo(0, y(hl.price)); c.lineTo(pw, y(hl.price)); c.stroke(); c.setLineDash([]); }
      if (L.shapes && bw > 1.5) for (const s of L.shapes) { if (s.i < i0 || s.i > i1) continue; const xx = this.x(s.i), below = /below/.test(s.loc), yy = below ? y(d.l[s.i]) + 12 : y(d.h[s.i]) - 12; c.fillStyle = s.color || L.color; c.beginPath(); if (/down/.test(s.style)) { c.moveTo(xx - 4, yy - 4); c.lineTo(xx + 4, yy - 4); c.lineTo(xx, yy + 3); } else if (/up/.test(s.style)) { c.moveTo(xx - 4, yy + 4); c.lineTo(xx + 4, yy + 4); c.lineTo(xx, yy - 3); } else c.arc(xx, yy, 3, 0, 7); c.fill(); if (s.text && bw > 5) { c.font = `10px ${col.font}`; c.textAlign = 'center'; c.fillText(s.text, xx, yy + (below ? 14 : -8)); } }
      if (L.trades && L.trades.length) this.paintTrades(L, i0, i1, y);
    }
    // last price
    const lp = d.c[this.n - 1], ly = Math.round(y(lp)) + 0.5, upL = lp >= d.o[this.n - 1];
    c.strokeStyle = upL ? col.up : col.down; c.setLineDash([2, 3]); c.beginPath(); c.moveTo(0, ly); c.lineTo(pw, ly); c.stroke(); c.setLineDash([]);
    c.restore();
    // sub pane
    if (subH) {
      const top = mainH, sy0 = top + 6, sh = subH - 12; let slo = Infinity, shi = -Infinity;
      for (const L of subs) { for (const p of L.plots) for (let i = i0; i <= i1; i++) { const v = p.data[i]; if (v === v) { if (v < slo) slo = v; if (v > shi) shi = v; } } for (const hl of L.hlines || []) { if (hl.price < slo) slo = hl.price; if (hl.price > shi) shi = hl.price; } }
      if (!(shi > slo)) { shi = slo + 1; slo -= 1; } const sy = v => sy0 + (shi - v) / (shi - slo) * sh;
      c.strokeStyle = col.grid; c.beginPath(); c.moveTo(0, top + 0.5); c.lineTo(W, top + 0.5); c.stroke();
      c.save(); c.beginPath(); c.rect(0, top, pw, subH); c.clip();
      for (const L of subs) { for (const hl of L.hlines || []) { c.strokeStyle = hl.color || col.muted; c.setLineDash([4, 4]); c.beginPath(); c.moveTo(0, sy(hl.price)); c.lineTo(pw, sy(hl.price)); c.stroke(); c.setLineDash([]); } for (const p of L.plots) line(p, sy, L.color); }
      c.restore(); c.fillStyle = col.muted; c.font = `11px ${col.font}`; c.textAlign = 'left'; c.textBaseline = 'middle';
      c.fillText(shi.toFixed(shi > 1000 ? 0 : 2), pw + 8, sy0 + 4); c.fillText(slo.toFixed(slo > 1000 ? 0 : 2), pw + 8, sy0 + sh - 4); c.fillText(subs.map(L => L.name).join(', ').slice(0, 60), 8, top + 12);
    }
    // axes
    c.fillStyle = col.bg; c.fillRect(pw, 0, AXW, mainH); c.fillRect(0, H - AXH, W, AXH);
    c.strokeStyle = col.grid; c.beginPath(); c.moveTo(pw + 0.5, 0); c.lineTo(pw + 0.5, H - AXH); c.moveTo(0, H - AXH + 0.5); c.lineTo(W, H - AXH + 0.5); c.stroke();
    c.fillStyle = col.muted; c.font = `11px ${col.font}`; c.textAlign = 'left'; c.textBaseline = 'middle';
    for (const [v, yy] of pticks) c.fillText(v.toLocaleString('en-IN', { maximumFractionDigits: ps < 1 ? 2 : 0 }), pw + 8, yy);
    c.textAlign = 'center';
    for (const [i, xx] of tt) { if (xx < 20 || xx > pw - 20) continue; const x = new Date((d.t[i] + IST) * 1000), r = this.rank[i]; const txt = r >= 4 ? String(x.getUTCFullYear()) : r === 3 ? (lvl >= 3 ? MON[x.getUTCMonth()] + (x.getUTCMonth() === 0 ? ' ' + x.getUTCFullYear() : '') : x.getUTCDate() + ' ' + MON[x.getUTCMonth()]) : r === 2 ? x.getUTCDate() + ' ' + MON[x.getUTCMonth()] : fmtTime(d.t[i]); c.fillStyle = r >= 2 ? col.text : col.muted; c.fillText(txt, xx, H - AXH / 2); }
    const tag = (yy, txt, bg, fg) => { c.fillStyle = bg; c.beginPath(); c.roundRect(pw + 1, yy - 9, AXW - 3, 18, 3); c.fill(); c.fillStyle = fg; c.textAlign = 'left'; c.font = `600 11px ${col.font}`; c.fillText(txt, pw + 7, yy + 0.5); };
    if (ly > 0 && ly < mainH) tag(ly, lp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), upL ? col.up : col.down, '#0d0b12');
    // crosshair
    if (this.cross && this.cross.x < pw && this.cross.y < H - AXH) {
      const i = Math.max(0, Math.min(this.n - 1, this.idx(this.cross.x))), cx = Math.round(this.x(i)) + 0.5, cy = Math.round(this.cross.y) + 0.5;
      c.strokeStyle = col.muted; c.setLineDash([3, 3]); c.beginPath(); c.moveTo(cx, 0); c.lineTo(cx, H - AXH); c.moveTo(0, cy); c.lineTo(pw, cy); c.stroke(); c.setLineDash([]);
      if (cy < mainH) tag(cy, this.yv(cy).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), col.text, col.bg);
      const lbl = fmtTime(d.t[i], true); c.font = `600 11px ${col.font}`; const tw = c.measureText(lbl).width + 14, tx = Math.max(2, Math.min(pw - tw - 2, cx - tw / 2)); c.fillStyle = col.text; c.beginPath(); c.roundRect(tx, H - AXH + 3, tw, AXH - 6, 3); c.fill(); c.fillStyle = col.bg; c.textAlign = 'center'; c.fillText(lbl, tx + tw / 2, H - AXH / 2 + 0.5);
    }
  }
  paintTrades(L, i0, i1, y) {
    const c = this.ctx, d = this.d, bw = this.bw, col = this.col, tr = L.trades, ink = document.documentElement.dataset.theme === 'light' ? '#ffffff' : '#0d0b12'; let lo = 0, hi = tr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (tr[m].xi < i0) lo = m + 1; else hi = m; }
    const money = v => { const a = Math.abs(v); return (v >= 0 ? '+' : '−') + '₹' + (a >= 1e5 ? (a / 1e5).toFixed(2) + 'L' : a >= 1e3 ? (a / 1e3).toFixed(1) + 'k' : a.toFixed(0)); };
    const pill = (x, yy, txt, bg, fg, align) => { c.font = `700 10px ${col.font}`; const w = c.measureText(txt).width + 10, h = 16, px = align === 'l' ? x : align === 'r' ? x - w : x - w / 2; c.fillStyle = bg; c.beginPath(); c.roundRect(px, yy - h / 2, w, h, 4); c.fill(); c.fillStyle = fg; c.textAlign = 'left'; c.textBaseline = 'middle'; c.fillText(txt, px + 5, yy + 0.5); return px + w / 2; };
    let shown = 0; const dense = bw < 3; c.save();
    for (let k = lo; k < tr.length && shown < 1500; k++) {
      const t = tr[k]; if (t.ei > i1) break; shown++;
      const x1 = this.x(t.ei), x2 = this.x(t.xi), y1 = y(t.ep), y2 = y(t.xp), win = t.pnl >= 0, rc = win ? col.up : col.down, long = t.dir > 0, sc = long ? col.up : col.down;
      // result zone: box from entry price to exit price across the holding period, green for profit, red for loss
      c.fillStyle = rc; c.globalAlpha = dense ? 0.10 : 0.14; c.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.max(1, Math.abs(x2 - x1)), Math.max(1, Math.abs(y2 - y1))); c.globalAlpha = 1;
      c.strokeStyle = rc; c.globalAlpha = dense ? 0.55 : 0.9; c.lineWidth = dense ? 1 : 1.4; c.setLineDash(dense ? [] : [5, 4]); c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); c.setLineDash([]); c.globalAlpha = 1;
      if (dense) continue;
      // entry and exit price levels
      c.lineWidth = 1.5; c.strokeStyle = col.text; c.globalAlpha = 0.65; c.beginPath(); c.moveTo(x1 - bw * 0.6, y1); c.lineTo(x1 + Math.max(bw * 0.6, Math.min(x2 - x1, 40)), y1); c.stroke(); c.globalAlpha = 1;
      c.strokeStyle = rc; c.beginPath(); c.moveTo(x2 - Math.max(bw * 0.6, Math.min(x2 - x1, 40)), y2); c.lineTo(x2 + bw * 0.6, y2); c.stroke();
      // entry arrow: BUY (green, below the candle, pointing up) or SELL (red, above the candle, pointing down)
      const ey = long ? y(d.l[t.ei]) + 6 : y(d.h[t.ei]) - 6;
      c.fillStyle = sc; c.beginPath(); if (long) { c.moveTo(x1, ey); c.lineTo(x1 - 6, ey + 9); c.lineTo(x1 + 6, ey + 9); } else { c.moveTo(x1, ey); c.lineTo(x1 - 6, ey - 9); c.lineTo(x1 + 6, ey - 9); } c.fill();
      const py = long ? ey + 19 : ey - 19;
      if (bw >= 5) pill(x1, py, long ? 'BUY' : 'SELL', sc, ink, 'c');
      // exit marker: ring filled with the result colour
      c.strokeStyle = col.text; c.lineWidth = 1.5; c.fillStyle = rc; c.beginPath(); c.arc(x2, y2, 4.5, 0, 7); c.fill(); c.stroke();
      // result label at the exit: points captured and money
      const ly = y2;
      if (bw >= 5) {
        // points captured is the headline (large, bold pill); money is a small secondary note beside it
        const ptxt = `${t.pts >= 0 ? '+' : '−'}${Math.abs(t.pts).toFixed(1)} pts`; c.font = `800 12px ${col.font}`; const pw = c.measureText(ptxt).width + 12, ph = 20, ppx = x2 + 9;
        c.fillStyle = rc; c.beginPath(); c.roundRect(ppx, ly - ph / 2, pw, ph, 5); c.fill(); c.fillStyle = ink; c.textAlign = 'left'; c.textBaseline = 'middle'; c.fillText(ptxt, ppx + 6, ly + 0.5);
        c.font = `500 10px ${col.font}`; c.globalAlpha = 0.75; c.fillStyle = col.text; c.fillText(money(t.pnl), ppx + pw + 5, ly + 0.5); c.globalAlpha = 1;
      }
      else if (bw >= 3.5) { c.font = `600 10px ${col.font}`; c.textAlign = 'left'; c.textBaseline = 'middle'; c.fillStyle = rc; c.fillText((t.pts >= 0 ? '+' : '') + t.pts.toFixed(0), x2 + 7, ly); }
      this.hit.push({ x: x1, y: ey + (long ? 5 : -5), trade: t, layer: L }, { x: x1, y: py, trade: t, layer: L }, { x: x2, y: y2, trade: t, layer: L }, { x: x2 + 30, y: ly, trade: t, layer: L });
    }
    c.restore();
  }
}
root.TXChart = TXChart; root.txFmtTime = fmtTime;
})(window);
