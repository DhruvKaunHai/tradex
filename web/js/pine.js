/* TradeX Pine engine: reads Pine v5/v6 style scripts, runs them bar by bar and simulates orders.
   Works in a browser worker and in Node. */
(function (root) {
'use strict';
const TICK = 0.05, IST = 19800;
class PineError extends Error { constructor(msg, line) { super(msg); this.line = line || 0; } }
const isNa = x => x === null || x === undefined || (typeof x === 'number' && x !== x);
const num = x => (x === true ? 1 : x === false ? 0 : (typeof x === 'number' ? x : (isNa(x) ? NaN : +x)));

/* ---------------- Lexer ---------------- */
const OPS2 = [':=', '==', '!=', '<=', '>=', '=>', '+=', '-=', '*=', '/=', '%='];
const CONT = new Set(['+', '-', '*', '/', '%', '?', ':', ',', 'and', 'or', '==', '!=', '<', '>', '<=', '>=', '(', '[', ':=', '=']);
function lex(src) {
  const toks = [], stack = [0]; let depth = 0;
  const lines = src.replace(/\r/g, '').split('\n');
  for (let ln = 0; ln < lines.length; ln++) {
    const raw = lines[ln]; let p = 0, width = 0;
    while (p < raw.length && (raw[p] === ' ' || raw[p] === '\t')) { width += raw[p] === '\t' ? 4 : 1; p++; }
    const lt = [];
    while (p < raw.length) {
      const ch = raw[p];
      if (ch === ' ' || ch === '\t') { p++; continue; }
      if (ch === '/' && raw[p + 1] === '/') break;
      if (ch === '"' || ch === "'") {
        let q = p + 1, s = '';
        while (q < raw.length && raw[q] !== ch) { if (raw[q] === '\\' && q + 1 < raw.length) { q++; s += raw[q] === 'n' ? '\n' : raw[q]; } else s += raw[q]; q++; }
        if (q >= raw.length) throw new PineError('Text is missing its closing quote', ln + 1);
        lt.push({ t: 'str', v: s, line: ln + 1 }); p = q + 1; continue;
      }
      if (ch === '#') { const m = /^#[0-9a-fA-F]{3,8}/.exec(raw.slice(p)); if (m) { lt.push({ t: 'str', v: m[0], line: ln + 1 }); p += m[0].length; continue; } }
      let m = /^(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?)/.exec(raw.slice(p));
      if (m) { lt.push({ t: 'num', v: parseFloat(m[0]), line: ln + 1 }); p += m[0].length; continue; }
      m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(raw.slice(p));
      if (m) { lt.push({ t: 'id', v: m[0], line: ln + 1 }); p += m[0].length; continue; }
      const two = raw.substr(p, 2);
      if (OPS2.includes(two)) { lt.push({ t: 'op', v: two, line: ln + 1 }); p += 2; continue; }
      if ('+-*/%<>=()[],.?:'.includes(ch)) { lt.push({ t: 'op', v: ch, line: ln + 1 }); p++; continue; }
      throw new PineError(`Unexpected character "${ch}"`, ln + 1);
    }
    if (!lt.length) continue;
    const last = toks.length ? toks[toks.length - 1] : null;
    let prevSig = null; for (let k = toks.length - 1; k >= 0; k--) if (toks[k].t !== 'nl') { prevSig = toks[k]; break; }
    const startsOp = lt[0].t === 'op' && ['+', '*', '/', '%', '?', ':', '==', '!=', '<', '>', '<=', '>='].includes(lt[0].v) || (lt[0].t === 'id' && (lt[0].v === 'and' || lt[0].v === 'or'));
    const isCont = depth > 0 || (last && last.t === 'nl' && prevSig && (
      (width % 4 !== 0 && width > stack[stack.length - 1]) || startsOp ||
      (prevSig.t !== 'str' && CONT.has(prevSig.v) && prevSig.v !== '=' && prevSig.v !== ':=' && !(prevSig.v === ':' && false))));
    if (isCont) { if (last && last.t === 'nl') toks.pop(); }
    else {
      const lvl = width;
      if (lvl > stack[stack.length - 1]) { stack.push(lvl); toks.push({ t: 'indent', line: ln + 1 }); }
      else while (lvl < stack[stack.length - 1]) { stack.pop(); toks.push({ t: 'dedent', line: ln + 1 }); }
    }
    for (const t of lt) { if (t.t === 'op') { if (t.v === '(' || t.v === '[') depth++; else if (t.v === ')' || t.v === ']') depth = Math.max(0, depth - 1); } toks.push(t); }
    if (depth === 0) toks.push({ t: 'nl', line: ln + 1 });
  }
  while (stack.length > 1) { stack.pop(); toks.push({ t: 'dedent', line: lines.length }); }
  toks.push({ t: 'eof', line: lines.length });
  return toks;
}

/* ---------------- Parser ---------------- */
const TYPES = new Set(['int', 'float', 'bool', 'string', 'color', 'label', 'line', 'box', 'table']);
const QUALS = new Set(['series', 'simple', 'const', 'input']);
function parse(src) {
  const T = lex(src); let p = 0, nid = 1;
  const peek = (k = 0) => T[p + k], next = () => T[p++];
  const is = (v, k = 0) => { const t = T[p + k]; return t && (t.t === 'op' || t.t === 'id') && t.v === v; };
  const N = (type, line, o) => Object.assign({ type, id: nid++, line }, o);
  const expect = v => { if (!is(v)) { const t = peek(); throw new PineError(`Expected "${v}" but found "${t.t === 'eof' ? 'end of script' : t.t === 'nl' ? 'end of line' : t.v ?? t.t}"`, t.line); } return next(); };
  const skipNl = () => { while (peek().t === 'nl') p++; };
  function block() {
    if (peek().t !== 'nl') { return [statement()]; }
    skipNl();
    if (peek().t !== 'indent') throw new PineError('Expected an indented block here', peek().line);
    next(); const out = [];
    while (peek().t !== 'dedent' && peek().t !== 'eof') { if (peek().t === 'nl') { p++; continue; } out.push(statement()); }
    if (peek().t === 'dedent') next();
    return out;
  }
  function endStmt() { if (peek().t === 'nl') next(); else if (is(',')) next(); else if (peek().t !== 'eof' && peek().t !== 'dedent') throw new PineError(`Unexpected "${peek().v ?? peek().t}"`, peek().line); }
  function matchClose(k) { // index of token after the bracket group starting at p+k
    let d = 0;
    for (let q = p + k; q < T.length; q++) { const t = T[q]; if (t.t === 'op') { if (t.v === '(' || t.v === '[') d++; else if (t.v === ')' || t.v === ']') { d--; if (d === 0) return q + 1 - p; } } if (t.t === 'eof') break; }
    return -1;
  }
  function statement() {
    const t = peek(), line = t.line;
    if (t.t === 'id') {
      if (t.v === 'if') return parseIf();
      if (t.v === 'for') return parseFor();
      if (t.v === 'while') { next(); const test = expr(); return N('While', line, { test, body: block() }); }
      if (t.v === 'switch') { const s = parseSwitch(); return s; }
      if (t.v === 'break' || t.v === 'continue') { next(); endStmt(); return N(t.v === 'break' ? 'Break' : 'Continue', line); }
      if (t.v === 'import' || t.v === 'type' || t.v === 'method' || t.v === 'export' || t.v === 'library')
        throw new PineError(`"${t.v}" is not supported in TradeX yet`, line);
      let k = 0, mode = null;
      if (t.v === 'var' || t.v === 'varip') { mode = 'var'; k = 1; }
      while (peek(k).t === 'id' && QUALS.has(peek(k).v) && peek(k + 1).t === 'id') k++;
      if (peek(k).t === 'id' && (TYPES.has(peek(k).v) || peek(k).v === 'array' || peek(k).v === 'matrix' || peek(k).v === 'map')) {
        let j = k + 1;
        if (is('<', j)) { while (!is('>', j) && peek(j).t !== 'nl') j++; j++; }
        if (is('[', j) && is(']', j + 1)) j += 2;
        if (peek(j).t === 'id' && is('=', j + 1)) k = j;
      }
      if (is('[', k) && mode) { }
      if (peek(k).t === 'id' && is('=', k + 1)) {
        p += k; const name = next().v; next(); const init = rhs(); endRhs(init);
        return N('VarDecl', line, { name, init, mode });
      }
      if (mode) throw new PineError('Expected a variable name after "var"', line);
      if (is('(', 1)) {
        const end = matchClose(1);
        if (end > 0 && is('=>', end)) return parseFunc();
      }
      if (peek(1).t === 'op' && [':=', '+=', '-=', '*=', '/=', '%='].includes(peek(1).v)) {
        const name = next().v, op = next().v; const value = rhs(); endRhs(value);
        return N('Assign', line, { name, op, value });
      }
    }
    if (is('[')) {
      const end = matchClose(0);
      if (end > 0 && is('=', end)) {
        next(); const names = [];
        while (!is(']')) { names.push(next().v); if (is(',')) next(); }
        next(); next(); const init = rhs(); endRhs(init);
        return N('TupleDecl', line, { names, init });
      }
    }
    const e = expr(); endStmt();
    return N('ExprStmt', line, { expr: e });
  }
  function endRhs(node) { if (node.type !== 'If' && node.type !== 'Switch') endStmt(); }
  function rhs() {
    if (is('if')) return parseIf();
    if (is('switch')) return parseSwitch();
    if (is('for') || is('while')) throw new PineError('Using a loop as a value is not supported', peek().line);
    return expr();
  }
  function parseIf() {
    const line = next().line; const test = expr(); const cons = block(); let alt = null;
    let q = p; while (T[q].t === 'nl') q++;
    if (T[q].t === 'id' && T[q].v === 'else') {
      p = q; next();
      if (is('if')) alt = [parseIf()]; else alt = block();
    }
    return N('If', line, { test, cons, alt });
  }
  function parseFor() {
    const line = next().line;
    if (is('[')) throw new PineError('"for [index, value] in" is not supported', line);
    const v = next().v;
    if (is('in')) { next(); const iter = expr(); return N('ForIn', line, { v, iter, body: block() }); }
    expect('='); const from = expr(); expect('to'); const to = expr(); let step = null;
    if (is('by')) { next(); step = expr(); }
    return N('For', line, { v, from, to, step, body: block() });
  }
  function parseSwitch() {
    const line = next().line; let disc = null;
    if (peek().t !== 'nl') disc = expr();
    skipNl(); if (peek().t !== 'indent') throw new PineError('Expected the switch cases on indented lines', line);
    next(); const cases = [];
    while (peek().t !== 'dedent' && peek().t !== 'eof') {
      if (peek().t === 'nl') { p++; continue; }
      let test = null; if (!is('=>')) test = expr();
      expect('=>'); const body = block(); cases.push({ test, body });
    }
    if (peek().t === 'dedent') next();
    return N('Switch', line, { disc, cases });
  }
  function parseFunc() {
    const line = peek().line, name = next().v; next(); const params = [];
    while (!is(')')) {
      while (peek().t === 'id' && peek(1).t === 'id') next();
      const pn = next().v; let def = null; if (is('=')) { next(); def = expr(); }
      params.push({ name: pn, def }); if (is(',')) next();
    }
    next(); expect('=>');
    return N('FuncDef', line, { name, params, body: block() });
  }
  function expr() { return ternary(); }
  function ternary() {
    const c = orE();
    if (is('?')) { const line = next().line; const a = ternary(); expect(':'); const b = ternary(); return N('Ternary', line, { test: c, a, b }); }
    return c;
  }
  function bin(sub, ops) { return () => { let l = sub(); while ((peek().t === 'op' || peek().t === 'id') && ops.includes(peek().v)) { const o = next(); l = N('Binary', o.line, { op: o.v, l, r: sub() }); } return l; }; }
  const mul = bin(unary, ['*', '/', '%']), add = bin(mul, ['+', '-']), cmp = bin(add, ['<', '>', '<=', '>=']), eq = bin(cmp, ['==', '!=']), andE = bin(eq, ['and']), orE = bin(andE, ['or']);
  function unary() {
    if (is('not') || is('-') || is('+')) { const o = next(); return N('Unary', o.line, { op: o.v, arg: unary() }); }
    return postfix();
  }
  function postfix() {
    let e = primary();
    for (;;) {
      if (is('.')) {
        next(); const t = next(); if (t.t !== 'id') throw new PineError('Expected a name after "."', t.line);
        if (is('<') && t.v === 'new') { while (!is('>')) next(); next(); }
        e = N('Member', t.line, { obj: e, prop: t.v });
      } else if (is('(')) {
        const line = next().line; const args = [], named = {};
        while (!is(')')) {
          if (peek().t === 'id' && is('=', 1)) { const n = next().v; next(); named[n] = expr(); } else args.push(expr());
          if (is(',')) next(); else if (!is(')')) throw new PineError('Expected "," or ")" in the function call', peek().line);
        }
        next(); e = N('Call', line, { callee: e, args, named });
      } else if (is('[')) { const line = next().line; const idx = expr(); expect(']'); e = N('Index', line, { obj: e, idx }); }
      else return e;
    }
  }
  function primary() {
    const t = next();
    if (t.t === 'num') return N('Num', t.line, { v: t.v });
    if (t.t === 'str') return N('Str', t.line, { v: t.v });
    if (t.t === 'id') {
      if (t.v === 'true' || t.v === 'false') return N('Bool', t.line, { v: t.v === 'true' });
      if (t.v === 'na' && !is('(')) return N('Na', t.line);
      return N('Id', t.line, { name: t.v });
    }
    if (t.t === 'op' && t.v === '(') { const e = expr(); expect(')'); return e; }
    if (t.t === 'op' && t.v === '[') { const elems = []; while (!is(']')) { elems.push(expr()); if (is(',')) next(); } next(); return N('ArrayLit', t.line, { elems }); }
    throw new PineError(`Unexpected "${t.t === 'nl' ? 'end of line' : t.t === 'eof' ? 'end of script' : t.v ?? t.t}"`, t.line);
  }
  const body = [];
  while (peek().t !== 'eof') { if (peek().t === 'nl' || peek().t === 'dedent' || peek().t === 'indent') { p++; continue; } body.push(statement()); }
  return { body, count: nid };
}

/* ---------------- Colours ---------------- */
const COLORS = { aqua: '#00bcd4', black: '#363a45', blue: '#2962ff', fuchsia: '#e040fb', gray: '#787b86', green: '#4caf50', lime: '#00e676', maroon: '#880e4f', navy: '#311b92', olive: '#808000', orange: '#ff9800', purple: '#9c27b0', red: '#f23645', silver: '#b2b5be', teal: '#089981', white: '#ffffff', yellow: '#fdd835' };
function rgba(c, transp) {
  if (isNa(c)) return NaN; let r = 128, g = 128, b = 128, a = 1; c = String(c);
  let m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c);
  if (m) { r = parseInt(m[1].slice(0, 2), 16); g = parseInt(m[1].slice(2, 4), 16); b = parseInt(m[1].slice(4, 6), 16); if (m[2]) a = parseInt(m[2], 16) / 255; }
  else if ((m = /^rgba?\(([^)]+)\)/.exec(c))) { const q = m[1].split(',').map(Number); r = q[0]; g = q[1]; b = q[2]; if (q.length > 3) a = q[3]; }
  if (!isNa(transp)) a = 1 - Math.min(100, Math.max(0, transp)) / 100;
  return `rgba(${r},${g},${b},${+a.toFixed(3)})`;
}

/* ---------------- Indicator state helpers ---------------- */
function ring(st, n) { n = Math.max(1, Math.floor(n)); if (st.n !== n) { st.n = n; st.b = new Float64Array(n); st.k = 0; st.p = 0; st.s = 0; st.nn = 0; } return n; }
function rpush(st, x) { // returns the value that left the window (or undefined)
  let out; if (st.k === st.n) { out = st.b[st.p]; if (out !== out) st.nn--; else st.s -= out; } else st.k++;
  st.b[st.p] = x; if (x !== x) st.nn++; else st.s += x; st.p = (st.p + 1) % st.n; return out;
}
const rfull = st => st.k === st.n && st.nn === 0;
function rget(st, back) { return st.b[((st.p - 1 - back) % st.n + st.n) % st.n]; } // back=0 newest
function fSma(st, x, n) { ring(st, n); rpush(st, x); return rfull(st) ? st.s / st.n : NaN; }
function fEmaA(st, x, n, alpha) { // seeded with the simple average of the first n values, like Pine
  if (st.v === undefined) { st.v = NaN; st.c = 0; st.s = 0; }
  if (x !== x) return st.v;
  if (st.v !== st.v) { st.c++; st.s += x; if (st.c >= n) st.v = st.s / st.c; return st.v; }
  st.v = alpha * x + (1 - alpha) * st.v; return st.v;
}
const fEma = (st, x, n) => fEmaA(st, x, n, 2 / (n + 1));
const fRma = (st, x, n) => fEmaA(st, x, n, 1 / n);
function fWma(st, x, n) { ring(st, n); rpush(st, x); if (!rfull(st)) return NaN; let s = 0, w = 0; for (let k = 0; k < st.n; k++) { const wt = st.n - k; s += rget(st, k) * wt; w += wt; } return s / w; }
function fStdev(st, x, n) { ring(st, n); rpush(st, x); if (!rfull(st)) return NaN; const m = st.s / st.n; let v = 0; for (let k = 0; k < st.n; k++) { const d = st.b[k] - m; v += d * d; } return Math.sqrt(v / st.n); }
function fExt(st, x, n, sign) { ring(st, n); rpush(st, x); if (st.k < st.n) return [NaN, NaN]; let best = NaN, at = 0; for (let k = 0; k < st.n; k++) { const v = rget(st, k); if (v !== v) continue; if (best !== best || (sign > 0 ? v > best : v < best)) { best = v; at = k; } } return [best, -at]; }
function fTr(R, st, handleNa) { const i = R.i, h = R.h[i], l = R.l[i]; if (i === 0) return handleNa ? h - l : NaN; const pc = R.c[i - 1]; return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)); }
function sub(st, k) { return st[k] || (st[k] = {}); }
function fAtr(R, st, n) { return fRma(sub(st, 'r'), fTr(R, st, true), n); }
function fRsi(st, x, n) {
  const pv = st.pv; st.pv = x; if (pv === undefined || pv !== pv || x !== x) return NaN;
  const ch = x - pv, u = fRma(sub(st, 'u'), Math.max(ch, 0), n), d = fRma(sub(st, 'd'), Math.max(-ch, 0), n);
  if (u !== u || d !== d) return NaN; return d === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / d);
}
function fSuper(R, st, factor, n) {
  const i = R.i, atr = fAtr(R, sub(st, 'a'), n), hl2 = (R.h[i] + R.l[i]) / 2, c = R.c[i];
  if (atr !== atr) { st.pc = c; return [NaN, NaN]; }
  let ub = hl2 + factor * atr, lb = hl2 - factor * atr; const pc = st.pc;
  if (st.lb !== undefined) { lb = (lb > st.lb || pc < st.lb) ? lb : st.lb; ub = (ub < st.ub || pc > st.ub) ? ub : st.ub; }
  let dir;
  if (st.dir === undefined) dir = 1; else if (st.st === st.ubp) dir = c > ub ? -1 : 1; else dir = c < lb ? 1 : -1;
  st.lb = lb; st.ub = ub; st.ubp = ub; st.dir = dir; st.st = dir === -1 ? lb : ub; st.pc = c;
  return [st.st, dir];
}
function fDmi(R, st, diLen, adxLen) {
  const i = R.i; if (i === 0) { fRma(sub(st, 't'), NaN, diLen); return [NaN, NaN, NaN]; }
  const up = R.h[i] - R.h[i - 1], dn = R.l[i - 1] - R.l[i];
  const pdm = up > dn && up > 0 ? up : 0, mdm = dn > up && dn > 0 ? dn : 0;
  const tr = fRma(sub(st, 't'), fTr(R, st, true), diLen), p = fRma(sub(st, 'p'), pdm, diLen), m = fRma(sub(st, 'm'), mdm, diLen);
  const plus = 100 * p / tr, minus = 100 * m / tr, sum = plus + minus;
  const adx = 100 * fRma(sub(st, 'x'), sum === 0 ? 0 : Math.abs(plus - minus) / sum, adxLen);
  return [plus, minus, adx];
}
function fSar(R, st, start, inc, max) {
  const i = R.i, h = R.h[i], l = R.l[i];
  if (i === 0) { st.h1 = h; st.l1 = l; return NaN; }
  if (st.sar === undefined) { st.up = R.c[i] > R.c[i - 1]; st.ep = st.up ? h : l; st.sar = st.up ? st.l1 : st.h1; st.af = start; }
  else {
    st.sar += st.af * (st.ep - st.sar);
    if (st.up) { if (l < st.sar) { st.up = false; st.sar = Math.max(st.ep, h); st.ep = l; st.af = start; } else { if (h > st.ep) { st.ep = h; st.af = Math.min(st.af + inc, max); } st.sar = Math.min(st.sar, st.l1, st.l2 ?? st.l1); } }
    else { if (h > st.sar) { st.up = true; st.sar = Math.min(st.ep, l); st.ep = h; st.af = start; } else { if (l < st.ep) { st.ep = l; st.af = Math.min(st.af + inc, max); } st.sar = Math.max(st.sar, st.h1, st.h2 ?? st.h1); } }
  }
  st.h2 = st.h1; st.l2 = st.l1; st.h1 = h; st.l1 = l; return st.sar;
}
function fPivot(st, x, left, right, sign) {
  const n = left + right + 1; ring(st, n); rpush(st, x); if (st.k < st.n) return NaN;
  const c = rget(st, right); if (c !== c) return NaN;
  for (let k = 0; k < n; k++) { if (k === right) continue; const v = rget(st, k); if (v !== v) continue; if (k < right ? (sign > 0 ? v > c : v < c) : (sign > 0 ? v >= c : v <= c)) return NaN; }
  return c;
}
function fLinreg(st, x, n, off) { ring(st, n); rpush(st, x); if (!rfull(st)) return NaN; let sx = 0, sy = 0, sxy = 0, sxx = 0; for (let k = 0; k < n; k++) { const y = rget(st, n - 1 - k); sx += k; sy += y; sxy += k * y; sxx += k * k; } const sl = (n * sxy - sx * sy) / (n * sxx - sx * sx), ic = (sy - sl * sx) / n; return ic + sl * (n - 1 - (off || 0)); }

