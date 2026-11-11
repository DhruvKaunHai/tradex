/* TradeX candle chart, drawn on canvas. Index-based x axis (no gaps between sessions). */
(function (root) {
'use strict';
const IST = 19800, AXW = 80, AXH = 26, MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const d2 = x => String(x).padStart(2, '0');
function fmtTime(t, withDate) { const d = new Date((t + IST) * 1000), hm = d2(d.getUTCHours()) + ':' + d2(d.getUTCMinutes()); return withDate ? `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}  ${hm}` : hm; }
function niceStep(range, target) { const raw = range / target, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p; return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p; }

class TXChart {
  constructor(el) {
    this.el = el; this.cv = document.createElement('canvas'); this.cv.className = 'tx-chart'; this.cv.tabIndex = 0; el.appendChild(this.cv);
    this.ctx = this.cv.getContext('2d'); this.d = null; this.n = 0; this.bw = 8; this.right = 0; this.layers = []; this.cross = null; this.h = {};
    this.vel = 0; this.anim = null; this.dirty = false; this.follow = true; this.subH = 0; this.hit = [];
    this.tickDir = 0; this.lastTickTime = 0; this.pulseTimer = null;
    this.yScale = 1.0; this.yOffset = 0; this.dragMode = null; this.autoBtnRect = null;
    setInterval(() => { if (this.d && this.n && this.tf && !this.pulseTimer) this.draw(); }, 1000);
    new ResizeObserver(() => this.resize()).observe(el); this.bind(); this.theme(); this.resize();
  }
  on(ev, fn) { this.h[ev] = fn; return this; }
  emit(ev, a) { if (this.h[ev]) this.h[ev](a); }
  theme() { const cs = getComputedStyle(this.el), g = k => cs.getPropertyValue(k).trim(); this.col = { bg: g('--surface') || '#15131c', grid: g('--line') || '#262233', text: g('--text') || '#eee', muted: g('--muted') || '#888', up: g('--up') || '#35d6ae', down: g('--down') || '#ff5f7a', accent: g('--accent') || '#ffb224', blue: '#2962ff', font: g('--font') || 'sans-serif' }; this.draw(); }
  resize() { const r = this.el.getBoundingClientRect(), dpr = window.devicePixelRatio || 1; if (!r.width || !r.height) return; this.W = r.width; this.H = r.height; this.cv.width = Math.round(r.width * dpr); this.cv.height = Math.round(r.height * dpr); this.cv.style.width = r.width + 'px'; this.cv.style.height = r.height + 'px'; this.dpr = dpr; this.clamp(); this.draw(); }
  get pw() { return this.W - AXW; }
  setData(d, tf, keepView) {
    const first = !this.d || !keepView; this.d = d; this.n = d.t.length; this.tf = tf;
    this.rank = new Uint8Array(this.n); let pd = null;
    for (let i = 0; i < this.n; i++) { const x = new Date((d.t[i] + IST) * 1000), k = [x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()]; this.rank[i] = !pd ? 3 : k[0] !== pd[0] ? 4 : k[1] !== pd[1] ? 3 : k[2] !== pd[2] ? 2 : (x.getUTCMinutes() === 15 && tf < 30 ? 1 : 0); pd = k; }
    if (first) { this.bw = 8; this.right = this.n - 1 + 6; this.follow = true; this.yScale = 1.0; this.yOffset = 0; } this.clamp(); this.draw();
  }
  startPulse() {
    if (this.pulseTimer) return;
    const loop = () => {
      const elapsed = performance.now() - (this.lastTickTime || 0);
      if (elapsed < 500) {
        this.draw();
        this.pulseTimer = requestAnimationFrame(loop);
      } else {
        this.pulseTimer = null;
        this.draw();
      }
    };
    this.pulseTimer = requestAnimationFrame(loop);
  }
  updateLast(bar, livePrice, prevPrice) { // bar: [t,o,h,l,c] for the chart's own timeframe
    const d = this.d; if (!d) return; const n = this.n;
    const curPrice = livePrice != null ? livePrice : bar[4];
    const oldPrice = prevPrice != null ? prevPrice : (n ? d.c[n - 1] : curPrice);
    if (n && d.t[n - 1] === bar[0]) { d.o[n - 1] = bar[1]; d.h[n - 1] = bar[2]; d.l[n - 1] = bar[3]; d.c[n - 1] = curPrice; }
    else if (!n || bar[0] > d.t[n - 1]) { d.t.push(bar[0]); d.o.push(bar[1]); d.h.push(bar[2]); d.l.push(bar[3]); d.c.push(curPrice); this.n++; const r = new Uint8Array(this.n); r.set(this.rank); r[this.n - 1] = n && Math.floor((bar[0] + IST) / 86400) !== Math.floor((d.t[n - 1] + IST) / 86400) ? 2 : 0; this.rank = r; if (this.follow) this.right += 1; }
    this.tickDir = curPrice > oldPrice ? 1 : curPrice < oldPrice ? -1 : (this.tickDir || 0);
    this.lastTickTime = performance.now();
    this.startPulse();
    this.draw();
  }
  setLayers(layers) { this.layers = layers || []; this.draw(); }
  clamp() {
    if (!this.n) return;
    const minBw = Math.max(0.005, this.pw / (this.n + 100));
    this.bw = Math.min(220, Math.max(minBw, this.bw));
    const vis = this.pw / this.bw;
    this.right = Math.min(this.n - 1 + Math.max(60, vis * 2.5), Math.max(-Math.max(40, vis * 1.5), this.right));
    this.follow = this.right >= this.n - 1 - 2;
  }
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
  showRange(i0, i1) { this.yScale = 1.0; this.yOffset = 0; const span = Math.max(10, i1 - i0 + 1), bw = this.pw / (span * 1.08); this.animateTo(i1 + span * 0.04, bw); }
  showLast(bars) { this.yScale = 1.0; this.yOffset = 0; this.showRange(Math.max(0, this.n - bars), this.n - 1); }
  fitAll() { this.yScale = 1.0; this.yOffset = 0; this.showRange(0, this.n - 1); }
  goLatest() { this.yScale = 1.0; this.yOffset = 0; if (!this.n) return; const vis = this.pw / this.bw; this.animateTo(this.n - 1 + Math.min(6, vis * 0.15), this.bw, 520); }
  zoom(f, cx) {
    cx = Math.max(0, Math.min(this.pw, cx != null ? cx : this.pw * 0.8));
    const i = this.right - (this.pw - cx) / this.bw;
    this.bw *= f;
    this.clamp();
    this.right = i + (this.pw - cx) / this.bw;
    this.clamp();
    this.draw();
  }
  bind() {
    const cv = this.cv, pts = new Map();
    let lastX = 0, lastY = 0, lastT = 0, pinch = 0, moved = 0;

    cv.addEventListener('wheel', e => {
      e.preventDefault(); cancelAnimationFrame(this.anim);
      const dx = e.deltaX, dy = e.deltaY;
      const inPriceAxis = e.offsetX >= this.pw && e.offsetY < this.mainH;
      const inTimeAxis = e.offsetY >= this.H - AXH && e.offsetX < this.pw;

      if (inPriceAxis) {
        // Vertical price zoom on price axis (TradingView style)
        const factor = Math.exp(dy * 0.002);
        this.yScale = Math.max(0.04, Math.min(30, (this.yScale || 1.0) * factor));
        this.draw();
      } else if (inTimeAxis) {
        // Horizontal time zoom on time axis
        const factor = Math.exp(-dy * 0.002);
        this.zoom(factor, e.offsetX);
      } else if (e.shiftKey || (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 2)) {
        // Horizontal pan
        const move = (e.shiftKey && Math.abs(dx) < 2 ? dy : dx) / this.bw;
        this.right += move * 0.6;
        this.clamp(); this.draw();
      } else {
        // Zoom time centered on mouse cursor
        const sens = e.ctrlKey ? 0.006 : 0.002;
        const f = Math.exp(-Math.max(-0.35, Math.min(0.35, dy * sens)));
        this.zoom(f, Math.max(0, Math.min(this.pw, e.offsetX)));
      }
    }, { passive: false });

    cv.addEventListener('pointerdown', e => {
      cv.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      lastX = e.offsetX; lastY = e.offsetY; lastT = e.timeStamp;
      this.vel = 0; moved = 0; cancelAnimationFrame(this.anim);

      if (pts.size === 1) {
        if (this.autoBtnRect && e.offsetX >= this.autoBtnRect.x && e.offsetX <= this.autoBtnRect.x + this.autoBtnRect.w &&
            e.offsetY >= this.autoBtnRect.y && e.offsetY <= this.autoBtnRect.y + this.autoBtnRect.h) {
          this.yScale = 1.0; this.yOffset = 0; this.draw();
          return;
        }
        if (e.offsetX >= this.pw && e.offsetY < this.mainH) {
          this.dragMode = 'price';
          cv.style.cursor = 'ns-resize';
        } else if (e.offsetY >= this.H - AXH && e.offsetX < this.pw) {
          this.dragMode = 'time';
          cv.style.cursor = 'ew-resize';
        } else {
          this.dragMode = 'chart';
          cv.style.cursor = 'grabbing';
        }
      } else if (pts.size === 2) {
        const v = [...pts.values()];
        pinch = Math.hypot(v[0].x - v[1].x, v[0].y - v[1].y);
        this.dragMode = 'pinch';
      }
    });

    cv.addEventListener('pointermove', e => {
      if (pts.has(e.pointerId)) {
        pts.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
        if (this.dragMode === 'pinch' && pts.size === 2) {
          const v = [...pts.values()], dist = Math.hypot(v[0].x - v[1].x, v[0].y - v[1].y);
          if (pinch > 10 && dist > 10) this.zoom(dist / pinch, (v[0].x + v[1].x) / 2);
          pinch = dist; return;
        }
        const dx = e.offsetX - lastX, dy = e.offsetY - lastY;
        const dtm = Math.max(1, e.timeStamp - lastT);
        moved += Math.hypot(dx, dy);

        if (this.dragMode === 'price') {
          // Drag up (dy < 0): zoom in (stretch candles). Drag down (dy > 0): zoom out (squash candles).
          const factor = Math.exp(dy * 0.007);
          this.yScale = Math.max(0.04, Math.min(30, (this.yScale || 1.0) * factor));
          this.draw();
        } else if (this.dragMode === 'time') {
          // Drag time axis horizontally to zoom time
          const factor = Math.exp(-dx * 0.005);
          this.zoom(factor, this.pw / 2);
        } else if (this.dragMode === 'chart') {
          // Free 2D Pan on canvas
          this.right -= dx / this.bw;
          this.vel = dx / dtm;
          if (this.effSpan && this.mainH) {
            this.yOffset += dy * (this.effSpan / (this.mainH - 16));
          }
          this.clamp();
          this.draw();
        }
        lastX = e.offsetX; lastY = e.offsetY; lastT = e.timeStamp;
      } else {
        // Hover cursors
        if (this.autoBtnRect && e.offsetX >= this.autoBtnRect.x && e.offsetX <= this.autoBtnRect.x + this.autoBtnRect.w &&
            e.offsetY >= this.autoBtnRect.y && e.offsetY <= this.autoBtnRect.y + this.autoBtnRect.h) {
          cv.style.cursor = 'pointer';
        } else if (e.offsetX >= this.pw && e.offsetY < this.mainH) {
          cv.style.cursor = 'ns-resize';
        } else if (e.offsetY >= this.H - AXH && e.offsetX < this.pw) {
          cv.style.cursor = 'ew-resize';
        } else {
          cv.style.cursor = 'crosshair';
        }
      }
      this.cross = { x: e.offsetX, y: e.offsetY };
      this.draw();
      this.emitCross();
    });

    const up = e => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      const wasMode = this.dragMode;
      this.dragMode = null;

      if (e.offsetX >= this.pw && e.offsetY < this.mainH) cv.style.cursor = 'ns-resize';
      else if (e.offsetY >= this.H - AXH && e.offsetX < this.pw) cv.style.cursor = 'ew-resize';
      else cv.style.cursor = 'crosshair';

      if (moved < 5) {
        if (this.autoBtnRect && e.offsetX >= this.autoBtnRect.x && e.offsetX <= this.autoBtnRect.x + this.autoBtnRect.w &&
            e.offsetY >= this.autoBtnRect.y && e.offsetY <= this.autoBtnRect.y + this.autoBtnRect.h) {
          this.yScale = 1.0; this.yOffset = 0; this.draw(); return;
        }
        const hit = this.hit.find(q => Math.abs(q.x - e.offsetX) < 9 && Math.abs(q.y - e.offsetY) < 11);
        this.emit('click', { index: this.idx(e.offsetX), trade: hit ? hit.trade : null, layer: hit ? hit.layer : null });
      } else if (wasMode === 'chart' && Math.abs(this.vel) > 0.25 && e.timeStamp - lastT < 60) {
        this.fling();
      }
    };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', () => { this.cross = null; this.draw(); this.emitCross(); });
    cv.addEventListener('dblclick', e => {
      if (e.offsetX >= this.pw && e.offsetY < this.mainH) {
        // Double-click on price axis: reset Y zoom/pan
        this.yScale = 1.0; this.yOffset = 0; this.draw();
      } else {
        // Double-click on chart: reset view
        this.yScale = 1.0; this.yOffset = 0; this.showLast(Math.round(this.pw / 8));
      }
    });
    cv.addEventListener('keydown', e => {
      const k = e.key;
      if (k === 'ArrowLeft' || k === 'ArrowRight') { this.right += (k === 'ArrowLeft' ? -1 : 1) * Math.max(1, 40 / this.bw); this.clamp(); this.draw(); e.preventDefault(); }
      else if (k === 'ArrowUp' || k === 'ArrowDown') { if (this.effSpan && this.mainH) { this.yOffset += (k === 'ArrowUp' ? 1 : -1) * 30 * (this.effSpan / (this.mainH - 16)); this.draw(); e.preventDefault(); } }
      else if (k === '+' || k === '=') this.zoom(1.25, this.pw / 2);
      else if (k === '-') this.zoom(0.8, this.pw / 2);
      else if (k === 'End') { this.yScale = 1.0; this.yOffset = 0; this.showLast(Math.round(this.pw / this.bw)); }
      else if (k === 'Home') { this.yScale = 1.0; this.yOffset = 0; this.fitAll(); }
    });
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

    // TradingView-style vertical scaling (yScale) & 2D vertical pan (yOffset)
    const baseSpan = hi - lo, baseMid = (hi + lo) / 2;
    const effSpan = Math.max(0.01, baseSpan * (this.yScale || 1.0));
    const effMid = baseMid + (this.yOffset || 0);
    lo = effMid - effSpan / 2;
    hi = effMid + effSpan / 2;
    this.effSpan = effSpan;
    this.lo = lo;
    this.hi = hi;

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
    // last price line and clean TradingView live point tracker
    const lp = d.c[this.n - 1], ly = Math.round(y(lp)) + 0.5, upL = lp >= d.o[this.n - 1];
    const lx = Math.round(this.x(this.n - 1));
    const tickCol = this.tickDir > 0 ? col.up : this.tickDir < 0 ? col.down : (upL ? col.up : col.down);

    // 1. Clean TradingView dashed price line across to axis
    c.strokeStyle = tickCol; c.lineWidth = 1; c.setLineDash([4, 4]);
    c.beginPath(); c.moveTo(Math.max(0, lx), ly); c.lineTo(pw, ly); c.stroke(); c.setLineDash([]);

    // 2. Clean TradingView live price dot on current candle
    if (lx > -20 && lx < pw + 20 && ly > 0 && ly < mainH) {
      c.save();
      c.beginPath(); c.arc(lx, ly, 3.5, 0, Math.PI * 2); c.fillStyle = tickCol; c.fill();
      c.lineWidth = 1.5; c.strokeStyle = '#ffffff'; c.stroke();
      c.restore();
    }
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
    
    // Y-axis price labels: SKIP any label that overlaps with live badge or crosshair (NO TEXT COLLISION!)
    c.fillStyle = col.muted; c.font = `11px ${col.font}`; c.textAlign = 'left'; c.textBaseline = 'middle';
    const crossY = (this.cross && this.cross.x < pw && this.cross.y < mainH) ? Math.round(this.cross.y) : -999;
    for (const [v, yy] of pticks) {
      if (ly > 0 && ly < mainH && yy >= ly - 14 && yy <= ly + 32) continue;
      if (crossY > 0 && Math.abs(yy - crossY) < 14) continue;
      const dec = ps < 1 ? 2 : (ps < 10 && v % 1 !== 0 ? 1 : 0);
      c.fillText(v.toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec }), pw + 8, yy);
    }
    c.textAlign = 'center';
    for (const [i, xx] of tt) { if (xx < 20 || xx > pw - 20) continue; const x = new Date((d.t[i] + IST) * 1000), r = this.rank[i]; const txt = r >= 4 ? String(x.getUTCFullYear()) : r === 3 ? (lvl >= 3 ? MON[x.getUTCMonth()] + (x.getUTCMonth() === 0 ? ' ' + x.getUTCFullYear() : '') : x.getUTCDate() + ' ' + MON[x.getUTCMonth()]) : r === 2 ? x.getUTCDate() + ' ' + MON[x.getUTCMonth()] : fmtTime(d.t[i]); c.fillStyle = r >= 2 ? col.text : col.muted; c.fillText(txt, xx, H - AXH / 2); }
    
    const tag = (yy, txt, bg, fg) => { c.fillStyle = bg; c.beginPath(); c.roundRect(pw + 1, yy - 10, AXW - 3, 20, 2); c.fill(); c.fillStyle = fg; c.textAlign = 'left'; c.font = `600 11px ${col.font}`; c.fillText(txt, pw + 7, yy + 0.5); };
    
    // Live price badge on Y-axis
    if (ly > 0 && ly < mainH) {
      tag(ly, lp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), tickCol, '#ffffff');
      // Countdown timer below badge in a small white box
      if (this.tf && this.tf > 0 && this.n) {
        const barSec = this.tf * 60;
        const curBarT = d.t[this.n - 1];
        const nowSec = Math.floor(Date.now() / 1000);
        const secLeft = (curBarT + barSec) - nowSec;
        if (secLeft > 0 && secLeft <= barSec) {
          const m = Math.floor(secLeft / 60), s = secLeft % 60;
          const tw = 46, th = 15;
          const tx = pw + 6, ty = Math.min(mainH - th - 2, ly + 12);
          c.fillStyle = '#ffffff';
          c.beginPath();
          c.roundRect(tx, ty, tw, th, 2);
          c.fill();
          c.fillStyle = '#111111';
          c.font = `700 10px ${col.font}`;
          c.textAlign = 'center';
          c.textBaseline = 'middle';
          c.fillText(`${d2(m)}:${d2(s)}`, tx + tw / 2, ty + th / 2 + 0.5);
        }
      }
    }
    // TradingView-style [Auto] button on price axis when manual Y-scaling or vertical panning is active
    const isManualY = (this.yScale && Math.abs(this.yScale - 1.0) > 0.02) || (this.yOffset && Math.abs(this.yOffset) > 0.5);
    if (isManualY) {
      const bx = pw + 6, by = mainH - 24, bw = AXW - 12, bh = 18;
      this.autoBtnRect = { x: bx, y: by, w: bw, h: bh };
      c.fillStyle = col.bg; c.strokeStyle = col.muted; c.lineWidth = 1;
      c.beginPath(); c.roundRect(bx, by, bw, bh, 3); c.fill(); c.stroke();
      c.fillStyle = col.accent; c.font = `600 10px ${col.font}`; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('Auto', bx + bw / 2, by + bh / 2);
    } else {
      this.autoBtnRect = null;
    }
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
    const blueBox = col.blue || '#2962ff';
    for (let k = lo; k < tr.length && shown < 1500; k++) {
      const t = tr[k]; if (t.ei > i1) break; shown++;
      const isExited = !t.open && t.reason !== 'Still open';
      const x1 = this.x(t.ei), x2 = this.x(t.xi), y1 = y(t.ep), y2 = y(t.xp), win = t.pnl >= 0, rc = win ? col.up : col.down, long = t.dir > 0;

      // ONLY show red/green box when it exits
      if (isExited) {
        c.fillStyle = rc; c.globalAlpha = dense ? 0.10 : 0.14; c.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.max(1, Math.abs(x2 - x1)), Math.max(1, Math.abs(y2 - y1))); c.globalAlpha = 1;
        c.strokeStyle = rc; c.globalAlpha = dense ? 0.55 : 0.9; c.lineWidth = dense ? 1 : 1.4; c.setLineDash(dense ? [] : [5, 4]); c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); c.setLineDash([]); c.globalAlpha = 1;
      } else {
        // Open trade: dashed blue tracking line to current candle
        c.strokeStyle = blueBox; c.globalAlpha = 0.7; c.lineWidth = 1.2; c.setLineDash([4, 4]); c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); c.setLineDash([]); c.globalAlpha = 1;
      }
      if (dense) continue;

      // entry and exit price levels
      c.lineWidth = 1.5; c.strokeStyle = blueBox; c.globalAlpha = 0.8; c.beginPath(); c.moveTo(x1 - bw * 0.6, y1); c.lineTo(x1 + Math.max(bw * 0.6, Math.min(x2 - x1, 40)), y1); c.stroke(); c.globalAlpha = 1;
      if (isExited) {
        c.strokeStyle = rc; c.beginPath(); c.moveTo(x2 - Math.max(bw * 0.6, Math.min(x2 - x1, 40)), y2); c.lineTo(x2 + bw * 0.6, y2); c.stroke();
      }

      // entry arrow: in blue box color
      const ey = long ? y(d.l[t.ei]) + 6 : y(d.h[t.ei]) - 6;
      c.fillStyle = blueBox; c.beginPath(); if (long) { c.moveTo(x1, ey); c.lineTo(x1 - 6, ey + 9); c.lineTo(x1 + 6, ey + 9); } else { c.moveTo(x1, ey); c.lineTo(x1 - 6, ey - 9); c.lineTo(x1 + 6, ey - 9); } c.fill();
      const py = long ? ey + 19 : ey - 19;

      // BUY/SELL in BLUE box with entrypoint price!
      const epStr = t.ep.toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
      const entryText = bw >= 5 ? `${long ? 'BUY' : 'SELL'} @ ${epStr}` : (long ? 'BUY' : 'SELL');
      if (bw >= 3.5) pill(x1, py, entryText, blueBox, '#ffffff', 'c');

      // Exit marker and exit pills: ONLY when it exits
      if (isExited) {
        c.strokeStyle = col.text; c.lineWidth = 1.5; c.fillStyle = rc; c.beginPath(); c.arc(x2, y2, 4.5, 0, 7); c.fill(); c.stroke();
        const ly = y2;
        if (bw >= 5) {
          const ptxt = `${t.pts >= 0 ? '+' : '−'}${Math.abs(t.pts).toFixed(1)} pts`; c.font = `800 12px ${col.font}`; const pw = c.measureText(ptxt).width + 12, ph = 20, ppx = x2 + 9;
          c.fillStyle = rc; c.beginPath(); c.roundRect(ppx, ly - ph / 2, pw, ph, 5); c.fill(); c.fillStyle = ink; c.textAlign = 'left'; c.textBaseline = 'middle'; c.fillText(ptxt, ppx + 6, ly + 0.5);
          c.font = `500 10px ${col.font}`; c.globalAlpha = 0.75; c.fillStyle = col.text; c.fillText(money(t.pnl), ppx + pw + 5, ly + 0.5); c.globalAlpha = 1;
        }
        else if (bw >= 3.5) { c.font = `600 10px ${col.font}`; c.textAlign = 'left'; c.textBaseline = 'middle'; c.fillStyle = rc; c.fillText((t.pts >= 0 ? '+' : '') + t.pts.toFixed(0), x2 + 7, ly); }
      }
      this.hit.push({ x: x1, y: ey + (long ? 5 : -5), trade: t, layer: L }, { x: x1, y: py, trade: t, layer: L });
      if (isExited) this.hit.push({ x: x2, y: y2, trade: t, layer: L }, { x: x2 + 30, y: y2, trade: t, layer: L });
    }
    c.restore();
  }
}
root.TXChart = TXChart; root.txFmtTime = fmtTime;
})(window);