/* ---------------- Time helpers (exchange time = IST) ---------------- */
const mod = t => { const s = (t + IST) % 86400; return Math.floor(s / 60); };
const dateOf = t => new Date((t + IST) * 1000);
function inSession(t, sess) {
  if (isNa(sess) || sess === '') return true;
  const [rng, days] = String(sess).split(':'); const m = mod(t);
  if (days && !days.includes(String(dateOf(t).getUTCDay() + 1))) return false;
  return rng.split(',').some(r => { const q = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(r.trim()); if (!q) return false; const a = +q[1] * 60 + +q[2], b = +q[3] * 60 + +q[4]; return a <= b ? (m >= a && m < b) : (m >= a || m < b); });
}
function tsFrom(a) {
  a = a.filter(x => x !== undefined); if (typeof a[0] === 'string' && a.length > 1) a = a.slice(1);
  if (typeof a[0] === 'string') { const d = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(a[0]) ? a[0] : a[0].replace(' ', 'T') + (a[0].length <= 10 ? 'T00:00:00' : '') + '+05:30'); return d; }
  return Date.UTC(a[0], (a[1] || 1) - 1, a[2] || 1, a[3] || 0, a[4] || 0, a[5] || 0) - IST * 1000;
}

/* ---------------- Broker emulator ---------------- */
class Broker {
  constructor(R, opt) {
    this.R = R; this.opt = opt || {};
    this.cfg = { capital: 1000000, qtyType: 'fixed', qtyValue: 1, pyramiding: 0, commType: 'percent', commValue: 0, slippage: 0, pooc: false };
    this.lots = []; this.closed = []; this.orders = new Map(); this.exits = new Map();
    this.realized = 0; this.gp = 0; this.gl = 0; this.wins = 0; this.losses = 0; this.seq = 0;
    this.eq = new Float64Array(R.n); this.peak = 0; this.maxdd = 0; this.applyOpt();
  }
  applyOpt() {
    const o = this.opt, c = this.cfg;
    if (o.capital > 0) c.capital = +o.capital;
    if (o.slippage >= 0 && o.slippage !== '' && o.slippage != null) c.slippage = +o.slippage / TICK;
    if (o.commission >= 0 && o.commission !== '' && o.commission != null) { c.commType = 'cash_per_order'; c.commValue = +o.commission; }
    if (o.pooc === true) c.pooc = true;
  }
  declare(a) {
    const c = this.cfg;
    if (!isNa(a.initial_capital)) c.capital = a.initial_capital;
    if (!isNa(a.default_qty_type)) c.qtyType = a.default_qty_type;
    if (!isNa(a.default_qty_value)) c.qtyValue = a.default_qty_value;
    if (!isNa(a.pyramiding)) c.pyramiding = a.pyramiding;
    if (!isNa(a.commission_type)) c.commType = a.commission_type;
    if (!isNa(a.commission_value)) c.commValue = a.commission_value;
    if (!isNa(a.slippage)) c.slippage = a.slippage;
    if (a.process_orders_on_close === true) c.pooc = true;
    this.applyOpt();
  }
  get size() { let s = 0; for (const l of this.lots) s += l.dir * l.qty; return s; }
  get avg() { let s = 0, q = 0; for (const l of this.lots) { s += l.price * l.qty; q += l.qty; } return q ? s / q : NaN; }
  openPnl(px) { let s = 0; for (const l of this.lots) s += (px - l.price) * l.dir * l.qty; return s; }
  equity(px) { return this.cfg.capital + this.realized + this.openPnl(px); }
  comm(px, qty) { const c = this.cfg; return c.commType === 'percent' ? px * qty * c.commValue / 100 : c.commType === 'cash_per_contract' ? qty * c.commValue : c.commValue; }
  defQty(px) {
    const c = this.cfg; if (this.opt.qty > 0) return +this.opt.qty;
    if (c.qtyType === 'percent_of_equity') { const q = this.equity(px) * c.qtyValue / 100 / px; return q >= 1 ? Math.floor(q) : Math.max(0, +q.toFixed(4)); }
    if (c.qtyType === 'cash') { const q = c.qtyValue / px; return q >= 1 ? Math.floor(q) : +q.toFixed(4); }
    return c.qtyValue;
  }
  /* script-facing */
  entry(id, dir, a) {
    const o = { kind: 'entry', id: String(id), dir: dir === 'short' ? -1 : 1, qty: isNa(a.qty) ? null : a.qty, limit: isNa(a.limit) ? null : a.limit, stop: isNa(a.stop) ? null : a.stop, comment: isNa(a.comment) ? null : String(a.comment), seq: this.seq++ };
    this.orders.set('E:' + o.id, o);
  }
  close(id, a) { this.orders.set('C:' + id, { kind: 'close', id: String(id), comment: isNa(a.comment) ? null : String(a.comment), qty: isNa(a.qty) ? null : a.qty, pct: isNa(a.qty_percent) ? null : a.qty_percent, now: a.immediately === true, seq: this.seq++ }); }
  closeAll(a) { this.orders.set('CA', { kind: 'closeall', comment: isNa(a.comment) ? null : String(a.comment), now: a.immediately === true, seq: this.seq++ }); }
  exit(id, a) {
    const f = k => (isNa(a[k]) ? null : a[k]);
    const e = { id: String(id), from: isNa(a.from_entry) || a.from_entry === '' ? null : String(a.from_entry), qty: f('qty'), pct: f('qty_percent'), profit: f('profit'), loss: f('loss'), limit: f('limit'), stop: f('stop'), trailPoints: f('trail_points'), trailPrice: f('trail_price'), trailOffset: f('trail_offset'), comment: f('comment'), cp: f('comment_profit'), cl: f('comment_loss'), ct: f('comment_trailing') };
    e.key = e.id + '|' + (e.from || '');
    if (e.profit === null && e.loss === null && e.limit === null && e.stop === null && e.trailPoints === null && e.trailPrice === null) return;
    this.exits.set(e.key, e);
  }
  cancel(id) { this.orders.delete('E:' + id); for (const [k, e] of this.exits) if (e.id === String(id)) this.exits.delete(k); }
  cancelAll() { this.orders.clear(); this.exits.clear(); }
  /* fills */
  slip(px, dir) { return px + dir * this.cfg.slippage * TICK; }
  fillEntry(o, px, i, slipIt) {
    const cur = this.size;
    if (cur !== 0 && Math.sign(cur) !== o.dir) this.closeLots(() => true, px, i, 'Reversed by ' + (o.comment || o.id), null, slipIt);
    else if (cur !== 0) { const maxE = Math.max(1, this.cfg.pyramiding); if (this.lots.length >= maxE) return; }
    const fp = slipIt ? this.slip(px, o.dir) : px; const qty = o.qty ?? this.defQty(fp); if (!(qty > 0)) return;
    this.lots.push({ id: o.id, dir: o.dir, qty, qty0: qty, price: fp, i, comment: o.comment, hi: fp, lo: fp, comm: this.comm(fp, qty), done: {}, tr: {} });
  }
  closeLots(match, px, i, reason, qtyLimit, slipIt) {
    let left = qtyLimit == null ? Infinity : qtyLimit; const R = this.R, ids = new Set();
    for (let k = 0; k < this.lots.length && left > 1e-9; k++) {
      const l = this.lots[k]; if (!match(l)) continue;
      const q = Math.min(l.qty, left), fp = slipIt ? this.slip(px, -l.dir) : px, cIn = l.comm * q / l.qty, cOut = this.comm(fp, q);
      const pnl = (fp - l.price) * l.dir * q - cIn - cOut;
      l.hi = Math.max(l.hi, fp); l.lo = Math.min(l.lo, fp);
      this.closed.push({ n: this.closed.length + 1, id: l.id, dir: l.dir, qty: q, ei: l.i, et: R.t[l.i], ep: l.price, xi: i, xt: R.t[i], xp: fp, pnl, pct: (fp - l.price) * l.dir / l.price * 100, pts: (fp - l.price) * l.dir, mfe: (l.dir > 0 ? l.hi - l.price : l.price - l.lo), mae: (l.dir > 0 ? l.price - l.lo : l.hi - l.price), bars: i - l.i, comm: cIn + cOut, reason: reason || '', ec: l.comment || l.id });
      ids.add(l.id); this.realized += pnl; if (pnl > 0) { this.gp += pnl; this.wins++; } else if (pnl < 0) { this.gl -= pnl; this.losses++; }
      l.comm -= cIn; l.qty -= q; left -= q;
      if (l.qty <= 1e-9) { this.lots.splice(k, 1); k--; }
    }
    if (!this.lots.length) for (const [k, e] of this.exits) if (e.used || !e.from || ids.has(e.from)) this.exits.delete(k);
  }
  marketFills(i, px, onClose) {
    if (!this.orders.size) return;
    const list = [...this.orders.entries()].filter(([, o]) => o.kind !== 'entry' ? (!onClose || true) : (o.limit === null && o.stop === null)).sort((a, b) => a[1].seq - b[1].seq);
    for (const [k, o] of list) {
      if (onClose && !this.cfg.pooc && !o.now) continue;
      this.orders.delete(k);
      if (o.kind === 'closeall') this.closeLots(() => true, px, i, o.comment || 'Close all', null, true);
      else if (o.kind === 'close') { let lim = o.qty; if (o.pct != null) { let tot = 0; for (const l of this.lots) if (l.id === o.id) tot += l.qty; lim = tot * o.pct / 100; } this.closeLots(l => l.id === o.id, px, i, o.comment || 'Close', lim, true); }
      else this.fillEntry(o, px, i, true);
    }
  }
  levels(l, e) {
    const stop = e.stop !== null ? e.stop : (e.loss !== null ? l.price - l.dir * e.loss * TICK : null);
    const limit = e.limit !== null ? e.limit : (e.profit !== null ? l.price + l.dir * e.profit * TICK : null);
    let act = null; if (e.trailPrice !== null) act = e.trailPrice; else if (e.trailPoints !== null) act = l.price + l.dir * e.trailPoints * TICK;
    return { stop, limit, act, off: (e.trailOffset || 0) * TICK, trailing: e.trailPrice !== null || e.trailPoints !== null };
  }
  nextEvent(cur, b) {
    const d = Math.sign(b - cur); let best = null;
    const cand = (L, side, run) => { // side: +1 fires when price >= L, -1 when price <= L
      if (L === null || L !== L) return; let dist, px;
      if (side > 0 ? cur >= L : cur <= L) { dist = 0; px = cur; }
      else if (d !== 0 && side === d && (d > 0 ? L <= b : L >= b)) { dist = Math.abs(L - cur); px = L; } else return;
      if (!best || dist < best.dist) best = { dist, px, run };
    };
    for (const [k, o] of this.orders) {
      if (o.kind !== 'entry' || (o.limit === null && o.stop === null)) continue;
      if (o.stop !== null) cand(o.stop, o.dir, px => { this.orders.delete(k); this.fillEntry(o, px, this.R.i, true); });
      else cand(o.limit, -o.dir, px => { this.orders.delete(k); this.fillEntry(o, px, this.R.i, false); });
    }
    for (const l of this.lots) for (const [key, e] of this.exits) {
      if (l.done[key] || (e.from && e.from !== l.id)) continue;
      const lv = this.levels(l, e);
      const fire = (why, slipIt) => px => { l.done[key] = 1; e.used = 1; let lim = null; if (e.qty !== null) lim = e.qty; else if (e.pct !== null) lim = l.qty0 * e.pct / 100; this.closeLots(x => x === l, px, this.R.i, why || e.comment || e.id, lim, slipIt); };
      cand(lv.stop, -l.dir, fire(e.cl, true));
      cand(lv.limit, l.dir, fire(e.cp, false));
      if (lv.trailing) {
        const ts = l.tr[key] || (l.tr[key] = { on: false, best: NaN });
        if (!ts.on) cand(lv.act, l.dir, px => { ts.on = true; ts.best = px; });
        else { ts.best = l.dir > 0 ? Math.max(ts.best, cur) : Math.min(ts.best, cur); cand(ts.best - l.dir * lv.off, -l.dir, fire(e.ct, true)); }
      }
    }
    return best;
  }
  onBar(i) {
    const R = this.R, o = R.o[i], h = R.h[i], l = R.l[i], c = R.c[i];
    if (i > 0) {
      this.marketFills(i, o, false);
      if (this.lots.length || this.orders.size) {
        const pts = Math.abs(o - h) < Math.abs(o - l) ? [o, h, l, c] : [o, l, h, c];
        for (let s = 0; s < 3; s++) {
          let cur = pts[s]; const b = pts[s + 1];
          for (let g = 0; g < 40; g++) { const ev = this.nextEvent(cur, b); if (!ev) break; ev.run(ev.px); cur = ev.px; }
          for (const lt of this.lots) for (const key in lt.tr) { const ts = lt.tr[key]; if (ts.on) ts.best = lt.dir > 0 ? Math.max(ts.best, b) : Math.min(ts.best, b); }
        }
        for (const lt of this.lots) { if (h > lt.hi) lt.hi = h; if (l < lt.lo) lt.lo = l; }
      }
    }
  }
  after(i) {
    const c = this.R.c[i]; this.marketFills(i, c, true);
    const e = this.equity(c); this.eq[i] = e; if (e > this.peak) this.peak = e; if (this.peak - e > this.maxdd) this.maxdd = this.peak - e;
  }
}

/* ---------------- Built-in functions ---------------- */
// each entry: [parameter names, fn(a, st, R), needsState]
const F = {};
const def = (name, params, fn, st) => { F[name] = { p: params ? params.split(',') : [], f: fn, s: !!st }; };
const L = x => Math.max(1, Math.floor(num(x)));
def('ta.sma', 'source,length', (a, st) => fSma(st, num(a[0]), L(a[1])), 1);
def('ta.ema', 'source,length', (a, st) => fEma(st, num(a[0]), L(a[1])), 1);
def('ta.rma', 'source,length', (a, st) => fRma(st, num(a[0]), L(a[1])), 1);
def('ta.wma', 'source,length', (a, st) => fWma(st, num(a[0]), L(a[1])), 1);
def('ta.vwma', 'source,length', (a, st, R) => { const v = R.v[R.i] || 1; return fSma(sub(st, 'a'), num(a[0]) * v, L(a[1])) / fSma(sub(st, 'b'), v, L(a[1])); }, 1);
def('ta.hma', 'source,length', (a, st) => { const n = L(a[1]), x = num(a[0]); const d = 2 * fWma(sub(st, 'a'), x, Math.max(1, Math.floor(n / 2))) - fWma(sub(st, 'b'), x, n); return fWma(sub(st, 'c'), d, Math.max(1, Math.floor(Math.sqrt(n)))); }, 1);
def('ta.swma', 'source', (a, st) => { ring(st, 4); rpush(st, num(a[0])); return rfull(st) ? (rget(st, 3) + 2 * rget(st, 2) + 2 * rget(st, 1) + rget(st, 0)) / 6 : NaN; }, 1);
def('ta.stdev', 'source,length', (a, st) => fStdev(st, num(a[0]), L(a[1])), 1);
def('ta.variance', 'source,length', (a, st) => { const s = fStdev(st, num(a[0]), L(a[1])); return s * s; }, 1);
def('ta.dev', 'source,length', (a, st) => { const n = L(a[1]); ring(st, n); rpush(st, num(a[0])); if (!rfull(st)) return NaN; const m = st.s / n; let s = 0; for (let k = 0; k < n; k++) s += Math.abs(st.b[k] - m); return s / n; }, 1);
def('ta.median', 'source,length', (a, st) => { const n = L(a[1]); ring(st, n); rpush(st, num(a[0])); if (!rfull(st)) return NaN; const q = Array.from(st.b).sort((x, y) => x - y); return n % 2 ? q[(n - 1) / 2] : (q[n / 2 - 1] + q[n / 2]) / 2; }, 1);
const ext = (sign, srcDefault, idx) => (a, st, R) => { let src, n; if (a[1] === undefined) { n = a[0]; src = R[srcDefault][R.i]; } else { src = num(a[0]); n = a[1]; } return fExt(st, src, L(n), sign)[idx]; };
def('ta.highest', 'source,length', ext(1, 'h', 0), 1); def('ta.lowest', 'source,length', ext(-1, 'l', 0), 1);
def('ta.highestbars', 'source,length', ext(1, 'h', 1), 1); def('ta.lowestbars', 'source,length', ext(-1, 'l', 1), 1);
def('ta.range', 'source,length', (a, st) => fExt(sub(st, 'h'), num(a[0]), L(a[1]), 1)[0] - fExt(sub(st, 'l'), num(a[0]), L(a[1]), -1)[0], 1);
def('ta.rsi', 'source,length', (a, st) => fRsi(st, num(a[0]), L(a[1])), 1);
def('ta.macd', 'source,fastlen,slowlen,siglen', (a, st) => { const x = num(a[0]); const m = fEma(sub(st, 'f'), x, L(a[1])) - fEma(sub(st, 's'), x, L(a[2])); const sg = fEma(sub(st, 'g'), m, L(a[3])); return [m, sg, m - sg]; }, 1);
def('ta.tr', 'handle_na', (a, st, R) => fTr(R, st, a[0] === true), 0);
def('ta.atr', 'length', (a, st, R) => fAtr(R, st, L(a[0])), 1);
def('ta.bb', 'series,length,mult', (a, st) => { const x = num(a[0]), n = L(a[1]), b = fSma(sub(st, 'a'), x, n), d = fStdev(sub(st, 'b'), x, n) * num(a[2]); return [b, b + d, b - d]; }, 1);
def('ta.bbw', 'series,length,mult', (a, st) => { const x = num(a[0]), n = L(a[1]), b = fSma(sub(st, 'a'), x, n), d = fStdev(sub(st, 'b'), x, n) * num(a[2]); return 2 * d / b * 100; }, 1);
def('ta.kc', 'series,length,mult,useTrueRange', (a, st, R) => { const n = L(a[1]), b = fEma(sub(st, 'a'), num(a[0]), n), rng = a[3] === false ? R.h[R.i] - R.l[R.i] : fTr(R, st, true), r = fEma(sub(st, 'b'), rng, n) * num(a[2]); return [b, b + r, b - r]; }, 1);
def('ta.stoch', 'source,high,low,length', (a, st) => { const n = L(a[3]), hh = fExt(sub(st, 'h'), num(a[1]), n, 1)[0], ll = fExt(sub(st, 'l'), num(a[2]), n, -1)[0]; return hh === ll ? NaN : 100 * (num(a[0]) - ll) / (hh - ll); }, 1);
def('ta.cci', 'source,length', (a, st) => { const x = num(a[0]), n = L(a[1]); ring(st, n); rpush(st, x); if (!rfull(st)) return NaN; const m = st.s / n; let d = 0; for (let k = 0; k < n; k++) d += Math.abs(st.b[k] - m); d /= n; return d === 0 ? 0 : (x - m) / (0.015 * d); }, 1);
def('ta.wpr', 'length', (a, st, R) => { const n = L(a[0]), hh = fExt(sub(st, 'h'), R.h[R.i], n, 1)[0], ll = fExt(sub(st, 'l'), R.l[R.i], n, -1)[0]; return hh === ll ? NaN : 100 * (R.c[R.i] - hh) / (hh - ll); }, 1);
def('ta.mom', 'source,length', (a, st) => { const n = L(a[1]); ring(st, n + 1); rpush(st, num(a[0])); return st.k < st.n ? NaN : num(a[0]) - rget(st, n); }, 1);
def('ta.change', 'source,length', (a, st) => { const n = a[1] === undefined ? 1 : L(a[1]); ring(st, n + 1); const x = a[0]; rpush(st, num(x)); if (st.k < st.n) return typeof x === 'boolean' ? false : NaN; const pv = rget(st, n); return typeof x === 'boolean' ? num(x) !== pv : num(x) - pv; }, 1);
def('ta.roc', 'source,length', (a, st) => { const n = L(a[1]); ring(st, n + 1); rpush(st, num(a[0])); if (st.k < st.n) return NaN; const pv = rget(st, n); return 100 * (num(a[0]) - pv) / pv; }, 1);
const cross = mode => (a, st) => { const x = num(a[0]), y = num(a[1]), px = st.x, py = st.y; st.x = x; st.y = y; if (px === undefined || px !== px || py !== py || x !== x || y !== y) return false; const up = x > y && px <= py, dn = x < y && px >= py; return mode > 0 ? up : mode < 0 ? dn : up || dn; };
def('ta.crossover', 'source1,source2', cross(1), 1); def('ta.crossunder', 'source1,source2', cross(-1), 1); def('ta.cross', 'source1,source2', cross(0), 1);
def('ta.rising', 'source,length', (a, st) => { const n = L(a[1]); ring(st, n + 1); rpush(st, num(a[0])); if (st.k < st.n) return false; for (let k = 0; k < n; k++) if (!(rget(st, k) > rget(st, k + 1))) return false; return true; }, 1);
def('ta.falling', 'source,length', (a, st) => { const n = L(a[1]); ring(st, n + 1); rpush(st, num(a[0])); if (st.k < st.n) return false; for (let k = 0; k < n; k++) if (!(rget(st, k) < rget(st, k + 1))) return false; return true; }, 1);
def('ta.supertrend', 'factor,atrPeriod', (a, st, R) => fSuper(R, st, num(a[0]), L(a[1])), 1);
def('ta.dmi', 'diLength,adxSmoothing', (a, st, R) => fDmi(R, st, L(a[0]), L(a[1])), 1);
def('ta.sar', 'start,inc,max', (a, st, R) => fSar(R, st, num(a[0]), num(a[1]), num(a[2])), 1);
def('ta.vwap', 'source', (a, st, R) => { const i = R.i, day = Math.floor((R.t[i] + IST) / 86400); if (st.day !== day) { st.day = day; st.pv = 0; st.vv = 0; } const src = a[0] === undefined ? (R.h[i] + R.l[i] + R.c[i]) / 3 : num(a[0]), v = R.v[i] || 1; st.pv += src * v; st.vv += v; return st.pv / st.vv; }, 1);
def('ta.obv', '', (a, st, R) => { const i = R.i; st.v = (st.v || 0) + (i > 0 ? Math.sign(R.c[i] - R.c[i - 1]) * R.v[i] : 0); return st.v; }, 1);
def('ta.cum', 'source', (a, st) => { const x = num(a[0]); st.v = (st.v || 0) + (x === x ? x : 0); return st.v; }, 1);
def('ta.barssince', 'condition', (a, st) => { if (a[0] === true || (typeof a[0] === 'number' && a[0] !== 0 && a[0] === a[0])) st.n = 0; else if (st.n !== undefined) st.n++; return st.n === undefined ? NaN : st.n; }, 1);
def('ta.valuewhen', 'condition,source,occurrence', (a, st) => { if (!st.q) st.q = []; if (a[0] === true || (typeof a[0] === 'number' && a[0])) { st.q.unshift(a[1]); if (st.q.length > 50) st.q.pop(); } const v = st.q[Math.floor(num(a[2]) || 0)]; return v === undefined ? NaN : v; }, 1);
const piv = sign => (a, st, R) => { let src, l, r; if (a[2] === undefined) { src = R[sign > 0 ? 'h' : 'l'][R.i]; l = a[0]; r = a[1]; } else { src = num(a[0]); l = a[1]; r = a[2]; } return fPivot(st, src, L(l), L(r), sign); };
def('ta.pivothigh', 'source,leftbars,rightbars', piv(1), 1); def('ta.pivotlow', 'source,leftbars,rightbars', piv(-1), 1);
def('ta.linreg', 'source,length,offset', (a, st) => fLinreg(st, num(a[0]), L(a[1]), num(a[2]) || 0), 1);
def('ta.mfi', 'series,length', (a, st, R) => { const n = L(a[1]), x = num(a[0]), v = R.v[R.i] || 1, pv = st.pv; st.pv = x; const up = pv !== undefined && x > pv ? x * v : 0, dn = pv !== undefined && x < pv ? x * v : 0; const u = fSma(sub(st, 'u'), up, n) * n, d = fSma(sub(st, 'd'), dn, n) * n; return d === 0 ? 100 : 100 - 100 / (1 + u / d); }, 1);
def('math.sum', 'source,length', (a, st) => { ring(st, L(a[1])); rpush(st, num(a[0])); return rfull(st) ? st.s : NaN; }, 1);
const m1 = (n, f) => def('math.' + n, 'x', a => f(num(a[0])));
m1('abs', Math.abs); m1('floor', Math.floor); m1('ceil', Math.ceil); m1('sqrt', Math.sqrt); m1('log', Math.log); m1('log10', Math.log10); m1('exp', Math.exp); m1('sign', Math.sign); m1('sin', Math.sin); m1('cos', Math.cos); m1('tan', Math.tan); m1('atan', Math.atan);
def('math.round', 'number,precision', a => { const x = num(a[0]); if (a[1] === undefined) return Math.round(x); const k = Math.pow(10, a[1]); return Math.round(x * k) / k; });
def('math.pow', 'base,exponent', a => Math.pow(num(a[0]), num(a[1])));
def('math.max', '*', a => { let m = -Infinity; for (const x of a) { const v = num(x); if (v !== v) return NaN; if (v > m) m = v; } return m; });
def('math.min', '*', a => { let m = Infinity; for (const x of a) { const v = num(x); if (v !== v) return NaN; if (v < m) m = v; } return m; });
def('math.avg', '*', a => { let s = 0; for (const x of a) s += num(x); return s / a.length; });
def('math.round_to_mintick', 'number', a => Math.round(num(a[0]) / TICK) * TICK);
def('math.random', 'min,max', a => { const lo = a[0] === undefined ? 0 : a[0], hi = a[1] === undefined ? 1 : a[1]; return lo + Math.random() * (hi - lo); });
def('na', 'x', a => isNa(a[0]));
def('nz', 'source,replacement', a => (isNa(a[0]) ? (a[1] === undefined ? 0 : a[1]) : a[0]));
def('fixnan', 'source', (a, st) => { if (!isNa(a[0])) st.v = a[0]; return st.v === undefined ? NaN : st.v; }, 1);
def('int', 'x', a => Math.trunc(num(a[0]))); def('float', 'x', a => num(a[0])); def('bool', 'x', a => !isNa(a[0]) && !!a[0]); def('string', 'x', a => String(a[0])); def('color', 'x', a => a[0]);
def('str.tostring', 'value,format', a => { const v = a[0]; if (typeof v !== 'number') return String(v); if (v !== v) return 'NaN'; const f = a[1]; if (typeof f === 'string') { const m = /\.(#+|0+)/.exec(f); return v.toFixed(m ? m[1].length : 0); } return String(+v.toFixed(6)); });
def('str.format', '*', a => String(a[0]).replace(/\{(\d+)[^}]*\}/g, (m, k) => String(a[+k + 1])));
def('str.length', 's', a => String(a[0]).length); def('str.contains', 's,sub', a => String(a[0]).includes(a[1])); def('str.upper', 's', a => String(a[0]).toUpperCase()); def('str.lower', 's', a => String(a[0]).toLowerCase());
def('str.tonumber', 's', a => parseFloat(a[0])); def('str.startswith', 's,sub', a => String(a[0]).startsWith(a[1])); def('str.replace_all', 's,target,replacement', a => String(a[0]).split(a[1]).join(a[2]));
def('color.new', 'color,transp', a => rgba(a[0], num(a[1])));
def('color.rgb', 'red,green,blue,transp', a => `rgba(${a[0]},${a[1]},${a[2]},${+(1 - (a[3] || 0) / 100).toFixed(3)})`);
def('timestamp', '*', a => tsFrom(a));
def('time', 'timeframe,session,timezone', (a, st, R) => (inSession(R.t[R.i], a[1]) ? R.t[R.i] * 1000 : NaN));
def('time_close', 'timeframe,session', (a, st, R) => (inSession(R.t[R.i], a[1]) ? (R.t[R.i] + R.tf * 60) * 1000 : NaN));
const tpart = (n, f) => def(n, 'time', (a, st, R) => f(a[0] === undefined ? dateOf(R.t[R.i]) : new Date(a[0] + IST * 1000)));
tpart('year', d => d.getUTCFullYear()); tpart('month', d => d.getUTCMonth() + 1); tpart('dayofmonth', d => d.getUTCDate()); tpart('dayofweek', d => d.getUTCDay() + 1); tpart('hour', d => d.getUTCHours()); tpart('minute', d => d.getUTCMinutes()); tpart('second', d => d.getUTCSeconds());
// arrays (basic)
const arr = (n, p, f) => def('array.' + n, p, f);
['new_float', 'new_int', 'new_bool', 'new_string', 'new_color', 'new'].forEach(n => arr(n, 'size,initial_value', a => new Array(Math.floor(a[0] || 0)).fill(a[1] === undefined ? NaN : a[1])));
arr('from', '*', a => a.slice()); arr('push', 'id,value', a => { a[0].push(a[1]); }); arr('pop', 'id', a => a[0].pop()); arr('shift', 'id', a => a[0].shift()); arr('unshift', 'id,value', a => { a[0].unshift(a[1]); });
arr('get', 'id,index', a => { const v = a[0][a[1] < 0 ? a[0].length + a[1] : a[1]]; return v === undefined ? NaN : v; }); arr('set', 'id,index,value', a => { a[0][a[1]] = a[2]; });
arr('size', 'id', a => a[0].length); arr('clear', 'id', a => { a[0].length = 0; }); arr('sum', 'id', a => a[0].reduce((s, x) => s + num(x), 0)); arr('avg', 'id', a => a[0].reduce((s, x) => s + num(x), 0) / a[0].length);
arr('max', 'id', a => Math.max(...a[0])); arr('min', 'id', a => Math.min(...a[0])); arr('first', 'id', a => a[0][0]); arr('last', 'id', a => a[0][a[0].length - 1]); arr('includes', 'id,value', a => a[0].includes(a[1])); arr('indexof', 'id,value', a => a[0].indexOf(a[1]));
arr('remove', 'id,index', a => a[0].splice(a[1], 1)[0]); arr('insert', 'id,index,value', a => { a[0].splice(a[1], 0, a[2]); }); arr('slice', 'id,index_from,index_to', a => a[0].slice(a[1], a[2])); arr('copy', 'id', a => a[0].slice()); arr('reverse', 'id', a => { a[0].reverse(); });
arr('sort', 'id,order', a => { a[0].sort((x, y) => (a[1] === 'order.descending' ? y - x : x - y)); }); arr('stdev', 'id', a => { const q = a[0], m = q.reduce((s, x) => s + x, 0) / q.length; return Math.sqrt(q.reduce((s, x) => s + (x - m) * (x - m), 0) / q.length); });
// strategy
const SP = 'id,direction,qty,limit,stop,oca_name,oca_type,comment,alert_message,disable_alert,when';
const sEntry = (a, st, R) => { if (a[10] === false) return; R.broker.entry(a[0], a[1], { qty: a[2], limit: a[3], stop: a[4], comment: a[7] }); };
def('strategy.entry', SP, sEntry); def('strategy.order', SP, sEntry);
def('strategy.close', 'id,comment,qty,qty_percent,alert_message,immediately,disable_alert,when', (a, st, R) => { if (a[7] === false) return; R.broker.close(a[0], { comment: a[1], qty: a[2], qty_percent: a[3], immediately: a[5] }); });
def('strategy.close_all', 'comment,alert_message,immediately,disable_alert,when', (a, st, R) => { if (a[4] === false) return; if (typeof a[0] === 'boolean') { if (!a[0]) return; a[0] = undefined; } R.broker.closeAll({ comment: a[0], immediately: a[2] }); });
const XP = 'id,from_entry,qty,qty_percent,profit,limit,loss,stop,trail_price,trail_points,trail_offset,oca_name,comment,comment_profit,comment_loss,comment_trailing,alert_message,alert_profit,alert_loss,alert_trailing,disable_alert,when';
def('strategy.exit', XP, (a, st, R) => { if (a[21] === false) return; const o = {}; XP.split(',').forEach((k, j) => { o[k] = a[j]; }); R.broker.exit(a[0], o); });
def('strategy.cancel', 'id', (a, st, R) => R.broker.cancel(a[0])); def('strategy.cancel_all', '', (a, st, R) => R.broker.cancelAll());
def('strategy.opentrades.entry_price', 'n', (a, st, R) => { const l = R.broker.lots[a[0] || 0]; return l ? l.price : NaN; });
def('strategy.opentrades.entry_bar_index', 'n', (a, st, R) => { const l = R.broker.lots[a[0] || 0]; return l ? l.i : NaN; });
def('strategy.opentrades.entry_time', 'n', (a, st, R) => { const l = R.broker.lots[a[0] || 0]; return l ? R.t[l.i] * 1000 : NaN; });
def('strategy.opentrades.size', 'n', (a, st, R) => { const l = R.broker.lots[a[0] || 0]; return l ? l.qty * l.dir : NaN; });
def('strategy.opentrades.profit', 'n', (a, st, R) => { const l = R.broker.lots[a[0] || 0]; return l ? (R.c[R.i] - l.price) * l.dir * l.qty : NaN; });
const ct = (n, f) => def('strategy.closedtrades.' + n, 'n', (a, st, R) => { const t = R.broker.closed[a[0] || 0]; return t ? f(t) : NaN; });
ct('profit', t => t.pnl); ct('entry_price', t => t.ep); ct('exit_price', t => t.xp); ct('entry_bar_index', t => t.ei); ct('exit_bar_index', t => t.xi); ct('size', t => t.qty * t.dir);
// plots
def('plot', 'series,title,color,linewidth,style,trackprice,histbase,offset,join,editable,show_last,display', (a, st, R, node) => {
  if (a[11] === 'display.none') return; let p = st.p; if (!p) { p = st.p = { title: isNa(a[1]) ? 'Plot ' + (R.plots.length + 1) : a[1], data: new Float64Array(R.n).fill(NaN), ci: new Uint8Array(R.n), pal: [], width: a[3] || 1, style: a[4] || 'plot.style_line' }; R.plots.push(p); }
  p.data[R.i] = num(a[0]); const c = isNa(a[2]) ? '' : a[2]; let k = p.pal.indexOf(c); if (k < 0) { if (p.pal.length < 250) { p.pal.push(c); k = p.pal.length - 1; } else k = 0; } p.ci[R.i] = k;
}, 1);
const shape = (a, st, R) => { const v = a[0]; if (isNa(v) || v === false || v === 0) return; if (R.shapes.length < 30000) R.shapes.push({ i: R.i, style: a[2] || 'shape.xcross', loc: a[3] || 'location.abovebar', color: isNa(a[4]) ? '' : a[4], text: isNa(a[6]) ? '' : a[6] }); };
def('plotshape', 'series,title,style,location,color,offset,text,textcolor,editable,size,show_last,display', shape);
def('plotchar', 'series,title,char,location,color,offset,text,textcolor,editable,size,show_last,display', (a, st, R) => shape([a[0], a[1], 'shape.circle', a[3], a[4], a[5], isNa(a[6]) ? a[2] : a[6]], st, R));
def('hline', 'price,title,color,linestyle,linewidth', (a, st, R) => { if (!st.d) { st.d = 1; R.hlines.push({ price: num(a[0]), title: a[1] || '', color: isNa(a[2]) ? '' : a[2] }); } }, 1);
def('bgcolor', 'color,offset,editable,show_last,title', (a, st, R) => { if (!isNa(a[0]) && R.bg.length < 60000) R.bg.push([R.i, a[0]]); });
def('strategy', '*', () => {}); def('indicator', '*', () => {});
def('runtime.error', 'message', a => { throw new PineError(String(a[0])); });
const NOOP = /^(label|line|box|table|linefill|polyline|log)\.|^(alert|alertcondition|barcolor|fill|plotcandle|plotbar|plotarrow|max_bars_back)$/;
const BLOCKED = { 'request.security': 'request.security (data from other symbols or timeframes)', 'request.security_lower_tf': 'request.security_lower_tf', 'request.financial': 'request.financial', 'request.dividends': 'request.dividends', 'ticker.new': 'ticker.new' };

/* ---------------- Built-in variables ---------------- */
function makeVars(R) {
  const V = {}; const ser = (n, at) => { V[n] = { at }; };
  ser('open', j => R.o[j]); ser('high', j => R.h[j]); ser('low', j => R.l[j]); ser('close', j => R.c[j]); ser('volume', j => R.v[j]);
  ser('hl2', j => (R.h[j] + R.l[j]) / 2); ser('hlc3', j => (R.h[j] + R.l[j] + R.c[j]) / 3); ser('ohlc4', j => (R.o[j] + R.h[j] + R.l[j] + R.c[j]) / 4); ser('hlcc4', j => (R.h[j] + R.l[j] + 2 * R.c[j]) / 4);
  ser('time', j => R.t[j] * 1000); ser('time_close', j => (R.t[j] + R.tf * 60) * 1000); ser('bar_index', j => j); ser('n', j => j);
  ser('year', j => dateOf(R.t[j]).getUTCFullYear()); ser('month', j => dateOf(R.t[j]).getUTCMonth() + 1); ser('dayofmonth', j => dateOf(R.t[j]).getUTCDate()); ser('dayofweek', j => dateOf(R.t[j]).getUTCDay() + 1);
  ser('hour', j => Math.floor(mod(R.t[j]) / 60)); ser('minute', j => mod(R.t[j]) % 60); ser('second', () => 0);
  const g = (n, get) => { V[n] = { get }; }, B = () => R.broker;
  g('last_bar_index', () => R.n - 1); g('timenow', () => Date.now()); g('last_bar_time', () => R.t[R.n - 1] * 1000);
  g('strategy.position_size', () => B().size); g('strategy.position_avg_price', () => B().avg); g('strategy.equity', () => B().equity(R.c[R.i]));
  g('strategy.netprofit', () => B().realized); g('strategy.openprofit', () => B().openPnl(R.c[R.i])); g('strategy.grossprofit', () => B().gp); g('strategy.grossloss', () => B().gl);
  g('strategy.closedtrades', () => B().closed.length); g('strategy.opentrades', () => B().lots.length); g('strategy.wintrades', () => B().wins); g('strategy.losstrades', () => B().losses);
  g('strategy.initial_capital', () => B().cfg.capital); g('strategy.max_drawdown', () => B().maxdd);
  g('barstate.isfirst', () => R.i === 0); g('barstate.islast', () => R.i === R.n - 1); g('barstate.isconfirmed', () => true); g('barstate.ishistory', () => true); g('barstate.isrealtime', () => false); g('barstate.isnew', () => true); g('barstate.islastconfirmedhistory', () => R.i === R.n - 1);
  g('session.ismarket', () => true); g('session.isfirstbar', () => R.i === 0 || Math.floor((R.t[R.i] + IST) / 86400) !== Math.floor((R.t[R.i - 1] + IST) / 86400)); g('session.isfirstbar_regular', () => V['session.isfirstbar'].get());
  g('session.islastbar', () => R.i === R.n - 1 || Math.floor((R.t[R.i] + IST) / 86400) !== Math.floor((R.t[R.i + 1] + IST) / 86400));
  const k = (n, v) => { V[n] = { get: () => v }; };
  k('strategy.long', 'long'); k('strategy.short', 'short'); k('strategy.fixed', 'fixed'); k('strategy.percent_of_equity', 'percent_of_equity'); k('strategy.cash', 'cash');
  k('strategy.commission.percent', 'percent'); k('strategy.commission.cash_per_contract', 'cash_per_contract'); k('strategy.commission.cash_per_order', 'cash_per_order');
  k('timeframe.period', String(R.tf)); k('timeframe.multiplier', R.tf); k('timeframe.isintraday', true); k('timeframe.isminutes', true); k('timeframe.isdaily', false); k('timeframe.isweekly', false); k('timeframe.ismonthly', false); k('timeframe.isdwm', false); k('timeframe.isseconds', false);
  k('syminfo.ticker', R.symbol); k('syminfo.tickerid', 'NSE:' + R.symbol); k('syminfo.mintick', TICK); k('syminfo.pointvalue', 1); k('syminfo.currency', 'INR'); k('syminfo.timezone', 'Asia/Kolkata'); k('syminfo.prefix', 'NSE'); k('syminfo.type', 'index'); k('syminfo.session', '0915-1530');
  k('math.pi', Math.PI); k('math.e', Math.E); k('math.phi', 1.618033988749895);
  ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].forEach((d, j) => k('dayofweek.' + d, j + 1));
  for (const c in COLORS) k('color.' + c, COLORS[c]);
  return V;
}
const CONSTNS = /^(plot|shape|location|size|hline|display|format|scale|xloc|yloc|extend|label|line|text|position|order|session|currency|barmerge|alert|font|adjustment|strategy\.(direction|oca))\./;
const SOURCES = ['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4', 'hlcc4'];

/* ---------------- Compiler ---------------- */
function compile(ast, R) {
  const V = makeVars(R); const warnings = R.warnings, gstate = new Array(ast.count), pstate = new Map();
  const getState = id => { if (R.path === 0) return gstate[id] || (gstate[id] = {}); const key = id + ':' + R.path; let s = pstate.get(key); if (!s) pstate.set(key, s = {}); return s; };
  const vals = R.vals, hist = R.hist; let nslots = 0; const needHist = R.needHist;
  class Scope { constructor(parent, fn) { this.m = new Map(); this.parent = parent; this.fn = fn || (parent && parent.fn) || null; }
    find(n) { for (let s = this; s; s = s.parent) if (s.m.has(n)) return s.m.get(n); return null; }
    declare(n, boxed) { let e; if (this.fn) e = { k: boxed ? 'b' : 'l', idx: this.fn.nl++ }; else e = { k: 'g', slot: nslots++ }; this.m.set(n, e); return e; } }
  const dotted = n => (n.type === 'Id' ? n.name : n.type === 'Member' ? (() => { const b = dotted(n.obj); return b === null ? null : b + '.' + n.prop; })() : null);
  const rootId = n => (n.type === 'Id' ? n.name : n.type === 'Member' ? rootId(n.obj) : null);
  const err = (msg, node) => new PineError(msg, node.line);
  function reader(e) { return e.k === 'g' ? () => vals[e.slot] : e.k === 'l' ? () => R.frame[e.idx] : () => R.frame[e.idx].v; }
  function writer(e) { return e.k === 'g' ? v => { vals[e.slot] = v; } : e.k === 'l' ? v => { R.frame[e.idx] = v; } : v => { R.frame[e.idx].v = v; }; }
  function genericHist(node, f) { const id = node.id; return k => { const st = getState(id); if (!st.a) st.a = []; const v = f(); st.a[R.i] = v; if (k === 0) return v; const j = R.i - k; if (j < 0) return NaN; const q = st.a[j]; return q === undefined ? NaN : q; }; }
  function cBlock(stmts, scope) {
    const fs = stmts.map(s => cStmt(s, scope)); const n = fs.length;
    if (n === 1) return fs[0];
    return () => { let v; for (let k = 0; k < n; k++) { v = fs[k](); if (R.brk) break; } return v; };
  }
  function cStmt(s, scope) {
    const line = s.line; const f = cStmt0(s, scope);
    return () => { R.line = line; return f(); };
  }
  function cStmt0(s, scope) {
    switch (s.type) {
      case 'ExprStmt': return cExpr(s.expr, scope);
      case 'VarDecl': {
        const init = cExpr(s.init, scope);
        if (s.mode === 'var') {
          if (scope.fn) { const e = scope.declare(s.name, true), id = s.id; return () => { const st = getState(id); if (!st.box) st.box = { v: init() }; R.frame[e.idx] = st.box; return st.box.v; }; }
          const e = scope.declare(s.name), sl = e.slot; let done = false; R.resets.push(() => { done = false; });
          return () => { if (!done) { done = true; vals[sl] = init(); } return vals[sl]; };
        }
        const e = scope.declare(s.name), w = writer(e); return () => { const v = init(); w(v); return v; };
      }
      case 'TupleDecl': { const init = cExpr(s.init, scope); const ws = s.names.map(n => (n === '_' ? null : writer(scope.declare(n)))); return () => { const v = init(); if (!Array.isArray(v)) throw new PineError('The right side does not return a list of values'); for (let k = 0; k < ws.length; k++) if (ws[k]) ws[k](v[k]); return v; }; }
      case 'Assign': {
        const e = scope.find(s.name); if (!e || e.k === 'f') throw err(`"${s.name}" is not declared. Declare it first with "${s.name} = ..."`, s);
        const val = cExpr(s.value, scope), w = writer(e), r = reader(e), op = s.op;
        if (op === ':=') return () => { const v = val(); w(v); return v; };
        return () => { const a = r(), b = val(); const v = op === '+=' ? (typeof a === 'string' ? a + b : num(a) + num(b)) : op === '-=' ? num(a) - num(b) : op === '*=' ? num(a) * num(b) : op === '/=' ? num(a) / num(b) : num(a) % num(b); w(v); return v; };
      }
      case 'If': return cIf(s, scope);
      case 'Switch': return cSwitch(s, scope);
      case 'For': {
        const from = cExpr(s.from, scope), to = cExpr(s.to, scope), step = s.step ? cExpr(s.step, scope) : null;
        const inner = new Scope(scope), w = writer(inner.declare(s.v)), body = cBlock(s.body, inner);
        return () => { const a = num(from()), b = num(to()); let st = step ? Math.abs(num(step())) : 1; if (!(st > 0)) st = 1; let v, c = 0;
          if (a <= b) for (let x = a; x <= b; x += st) { w(x); v = body(); if (R.brk === 1) { R.brk = 0; break; } R.brk = 0; if (++c > 500000) throw new PineError('The loop runs too long'); }
          else for (let x = a; x >= b; x -= st) { w(x); v = body(); if (R.brk === 1) { R.brk = 0; break; } R.brk = 0; if (++c > 500000) throw new PineError('The loop runs too long'); }
          return v; };
      }
      case 'ForIn': { const it = cExpr(s.iter, scope), inner = new Scope(scope), w = writer(inner.declare(s.v)), body = cBlock(s.body, inner); return () => { const q = it(); let v; if (Array.isArray(q)) for (const x of q.slice()) { w(x); v = body(); if (R.brk === 1) { R.brk = 0; break; } R.brk = 0; } return v; }; }
      case 'While': { const test = cExpr(s.test, scope), body = cBlock(s.body, new Scope(scope)); return () => { let v, c = 0; while (test() === true) { v = body(); if (R.brk === 1) { R.brk = 0; break; } R.brk = 0; if (++c > 500000) throw new PineError('The while loop runs too long'); } return v; }; }
      case 'Break': return () => { R.brk = 1; }; case 'Continue': return () => { R.brk = 2; };
      case 'FuncDef': {
        const fn = { nl: 0 }, fs = new Scope(scope, fn); const e = { k: 'f', params: s.params, fn }; scope.m.set(s.name, e);
        const pw = s.params.map(pm => fs.declare(pm.name).idx); e.defs = s.params.map(pm => (pm.def ? cExpr(pm.def, scope) : null)); e.pidx = pw;
        e.body = cBlock(s.body, fs); return () => undefined;
      }
    }
    throw err('Unsupported statement', s);
  }
  const truthy = v => v === true || (typeof v === 'number' && v === v && v !== 0);
  function cIf(s, scope) { const test = cExpr(s.test, scope), cons = cBlock(s.cons, new Scope(scope)), alt = s.alt ? cBlock(s.alt, new Scope(scope)) : null; return () => (truthy(test()) ? cons() : alt ? alt() : NaN); }
  function cSwitch(s, scope) {
    const disc = s.disc ? cExpr(s.disc, scope) : null; const cs = s.cases.map(c => ({ t: c.test ? cExpr(c.test, scope) : null, b: cBlock(c.body, new Scope(scope)) }));
    return () => { const d = disc ? disc() : null; for (const c of cs) { if (!c.t) return c.b(); const v = c.t(); if (disc ? v === d : truthy(v)) return c.b(); } return NaN; };
  }
  function cExpr(n, scope) {
    switch (n.type) {
      case 'Num': case 'Str': case 'Bool': { const v = n.v; return () => v; }
      case 'Na': return () => NaN;
      case 'If': return cIf(n, scope); case 'Switch': return cSwitch(n, scope);
      case 'ArrayLit': { const fs = n.elems.map(e => cExpr(e, scope)); return () => fs.map(f => f()); }
      case 'Ternary': { const t = cExpr(n.test, scope), a = cExpr(n.a, scope), b = cExpr(n.b, scope); return () => (truthy(t()) ? a() : b()); }
      case 'Unary': { const a = cExpr(n.arg, scope); return n.op === 'not' ? () => !truthy(a()) : n.op === '-' ? () => -num(a()) : () => num(a()); }
      case 'Binary': {
        const l = cExpr(n.l, scope), r = cExpr(n.r, scope);
        switch (n.op) {
          case '+': return () => { const a = l(), b = r(); return typeof a === 'string' || typeof b === 'string' ? String(a) + String(b) : num(a) + num(b); };
          case '-': return () => num(l()) - num(r()); case '*': return () => num(l()) * num(r()); case '/': return () => num(l()) / num(r()); case '%': return () => num(l()) % num(r());
          case '<': return () => num(l()) < num(r()); case '>': return () => num(l()) > num(r()); case '<=': return () => num(l()) <= num(r()); case '>=': return () => num(l()) >= num(r());
          case '==': return () => { const a = l(), b = r(); return typeof a === 'boolean' || typeof b === 'boolean' ? truthy(a) === truthy(b) : a === b; };
          case '!=': return () => { const a = l(), b = r(); if (isNa(a) || isNa(b)) return false; return typeof a === 'boolean' || typeof b === 'boolean' ? truthy(a) !== truthy(b) : a !== b; };
          case 'and': return () => truthy(l()) && truthy(r()); case 'or': return () => truthy(l()) || truthy(r());
        }
        throw err('Unknown operator ' + n.op, n);
      }
      case 'Id': case 'Member': {
        const name = dotted(n); if (name === null) throw err('This expression is not supported', n);
        const e = scope.find(name); if (e && e.k !== 'f') return reader(e);
        const bv = V[name]; if (bv) return bv.at ? () => bv.at(R.i) : bv.get;
        if (name === 'ta.tr' || name === 'ta.vwap' || name === 'ta.obv') return cCall({ type: 'Call', id: n.id, line: n.line, callee: n, args: [], named: {} }, scope);
        if (CONSTNS.test(name)) return () => name;
        if (n.type === 'Member' && scope.find(rootId(n))) throw err(`Reading ".${n.prop}" from a variable is not supported`, n);
        throw err(`"${name}" is not known. Check the spelling, or it may not be supported in TradeX`, n);
      }
      case 'Index': {
        const idx = cExpr(n.idx, scope), o = n.obj; const nm = dotted(o);
        if (nm !== null) {
          const e = scope.find(nm);
          if (e && e.k === 'g') { needHist[e.slot] = 1; const sl = e.slot; return () => { const k = idx() | 0; if (k === 0) return vals[sl]; const j = R.i - k; if (j < 0) return NaN; const q = hist[sl][j]; return q === undefined ? NaN : q; }; }
          if (!e && V[nm] && V[nm].at) { const at = V[nm].at; return () => { const j = R.i - (idx() | 0); return j < 0 || j >= R.n ? NaN : at(j); }; }
        }
        const g = genericHist(n, cExpr(o, scope)); return () => g(idx() | 0);
      }
      case 'Call': return cCall(n, scope);
    }
    throw err('Unsupported expression', n);
  }
  function cCall(n, scope) {
    let name = dotted(n.callee); if (name === null) throw err('This kind of call is not supported', n);
    let args = n.args.slice(); const root = rootId(n.callee), re = scope.find(root);
    if (re && re.k !== 'f' && n.callee.type === 'Member') { args.unshift(n.callee.obj); name = 'array.' + n.callee.prop; }
    const ue = scope.find(name);
    if (ue && ue.k === 'f') {
      const fs = args.map(a => cExpr(a, scope)), np = ue.params.length, id = n.id; const nm = {};
      for (const k in n.named) { const j = ue.params.findIndex(p => p.name === k); if (j < 0) throw err(`Function "${name}" has no parameter "${k}"`, n); nm[j] = cExpr(n.named[k], scope); }
      return () => {
        const fr = new Array(ue.fn.nl);
        for (let k = 0; k < np; k++) fr[ue.pidx[k]] = k < fs.length ? fs[k]() : nm[k] ? nm[k]() : ue.defs[k] ? ue.defs[k]() : NaN;
        const sf = R.frame, sp = R.path; R.frame = fr; R.path = (Math.imul(sp, 1000003) ^ id) >>> 0 || 1;
        if (++R.depth > 200) throw new PineError('Function calls itself too deeply');
        try { return ue.body(); } finally { R.frame = sf; R.path = sp; R.depth--; }
      };
    }
    if (BLOCKED[name]) throw err(`${BLOCKED[name]} is not supported in TradeX`, n);
    if (NOOP.test(name)) { if (!warnings.some(w => w.includes(name.split('.')[0]))) warnings.push(`Line ${n.line}: ${name}() drawings are skipped. The strategy logic still runs.`); return () => NaN; }
    if (name.startsWith('input')) return cInput(n, name, scope);
    const d = F[name]; if (!d) throw err(`Function "${name}" is not supported in TradeX${name.startsWith('ta.') ? ' yet' : ''}`, n);
    let fs;
    if (d.p[0] === '*') fs = args.map(a => cExpr(a, scope)).concat(Object.values(n.named).map(a => cExpr(a, scope)));
    else {
      fs = new Array(d.p.length).fill(null); args.forEach((a, k) => { if (k < fs.length) fs[k] = cExpr(a, scope); });
      for (const k in n.named) { const j = d.p.indexOf(k === 'src' ? 'source' : k === 'len' ? 'length' : k); if (j >= 0) fs[j] = cExpr(n.named[k], scope); else if (name !== 'plot' && name !== 'plotshape' && name !== 'plotchar' && name !== 'hline' && name !== 'bgcolor' && !name.startsWith('strategy.')) throw err(`"${name}" has no parameter called "${k}"`, n); }
    }
    if (name === 'strategy' || name === 'indicator') {
      const named = {}; for (const k in n.named) named[k] = cExpr(n.named[k], scope); const title = args[0] ? cExpr(args[0], scope) : named.title;
      let done = false; R.resets.push(() => { done = false; });
      return () => { if (done) return; done = true; const a = {}; for (const k in named) a[k] = named[k](); R.meta.kind = name; R.meta.title = title ? title() : ''; R.meta.overlay = name === 'strategy' ? a.overlay === true : a.overlay === true; if (name === 'strategy') R.broker.declare(a); };
    }
    const cnt = fs.length, id = n.id, fn = d.f, st = d.s;
    return () => { const a = new Array(cnt); for (let k = 0; k < cnt; k++) a[k] = fs[k] ? fs[k]() : undefined; return fn(a, st ? getState(id) : null, R, n); };
  }
  function cInput(n, name, scope) {
    const kind = name === 'input' ? 'auto' : name.slice(6); const pn = ['defval', 'title'];
    const named = {}; for (const k in n.named) named[k] = cExpr(n.named[k], scope);
    const dv = n.args[0] ? cExpr(n.args[0], scope) : named.defval, ti = n.args[1] ? cExpr(n.args[1], scope) : named.title; void pn;
    const idx = R.inputCount++; let cached, done = false, isSrc = kind === 'source'; R.resets.push(() => { done = false; });
    const dvName = n.args[0] ? dotted(n.args[0]) : null; if (kind === 'auto' && dvName && SOURCES.includes(dvName)) isSrc = true;
    return () => {
      if (!done) {
        done = true; const title = ti ? String(ti()) : 'Input ' + (idx + 1); const d0 = dv ? dv() : NaN; const ov = R.inputOverrides ? R.inputOverrides[title] : undefined;
        const info = { title, type: isSrc ? 'source' : kind === 'auto' ? (typeof d0 === 'boolean' ? 'bool' : typeof d0 === 'string' ? 'string' : 'float') : kind, def: isSrc ? (dvName || 'close') : d0 };
        for (const k of ['minval', 'maxval', 'step', 'options', 'tooltip', 'group']) if (named[k]) info[k] = named[k]();
        cached = ov === undefined || ov === null || ov === '' ? (isSrc ? null : d0) : (isSrc ? ov : info.type === 'bool' ? (ov === true || ov === 'true') : (info.type === 'int' ? Math.round(+ov) : info.type === 'float' ? +ov : ov));
        info.value = isSrc ? (cached || info.def) : cached; R.inputs.push(info);
      }
      if (isSrc) return cached && V[cached] ? V[cached].at(R.i) : dv();
      return cached;
    };
  }
  const top = new Scope(null); const prog = cBlock(ast.body, top);
  for (let s = 0; s < nslots; s++) { vals[s] = NaN; hist[s] = null; }
  R.nslots = nslots; return prog;
}

/* ---------------- Run ---------------- */
function run(src, data, opt) {
  opt = opt || {}; const n = data.t.length;
  const R = { i: 0, n, t: data.t, o: data.o, h: data.h, l: data.l, c: data.c, v: data.v || new Float64Array(n), tf: opt.tf || 5, symbol: opt.symbol || 'NIFTY',
    vals: [], hist: [], needHist: [], frame: null, path: 0, depth: 0, brk: 0, line: 0, plots: [], shapes: [], hlines: [], bg: [], inputs: [], inputCount: 0,
    inputOverrides: opt.inputs || null, warnings: [], resets: [], meta: { kind: 'indicator', title: '', overlay: false } };
  R.broker = new Broker(R, opt);
  const ast = parse(src); const prog = compile(ast, R);
  const hs = []; for (let s = 0; s < R.nslots; s++) if (R.needHist[s]) { R.hist[s] = new Array(n); hs.push(s); }
  const B = R.broker, vals = R.vals, hist = R.hist, nh = hs.length, prog_ = prog, onProg = opt.onProgress;
  try {
    for (let i = 0; i < n; i++) {
      R.i = i; R.brk = 0; B.onBar(i); prog_(); B.after(i);
      for (let k = 0; k < nh; k++) hist[hs[k]][i] = vals[hs[k]];
      if (onProg && (i & 8191) === 0) onProg(i / n);
    }
  } catch (e) { if (e instanceof PineError) { if (!e.line) e.line = R.line; throw e; } throw new PineError(e.message + ' (while running)', R.line); }
  const trades = B.closed.slice(); const last = n - 1;
  for (const l of B.lots) { const px = R.c[last]; trades.push({ n: trades.length + 1, id: l.id, dir: l.dir, qty: l.qty, ei: l.i, et: R.t[l.i], ep: l.price, xi: last, xt: R.t[last], xp: px, pnl: (px - l.price) * l.dir * l.qty - l.comm, pct: (px - l.price) * l.dir / l.price * 100, pts: (px - l.price) * l.dir, mfe: l.dir > 0 ? l.hi - l.price : l.price - l.lo, mae: l.dir > 0 ? l.price - l.lo : l.hi - l.price, bars: last - l.i, comm: l.comm, reason: 'Still open', ec: l.comment || l.id, open: true }); }
  return { meta: R.meta, isStrategy: R.meta.kind === 'strategy', capital: B.cfg.capital, cfg: B.cfg, trades, equity: B.eq, plots: R.plots, shapes: R.shapes, hlines: R.hlines, bg: R.bg, inputs: R.inputs, warnings: R.warnings };
}
function check(src) { try { parse(src); return null; } catch (e) { return { message: e.message, line: e.line || 0 }; } }
const api = { run, parse, check, PineError, TICK, functions: Object.keys(F) };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Pine = api;
})(typeof self !== 'undefined' ? self : this);
