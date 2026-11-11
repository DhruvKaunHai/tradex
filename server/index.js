/* TradeX server. Plain Node.js (18 or newer), no packages to install.
   - keeps 5 minute candles for NIFTY and BANKNIFTY in the data folder
   - builds 15 and 30 minute candles from them
   - follows the live price and pushes it to open browsers
   - serves the website from the web folder */
'use strict';
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path'), zlib = require('zlib');

const PORT = +process.env.PORT || 8080;
const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const SEED_URL = (process.env.SEED_URL || 'https://tradex-terminal-de4w.onrender.com').replace(/\/$/, '');
const YAHOO = (process.env.YAHOO_BASE || 'https://query1.finance.yahoo.com').replace(/\/$/, '');
const POLL_MS = Math.max(250, +process.env.POLL_MS || 500);
const IDLE_POLL_MS = Math.max(500, +process.env.IDLE_POLL_MS || 60000); // how often to look when the market is shut
const ORIGIN = process.env.ALLOW_ORIGIN || '*';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const IST = 19800, OPEN_MIN = 555, CLOSE_MIN = 930; // 9:15 to 15:30
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const SYMBOLS = {
  NIFTY: { name: 'NIFTY 50', yahoo: '^NSEI', seed: '^NSEI' },
  BANKNIFTY: { name: 'BANK NIFTY', yahoo: '^NSEBANK', seed: '^NSEBANK' }
};
const store = {};
for (const s in SYMBOLS) store[s] = { t: [], o: [], h: [], l: [], c: [], ver: 0, dirty: false, cache: {}, price: null, priceAt: 0, prevClose: null, source: '', lastOk: 0, lastErr: '', fails: 0, seeded: false };

/* ---------- telegram alerts ---------- */
const TELEGRAM_FILE = path.join(DATA, 'telegram.json');
let telegramConfig = {
  token: process.env.TELEGRAM_BOT_TOKEN || '9025942462:AAECO53vcE7HPwkR9KcyAlrudmeP1zvqAJo',
  chatId: process.env.TELEGRAM_CHAT_ID || '1149546127',
  enabled: true,
  notifyEntries: true,
  notifyExits: true,
  notifyMarket: true
};
function loadTelegramConfig() {
  if (fs.existsSync(TELEGRAM_FILE)) {
    try {
      const j = JSON.parse(fs.readFileSync(TELEGRAM_FILE, 'utf8'));
      telegramConfig = Object.assign(telegramConfig, j);
    } catch (e) { log('Telegram config read error:', e.message); }
  }
}
function saveTelegramConfig() {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(TELEGRAM_FILE, JSON.stringify(telegramConfig, null, 2));
  } catch (e) { log('Telegram config save error:', e.message); }
}
loadTelegramConfig();

/* ---------- persistent alert deduplication ---------- */
const ALERTS_FILE = path.join(DATA, 'sent_alerts.json');
let sentAlerts = new Set();
function loadSentAlerts() {
  if (fs.existsSync(ALERTS_FILE)) {
    try {
      const arr = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'));
      if (Array.isArray(arr)) sentAlerts = new Set(arr);
    } catch (e) { log('Sent alerts read error:', e.message); }
  }
}
function saveSentAlerts() {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    const arr = [...sentAlerts].slice(-2500);
    fs.writeFileSync(ALERTS_FILE, JSON.stringify(arr, null, 2));
  } catch (e) { log('Sent alerts save error:', e.message); }
}
loadSentAlerts();

function isAlertSent(key) {
  return !!key && sentAlerts.has(key);
}
function recordSentAlert(key) {
  if (!key) return;
  sentAlerts.add(key);
  saveSentAlerts();
}

function fmtIST(epochSec) {
  if (!epochSec) return '';
  const d = new Date((epochSec + IST) * 1000);
  let h = d.getUTCHours(), m = d.getUTCMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ampm}`;
}

let lastSentHash = '';
let lastSentTime = 0;

async function sendTelegram(text, customToken, customChatId) {
  const token = customToken || telegramConfig.token;
  const chatId = customChatId || telegramConfig.chatId;
  if (!token || !chatId) return { ok: false, error: 'Bot token or Chat ID is missing' };

  // Safety net throttle: never deliver identical text within 45 seconds
  const h = String(text || '').trim();
  const now = Date.now();
  if (h && h === lastSentHash && now - lastSentTime < 45000) {
    return { ok: true, skipped: 'duplicate_throttle' };
  }
  lastSentHash = h;
  lastSentTime = now;

  const postData = JSON.stringify({
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });
  return new Promise(ok => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${encodeURIComponent(token)}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j && j.ok) ok({ ok: true, result: j.result });
          else ok({ ok: false, error: (j && j.description) || 'Telegram error' });
        } catch (e) { ok({ ok: false, error: 'Invalid response from Telegram' }); }
      });
    });
    req.on('error', e => ok({ ok: false, error: e.message }));
    req.setTimeout(8000, () => { req.destroy(); ok({ ok: false, error: 'Telegram request timeout' }); });
    req.write(postData);
    req.end();
  });
}

async function detectTelegramChatId(customToken) {
  const token = customToken || telegramConfig.token;
  if (!token) return { ok: false, error: 'Bot token is missing' };
  return new Promise(ok => {
    https.get(`https://api.telegram.org/bot${encodeURIComponent(token)}/getUpdates`, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (!j.ok) return ok({ ok: false, error: j.description || 'Invalid bot token' });
          const updates = j.result || [];
          for (let i = updates.length - 1; i >= 0; i--) {
            const m = updates[i].message || updates[i].channel_post;
            if (m && m.chat && m.chat.id) {
              const detected = String(m.chat.id);
              telegramConfig.chatId = detected;
              saveTelegramConfig();
              return ok({ ok: true, chatId: detected, name: m.from ? `${m.from.first_name || ''} ${m.from.last_name || ''}`.trim() : '' });
            }
          }
          return ok({ ok: false, error: 'No messages found yet. Please open @TradeX_terminal_bot in Telegram and tap Start!' });
        } catch (e) { ok({ ok: false, error: e.message }); }
      });
    }).on('error', e => ok({ ok: false, error: e.message }));
  });
}

let lastOpenAlert = '', lastCloseAlert = '';
function checkMarketAlerts() {
  if (!telegramConfig.enabled || !telegramConfig.notifyMarket || !telegramConfig.chatId) return;
  const now = Date.now() / 1000;
  const wd = new Date((now + IST) * 1000).getUTCDay();
  if (wd < 1 || wd > 5) return;
  const m = minOfDay(now);
  const dateKey = new Date((now + IST) * 1000).toISOString().slice(0, 10);

  // 1. Market Open Alert at 09:15 AM IST
  if (m >= OPEN_MIN && m < OPEN_MIN + 3 && lastOpenAlert !== dateKey) {
    lastOpenAlert = dateKey;
    const n = store.NIFTY, b = store.BANKNIFTY;
    const msg = [
      '🔔 <b>NSE MARKET IS OPEN (09:15 AM IST)</b>',
      '━━━━━━━━━━━━━━━━━━━━━',
      `📈 <b>NIFTY 50</b>: ${n && n.price ? n.price.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '—'} Pts.`,
      `🏦 <b>BANK NIFTY</b>: ${b && b.price ? b.price.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '—'} Pts.`,
      '',
      '🎯 TradeX is tracking live tick-by-tick. Have a disciplined trading session!'
    ].join('\n');
    sendTelegram(msg).catch(() => {});
  }

  // 2. Market Close Alert at 03:30 PM IST with index points summary
  if (m >= CLOSE_MIN && m < CLOSE_MIN + 4 && lastCloseAlert !== dateKey) {
    lastCloseAlert = dateKey;
    const n = store.NIFTY, b = store.BANKNIFTY;
    const nDiff = n && n.price && n.prevClose ? +(n.price - n.prevClose).toFixed(2) : 0;
    const nPct = n && n.prevClose ? +((nDiff / n.prevClose) * 100).toFixed(2) : 0;
    const bDiff = b && b.price && b.prevClose ? +(b.price - b.prevClose).toFixed(2) : 0;
    const bPct = b && b.prevClose ? +((bDiff / b.prevClose) * 100).toFixed(2) : 0;

    const today = dayOf(now);
    let nLo = Infinity, nHi = -Infinity, bLo = Infinity, bHi = -Infinity;
    if (n) { for (let i = Math.max(0, n.t.length - 80); i < n.t.length; i++) { if (dayOf(n.t[i]) === today) { if (n.l[i] < nLo) nLo = n.l[i]; if (n.h[i] > nHi) nHi = n.h[i]; } } }
    if (b) { for (let i = Math.max(0, b.t.length - 80); i < b.t.length; i++) { if (dayOf(b.t[i]) === today) { if (b.l[i] < bLo) bLo = b.l[i]; if (b.h[i] > bHi) bHi = b.h[i]; } } }

    const msg = [
      '🏁 <b>NSE MARKET CLOSED (03:30 PM IST)</b>',
      '━━━━━━━━━━━━━━━━━━━━━',
      `📈 <b>NIFTY 50</b>: ${n && n.price ? n.price.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '—'} Pts. (${nDiff >= 0 ? '+' : ''}${nDiff.toFixed(2)} Pts. / ${nPct >= 0 ? '+' : ''}${nPct.toFixed(2)}%)`,
      nLo < Infinity ? `   • Day Range: ${nLo.toLocaleString('en-IN', { minimumFractionDigits: 2 })} – ${nHi.toLocaleString('en-IN', { minimumFractionDigits: 2 })} Pts.` : '',
      '',
      `🏦 <b>BANK NIFTY</b>: ${b && b.price ? b.price.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '—'} Pts. (${bDiff >= 0 ? '+' : ''}${bDiff.toFixed(2)} Pts. / ${bPct >= 0 ? '+' : ''}${bPct.toFixed(2)}%)`,
      bLo < Infinity ? `   • Day Range: ${bLo.toLocaleString('en-IN', { minimumFractionDigits: 2 })} – ${bHi.toLocaleString('en-IN', { minimumFractionDigits: 2 })} Pts.` : '',
      '━━━━━━━━━━━━━━━━━━━━━',
      'Trading session ended. Have a great evening!'
    ].filter(Boolean).join('\n');
    sendTelegram(msg).catch(() => {});
  }
}

/* ---------- cloud strategies 24/7 runner ---------- */
const Pine = require(path.join(__dirname, '../web/js/pine.js'));
const CLOUD_STRATS_FILE = path.join(DATA, 'cloud_strats.json');
let cloudStrats = [];

function loadCloudStrats() {
  if (fs.existsSync(CLOUD_STRATS_FILE)) {
    try {
      const j = JSON.parse(fs.readFileSync(CLOUD_STRATS_FILE, 'utf8'));
      if (Array.isArray(j)) {
        const seen = new Map();
        for (const s of j) {
          if (!s || !s.code) continue;
          const k = `${(s.symbol || 'NIFTY').toUpperCase()}_${s.tf || 15}_${(s.code || '').trim()}`;
          seen.set(k, s);
        }
        cloudStrats = [...seen.values()];
      }
    } catch (e) { log('Cloud strats read error:', e.message); }
  }
}
function saveCloudStrats() {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    const clean = cloudStrats.map(s => ({
      id: s.id,
      name: s.name,
      symbol: s.symbol || 'NIFTY',
      tf: s.tf || 15,
      code: s.code,
      inputs: s.inputs || {},
      enabled: s.enabled !== false,
      createdAt: s.createdAt || Date.now()
    }));
    fs.writeFileSync(CLOUD_STRATS_FILE, JSON.stringify(clean, null, 2));
    queueGitHubSync();
  } catch (e) { log('Cloud strats save error:', e.message); }
}

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'DhruvKaunHai/tradex';
let syncGhTimer = null;
async function syncCloudStratsToGitHub() {
  if (!GITHUB_TOKEN || !GITHUB_REPO || !fs.existsSync(CLOUD_STRATS_FILE)) return;
  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/data/cloud_strats.json`;
    const headers = {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'User-Agent': 'TradeX-Server',
      'Accept': 'application/vnd.github.v3+json'
    };
    const curRes = await fetch(url, { headers });
    let sha = null;
    if (curRes.ok) {
      const curData = await curRes.json();
      sha = curData.sha;
    }
    const content = fs.readFileSync(CLOUD_STRATS_FILE, 'utf8');
    const putRes = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: 'Auto-sync cloud strategies',
        content: Buffer.from(content).toString('base64'),
        sha: sha || undefined,
        branch: 'main'
      })
    });
    if (putRes.ok) log('Synced cloud strategies to GitHub repository');
    else log('GitHub sync status:', putRes.status);
  } catch (err) {
    log('GitHub sync error:', err.message);
  }
}
function queueGitHubSync() {
  if (syncGhTimer) clearTimeout(syncGhTimer);
  syncGhTimer = setTimeout(syncCloudStratsToGitHub, 15000);
}
loadCloudStrats();

function runCloudStrats() {
  if (!telegramConfig.enabled || !telegramConfig.chatId || !cloudStrats.length) return;
  for (const cs of cloudStrats) {
    if (cs.enabled === false || !cs.code) continue;
    const sym = (cs.symbol || 'NIFTY').toUpperCase();
    const S = store[sym];
    if (!S || S.t.length < 50) continue;
    const tf = cs.tf || 15;
    const a = aggregate(sym, tf);
    if (!a || a.t.length < 30) continue;

    const count = Math.min(a.t.length, 1200);
    const i0 = a.t.length - count;
    const candleData = {
      t: a.t.slice(i0),
      o: a.o.slice(i0),
      h: a.h.slice(i0),
      l: a.l.slice(i0),
      c: a.c.slice(i0)
    };

    let r;
    try {
      r = Pine.run(cs.code, candleData, { tf, symbol: sym, inputs: cs.inputs || {} });
    } catch (err) {
      cs.lastError = err.message;
      continue;
    }
    cs.lastError = null;
    if (!r || !r.trades) continue;

    if (!cs._knownEntries) cs._knownEntries = new Set();
    if (!cs._knownExits) cs._knownExits = new Set();

    const symName = SYMBOLS[sym] ? SYMBOLS[sym].name : sym;
    const stratName = cs.name || 'Strategy';
    const stratKey = cs.id || stratName;
    const lastBarIdx = candleData.t.length - 1;
    const nowSec = Math.floor(Date.now() / 1000);

    // Initial run: register all existing backtest trades as known (ZERO spam)
    if (!cs._alertInit) {
      cs._alertInit = true;
      for (const t of r.trades) {
        const ek = `entry_${sym}_${tf}_${stratKey}_${t.et}_${t.dir}`;
        cs._knownEntries.add(ek);
        sentAlerts.add(ek);
        if (!t.open && t.reason !== 'Still open') {
          const xk = `exit_${sym}_${tf}_${stratKey}_${t.et}_${t.xt}_${t.dir}`;
          cs._knownExits.add(xk);
          sentAlerts.add(xk);
        }
      }
      saveSentAlerts();
      continue;
    }

    // Live trades: alert only on recent real-time entries/exits within 3x candle timeframe
    for (const t of r.trades) {
      const entryTime = t.et || candleData.t[t.ei] || 0;
      const exitTime = t.xt || candleData.t[t.xi] || 0;
      const isRecentEntry = t.ei >= lastBarIdx - 1 && Math.abs(nowSec - entryTime) < tf * 60 * 3;
      const isRecentExit = !t.open && t.reason !== 'Still open' && t.xi >= lastBarIdx - 1 && Math.abs(nowSec - exitTime) < tf * 60 * 3;

      // 1. Entry alert
      const ek = `entry_${sym}_${tf}_${stratKey}_${t.et}_${t.dir}`;
      if (isRecentEntry && !cs._knownEntries.has(ek) && !isAlertSent(ek)) {
        cs._knownEntries.add(ek);
        recordSentAlert(ek);
        if (telegramConfig.notifyEntries) {
          const action = t.dir > 0 ? 'BUY' : 'SELL';
          const icon = t.dir > 0 ? '🟢' : '🔴';
          const epStr = t.ep.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          const timeStr = fmtIST(entryTime || nowSec);

          const msg = [
            `${icon} <b>NEW TRADE EXECUTED</b>`,
            '━━━━━━━━━━━━━━━━━━━━━',
            `📈 <b>Symbol</b>: ${symName} (${tf}m)`,
            `🎯 <b>Action</b>: ${action} @ ${epStr} Pts.`,
            `🧠 <b>Strategy</b>: ${stratName}`,
            `⏰ <b>Time</b>: ${timeStr} IST`
          ].join('\n');

          sendTelegram(msg).catch(() => {});
        }
      }

      // 2. Exit alert
      const xk = `exit_${sym}_${tf}_${stratKey}_${t.et}_${t.xt}_${t.dir}`;
      if (isRecentExit && !cs._knownExits.has(xk) && !isAlertSent(xk)) {
        cs._knownExits.add(xk);
        recordSentAlert(xk);
        if (telegramConfig.notifyExits) {
          const pts = t.pts != null ? t.pts : (t.xp - t.ep) * t.dir;
          const isWin = pts >= 0;
          const ptsSign = isWin ? '+' : '−';
          const ptsAbs = Math.abs(pts).toFixed(2);
          const xpStr = t.xp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          const timeStr = fmtIST(exitTime || nowSec);
          const resPill = isWin ? `${ptsSign}${ptsAbs} Pts. ✅ WIN` : `${ptsSign}${ptsAbs} Pts. ❌ LOSS`;
          const reason = t.reason && t.reason !== 'Still open' ? ` (${t.reason})` : '';

          const msg = [
            '🏁 <b>TRADE COMPLETED</b>',
            '━━━━━━━━━━━━━━━━━━━━━',
            `📈 <b>Symbol</b>: ${symName} (${tf}m)`,
            `🎯 <b>Action</b>: EXIT ${t.dir > 0 ? 'BUY' : 'SELL'}${reason}`,
            `💰 <b>Exit Price</b>: ${xpStr} Pts.`,
            `📊 <b>Result</b>: ${resPill}`,
            `🧠 <b>Strategy</b>: ${stratName}`,
            `⏰ <b>Time</b>: ${timeStr} IST`
          ].join('\n');

          sendTelegram(msg).catch(() => {});
        }
      }
    }
  }
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const minOfDay = t => Math.floor(((t + IST) % 86400) / 60);
const dayOf = t => Math.floor((t + IST) / 86400);
const validBar = b => Number.isFinite(b[0]) && b[0] % 300 === 0 && minOfDay(b[0]) >= OPEN_MIN && minOfDay(b[0]) < CLOSE_MIN &&
  [b[1], b[2], b[3], b[4]].every(x => Number.isFinite(x) && x > 0) && b[2] >= b[3];

/* ---------- storage ---------- */
function load(sym) {
  const f = path.join(DATA, sym + '_5m.json');
  if (!fs.existsSync(f)) return;
  try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); const S = store[sym]; for (const k of ['t', 'o', 'h', 'l', 'c']) S[k] = j[k] || []; S.ver++; log(sym, 'loaded', S.t.length, 'candles from disk'); }
  catch (e) { log(sym, 'could not read saved data:', e.message); }
}
function save(sym) {
  const S = store[sym]; if (!S.dirty) return; S.dirty = false;
  try { fs.mkdirSync(DATA, { recursive: true }); const f = path.join(DATA, sym + '_5m.json'); fs.writeFileSync(f + '.tmp', JSON.stringify({ t: S.t, o: S.o, h: S.h, l: S.l, c: S.c })); fs.renameSync(f + '.tmp', f); }
  catch (e) { log(sym, 'could not save data:', e.message); }
}
// bars: [[t,o,h,l,c], ...]. overwrite=false keeps what is already stored.
function merge(sym, bars, overwrite) {
  const S = store[sym]; bars = bars.filter(validBar); if (!bars.length) return 0;
  let changed = 0; const n = S.t.length;
  if (n && bars.every(b => b[0] >= S.t[Math.max(0, n - 400)])) { // quick path: only the recent end
    for (const b of bars) {
      let k = S.t.length - 1; while (k >= 0 && S.t[k] > b[0]) k--;
      if (k >= 0 && S.t[k] === b[0]) { if (overwrite && (S.o[k] !== b[1] || S.h[k] !== b[2] || S.l[k] !== b[3] || S.c[k] !== b[4])) { S.o[k] = b[1]; S.h[k] = b[2]; S.l[k] = b[3]; S.c[k] = b[4]; changed++; } }
      else { S.t.splice(k + 1, 0, b[0]); S.o.splice(k + 1, 0, b[1]); S.h.splice(k + 1, 0, b[2]); S.l.splice(k + 1, 0, b[3]); S.c.splice(k + 1, 0, b[4]); changed++; }
    }
  } else {
    const m = new Map(); for (let i = 0; i < n; i++) m.set(S.t[i], [S.t[i], S.o[i], S.h[i], S.l[i], S.c[i]]);
    for (const b of bars) { if (!m.has(b[0])) { m.set(b[0], b); changed++; } else if (overwrite) { m.set(b[0], b); changed++; } }
    const all = [...m.values()].sort((a, b) => a[0] - b[0]);
    S.t = all.map(b => b[0]); S.o = all.map(b => b[1]); S.h = all.map(b => b[2]); S.l = all.map(b => b[3]); S.c = all.map(b => b[4]);
  }
  if (changed) { S.ver++; S.dirty = true; }
  return changed;
}
function aggregate(sym, tf) {
  const S = store[sym]; if (tf === 5) return { t: S.t, o: S.o, h: S.h, l: S.l, c: S.c };
  const out = { t: [], o: [], h: [], l: [], c: [] }; let key = -1, k = -1;
  for (let i = 0; i < S.t.length; i++) {
    const d = dayOf(S.t[i]), slot = Math.floor((minOfDay(S.t[i]) - OPEN_MIN) / tf), kk = d * 100 + slot;
    if (kk !== key) { key = kk; k++; out.t.push(d * 86400 - IST + (OPEN_MIN + slot * tf) * 60); out.o.push(S.o[i]); out.h.push(S.h[i]); out.l.push(S.l[i]); out.c.push(S.c[i]); }
    else { if (S.h[i] > out.h[k]) out.h[k] = S.h[i]; if (S.l[i] < out.l[k]) out.l[k] = S.l[i]; out.c[k] = S.c[i]; }
  }
  return out;
}

/* ---------- outside data ---------- */
async function getJson(url, ms) {
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(), ms || 15000);
  try { const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ac.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
  finally { clearTimeout(timer); }
}
async function seedFromOldSite(sym) {
  const url = `${SEED_URL}/api/candles?symbol=${encodeURIComponent(SYMBOLS[sym].seed)}&timeframe=5m&year=all`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const j = await getJson(url, 120000); const rows = (j && j.candles) || [];
      const added = merge(sym, rows.map(b => [b.time, b.open, b.high, b.low, b.close]), false);
      log(sym, `history site gave ${rows.length} candles, ${added} new`); return rows.length;
    } catch (e) { log(sym, `history site try ${attempt} failed: ${e.message}`); await new Promise(r => setTimeout(r, 15000)); }
  }
  return 0;
}
function yahooBars(j) {
  const r = j && j.chart && j.chart.result && j.chart.result[0]; if (!r) throw new Error((j && j.chart && j.chart.error && j.chart.error.description) || 'empty reply');
  const ts = r.timestamp || [], q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {}, m = new Map();
  for (let i = 0; i < ts.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i]; if (o == null || h == null || l == null || c == null) continue;
    const t = ts[i] - (ts[i] % 300), b = m.get(t);
    if (!b) m.set(t, [t, o, h, l, c]); else { if (h > b[2]) b[2] = h; if (l < b[3]) b[3] = l; b[4] = c; }
  }
  return { bars: [...m.values()].sort((a, b) => a[0] - b[0]).map(b => b.map((x, k) => (k ? +x.toFixed(2) : x))), meta: r.meta || {} };
}
async function yahooHistory(sym) {
  try {
    const { bars } = yahooBars(await getJson(`${YAHOO}/v8/finance/chart/${encodeURIComponent(SYMBOLS[sym].yahoo)}?interval=5m&range=60d`, 30000));
    const today = dayOf(Date.now() / 1000), added = merge(sym, bars.filter(b => dayOf(b[0]) < today), false) + merge(sym, bars.filter(b => dayOf(b[0]) === today), true);
    log(sym, `Yahoo gave ${bars.length} recent candles, ${added} new`); return bars.length;
  } catch (e) { log(sym, 'Yahoo history failed:', e.message); store[sym].lastErr = 'Yahoo: ' + e.message; return 0; }
}

/* ---------- live ---------- */
const clients = new Set();
function broadcast(obj) { const s = `data: ${JSON.stringify(obj)}\n\n`; for (const res of clients) { try { res.write(s); } catch (e) { clients.delete(res); } } }
function applyTick(sym, price, ts) { // builds the running candle from single prices
  const S = store[sym], t = ts - (ts % 300), n = S.t.length;
  if (!validBar([t, price, price, price, price])) return null;
  if (n && S.t[n - 1] === t) { if (price > S.h[n - 1]) S.h[n - 1] = price; if (price < S.l[n - 1]) S.l[n - 1] = price; S.c[n - 1] = price; S.ver++; S.dirty = true; }
  else if (!n || S.t[n - 1] < t) merge(sym, [[t, price, price, price, price]], false);
  const k = S.t.length - 1; return [S.t[k], S.o[k], S.h[k], S.l[k], S.c[k]];
}
async function pollYahoo(sym) {
  const S = store[sym];
  const { bars, meta } = yahooBars(await getJson(`${YAHOO}/v8/finance/chart/${encodeURIComponent(SYMBOLS[sym].yahoo)}?interval=1m&range=1d`, 8000));
  const before = S.ver; merge(sym, bars, true);
  const price = meta.regularMarketPrice, pt = meta.regularMarketTime;
  let last = null;
  if (Number.isFinite(price) && Number.isFinite(pt)) { last = applyTick(sym, +price.toFixed(2), pt); S.price = +price.toFixed(2); S.priceAt = pt; }
  if (Number.isFinite(meta.chartPreviousClose)) S.prevClose = meta.chartPreviousClose; else if (Number.isFinite(meta.previousClose)) S.prevClose = meta.previousClose;
  S.source = 'Yahoo Finance'; S.lastOk = Date.now(); S.fails = 0; S.lastErr = '';
  if (S.ver !== before || S.price !== S._sentPrice || pt !== S._sentPt) {
    S._sentPrice = S.price;
    S._sentPt = pt;
    const k = S.t.length - 1;
    broadcast({ type: 'tick', s: sym, bar: last || [S.t[k], S.o[k], S.h[k], S.l[k], S.c[k]], price: S.price, at: S.priceAt, prev: S.prevClose });
  }
}
async function pollTradingView() {
  const postData = JSON.stringify({
    symbols: { tickers: ['NSE:NIFTY', 'NSE:BANKNIFTY'] },
    columns: ['close', 'open', 'high', 'low']
  });
  return new Promise((ok, fail) => {
    const req = https.request({
      hostname: 'scanner.tradingview.com',
      path: '/india/scan',
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j && Array.isArray(j.data)) {
            const now = Math.floor(Date.now() / 1000);
            for (const item of j.data) {
              const sym = item.s === 'NSE:NIFTY' ? 'NIFTY' : item.s === 'NSE:BANKNIFTY' ? 'BANKNIFTY' : null;
              if (!sym) continue;
              const S = store[sym];
              const price = item.d && item.d[0];
              if (Number.isFinite(price) && price > 0) {
                const p = +price.toFixed(2);
                const last = applyTick(sym, p, now);
                S.price = p;
                S.priceAt = now;
                S.source = 'TradingView';
                S.lastOk = Date.now();
                if (S.price !== S._sentPrice) {
                  S._sentPrice = S.price;
                  const k = S.t.length - 1;
                  broadcast({ type: 'tick', s: sym, bar: last || [S.t[k], S.o[k], S.h[k], S.l[k], S.c[k]], price: S.price, at: S.priceAt, prev: S.prevClose });
                }
              }
            }
          }
          ok();
        } catch (e) { fail(e); }
      });
    });
    req.on('error', fail);
    req.setTimeout(3500, () => { req.destroy(); fail(new Error('timeout')); });
    req.write(postData);
    req.end();
  });
}
async function pollOldSite(sym) {
  const S = store[sym];
  const j = await getJson(`${SEED_URL}/api/live/poll?symbol=${encodeURIComponent(SYMBOLS[sym].seed)}&timeframe=5m`, 8000);
  const q = j && j.quote; if (!q || !Number.isFinite(q.price)) throw new Error('no quote');
  if (q.is_open) { const bar = applyTick(sym, q.price, Math.floor(Date.now() / 1000)); if (bar) broadcast({ type: 'tick', s: sym, bar, price: q.price, at: Math.floor(Date.now() / 1000), prev: S.prevClose }); }
  S.price = q.price; S.source = 'TradeX history site'; S.lastOk = Date.now();
}
function marketOpenNow() { const now = Date.now() / 1000, m = minOfDay(now), wd = new Date((now + IST) * 1000).getUTCDay(); return wd >= 1 && wd <= 5 && m >= OPEN_MIN - 1 && m <= CLOSE_MIN + 2; }
function recentlyTicked() { const now = Date.now() / 1000; return Object.values(store).some(S => now - S.priceAt < 180); }
let pollTimer = null, tvFails = 0, lastYahooPoll = 0;
async function pollLoop() {
  const fast = marketOpenNow() || recentlyTicked();
  const now = Date.now();

  // 1. High-frequency live tick updates directly from TradingView (every 500ms)
  if (fast) {
    try {
      await pollTradingView();
      tvFails = 0;
    } catch (e) {
      tvFails++;
    }
  }

  // 2. Periodic Yahoo Finance sync for full candle data (every 5s or on fallback)
  if (!fast || tvFails > 0 || now - lastYahooPoll >= 5000) {
    lastYahooPoll = now;
    await Promise.all(Object.keys(SYMBOLS).map(async sym => {
      const S = store[sym];
      try { await pollYahoo(sym); }
      catch (e) { S.fails++; S.lastErr = 'Yahoo: ' + e.message; if (S.fails >= 5 && fast) { try { await pollOldSite(sym); } catch (e2) { S.lastErr += ' | history site: ' + e2.message; } } }
    }));
  }
  checkMarketAlerts();
  runCloudStrats();
  pollTimer = setTimeout(pollLoop, fast ? 500 : IDLE_POLL_MS);
}

/* ---------- CSV import ---------- */
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(x => x.trim()); if (!lines.length) return [];
  const split = s => s.split(/[,;\t]/).map(x => x.trim().replace(/^"|"$/g, ''));
  let head = split(lines[0]).map(x => x.toLowerCase()), start = 1;
  if (!head.some(h => /open|close|date|time/.test(h))) { head = head.length >= 6 ? ['date', 'time', 'open', 'high', 'low', 'close'] : ['datetime', 'open', 'high', 'low', 'close']; start = 0; }
  const col = re => head.findIndex(h => re.test(h));
  const iO = col(/^o(pen)?$/), iH = col(/^h(igh)?$/), iL = col(/^l(ow)?$/), iC = col(/^c(lose)?$/), iD = col(/date|timestamp|^datetime$|^dt$/), iT = head.findIndex((h, k) => k !== iD && /^time$/.test(h));
  if (iO < 0 || iH < 0 || iL < 0 || iC < 0 || (iD < 0 && iT < 0)) throw new Error('The file needs date/time, open, high, low and close columns');
  const toTs = (d, tm) => {
    let s = (d || '') + (tm ? ' ' + tm : ''); s = s.trim();
    if (/^\d{9,10}$/.test(s)) return +s; if (/^\d{12,13}$/.test(s)) return Math.floor(+s / 1000);
    let m = /^(\d{4})[-\/]?(\d{2})[-\/]?(\d{2})[ T]+(\d{1,2}):(\d{2})/.exec(s);
    if (m) { if (/[zZ]$/.test(s)) return Math.floor(Date.parse(s) / 1000); return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000 - IST; }
    m = /^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})[ T]+(\d{1,2}):(\d{2})/.exec(s);
    if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]) / 1000 - IST;
    return NaN;
  };
  const m = new Map();
  for (let i = start; i < lines.length; i++) {
    const c = split(lines[i]), ts = toTs(iD >= 0 ? c[iD] : '', iT >= 0 ? c[iT] : ''); if (!Number.isFinite(ts)) continue;
    const o = +c[iO], h = +c[iH], l = +c[iL], cl = +c[iC], t = ts - (ts % 300), b = m.get(t);
    if (!b) m.set(t, [t, o, h, l, cl]); else { if (h > b[2]) b[2] = h; if (l < b[3]) b[3] = l; b[4] = cl; }
  }
  return [...m.values()].sort((a, b) => a[0] - b[0]);
}

/* ---------- web server ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };
function send(req, res, code, body, type, extra) {
  const head = Object.assign({ 'Content-Type': type || 'application/json', 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'content-type,x-admin-key', Vary: 'Accept-Encoding' }, extra || {});
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  if (buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && !head['Content-Encoding']) { buf = zlib.gzipSync(buf, { level: 6 }); head['Content-Encoding'] = 'gzip'; }
  head['Content-Length'] = buf.length; res.writeHead(code, head); res.end(buf);
}
function statusOf(sym) {
  const S = store[sym], n = S.t.length, days = new Set(); for (let i = 0; i < n; i++) days.add(dayOf(S.t[i]));
  return { symbol: sym, name: SYMBOLS[sym].name, candles: n, days: days.size, first: n ? S.t[0] : null, last: n ? S.t[n - 1] : null, price: S.price ?? (n ? S.c[n - 1] : null), priceAt: S.priceAt, prevClose: S.prevClose, source: S.source, lastOk: S.lastOk, error: S.lastErr, seeded: S.seeded };
}
async function readBody(req, limit = 1048576) {
  const chunks = []; let size = 0;
  for await (const ch of req) { size += ch.length; if (size > limit) throw new Error('Body too large'); chunks.push(ch); }
  return Buffer.concat(chunks).toString('utf8');
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x'), p = u.pathname;
    if (req.method === 'OPTIONS') return send(req, res, 204, '');
    if (p === '/api/status') return send(req, res, 200, { ok: true, marketOpen: marketOpenNow(), serverTime: Math.floor(Date.now() / 1000), pollMs: POLL_MS, symbols: Object.keys(SYMBOLS).map(statusOf) }, null, { 'Cache-Control': 'no-store' });
    if (p === '/api/telegram/config') {
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        if (body.token) telegramConfig.token = String(body.token).trim();
        if (body.chatId !== undefined) telegramConfig.chatId = String(body.chatId).trim();
        if (body.enabled !== undefined) telegramConfig.enabled = !!body.enabled;
        if (body.notifyEntries !== undefined) telegramConfig.notifyEntries = !!body.notifyEntries;
        if (body.notifyExits !== undefined) telegramConfig.notifyExits = !!body.notifyExits;
        if (body.notifyMarket !== undefined) telegramConfig.notifyMarket = !!body.notifyMarket;
        saveTelegramConfig();
        return send(req, res, 200, { ok: true, config: { chatId: telegramConfig.chatId, enabled: telegramConfig.enabled, notifyEntries: telegramConfig.notifyEntries, notifyExits: telegramConfig.notifyExits, notifyMarket: telegramConfig.notifyMarket, configured: !!telegramConfig.token } });
      }
      return send(req, res, 200, { ok: true, config: { chatId: telegramConfig.chatId, enabled: telegramConfig.enabled, notifyEntries: telegramConfig.notifyEntries, notifyExits: telegramConfig.notifyExits, notifyMarket: telegramConfig.notifyMarket, configured: !!telegramConfig.token } });
    }
    if (p === '/api/telegram/detect') {
      const r = await detectTelegramChatId();
      return send(req, res, 200, r);
    }
    if (p === '/api/telegram/test' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const targetChat = body.chatId || telegramConfig.chatId;
      const d = new Date(Date.now() + IST * 1000);
      let h = d.getUTCHours(), m = d.getUTCMinutes();
      const ap = h >= 12 ? 'PM' : 'AM';
      h = h % 12; if (!h) h = 12;
      const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ap}`;
      const text = [
        '🔔 <b>TRADEX NOTIFICATION TEST</b>',
        '━━━━━━━━━━━━━━━━━━━━━',
        '✅ Telegram bot connected successfully!',
        '📈 Live alerts for BUY / SELL entries, trade exits, and market open/close summaries are active.',
        `⏰ Time: ${timeStr} IST`
      ].join('\n');
      const r = await sendTelegram(text, null, targetChat);
      return send(req, res, 200, r);
    }
    if (p === '/api/telegram/send' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      if (!telegramConfig.enabled) return send(req, res, 200, { ok: false, skipped: 'disabled' });
      if (body.type === 'entry' && !telegramConfig.notifyEntries) return send(req, res, 200, { ok: false, skipped: 'entries_off' });
      if (body.type === 'exit' && !telegramConfig.notifyExits) return send(req, res, 200, { ok: false, skipped: 'exits_off' });
      if (body.key) {
        if (isAlertSent(body.key)) {
          return send(req, res, 200, { ok: true, skipped: 'duplicate' });
        }
        recordSentAlert(body.key);
      }
      const r = await sendTelegram(body.text);
      return send(req, res, 200, r);
    }
    if (p === '/api/cloud-strats') {
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const list = Array.isArray(body) ? body : Array.isArray(body.strats) ? body.strats : [body];
        const added = [];
        for (const b of list) {
          if (!b.code) continue;
          const chk = Pine.check(b.code);
          if (chk) continue;
          const id = b.id || ('cs_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
          const symUpper = String(b.symbol || 'NIFTY').toUpperCase();
          const tfNum = +b.tf || 15;
          const codeTrimmed = String(b.code || '').trim();
          const idx = cloudStrats.findIndex(s => s.id === id || (s.name === b.name && s.symbol === symUpper && s.tf === tfNum) || ((s.code || '').trim() === codeTrimmed && (s.symbol || 'NIFTY').toUpperCase() === symUpper && (+s.tf || 15) === tfNum));
          const item = {
            id: idx >= 0 ? cloudStrats[idx].id : id,
            name: String(b.name || 'Cloud Strategy').trim(),
            symbol: symUpper,
            tf: tfNum,
            code: String(b.code),
            inputs: b.inputs || {},
            enabled: b.enabled !== false,
            createdAt: b.createdAt || Date.now()
          };
          if (idx >= 0) {
            item._knownEntries = cloudStrats[idx]._knownEntries;
            item._knownExits = cloudStrats[idx]._knownExits;
            item._alertInit = cloudStrats[idx]._alertInit;
            cloudStrats[idx] = item;
          } else {
            cloudStrats.push(item);
          }
          added.push(item);
        }
        saveCloudStrats();
        runCloudStrats();
        if (list.length === 1 && !added.length) {
          return send(req, res, 400, { error: 'Invalid strategy code' });
        }
        return send(req, res, 200, { ok: true, count: added.length, strat: added[0], strats: added });
      }
      return send(req, res, 200, { ok: true, strats: cloudStrats.map(s => ({ id: s.id, name: s.name, symbol: s.symbol, tf: s.tf, inputs: s.inputs, enabled: s.enabled !== false, createdAt: s.createdAt, lastError: s.lastError })) });
    }
    if (p === '/api/cloud-strats/delete' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
      cloudStrats = cloudStrats.filter(s => !ids.includes(s.id));
      saveCloudStrats();
      return send(req, res, 200, { ok: true, deleted: ids.length });
    }
    if (p === '/api/cloud-strats/toggle' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const s = cloudStrats.find(x => x.id === body.id);
      if (s) {
        s.enabled = body.enabled !== undefined ? !!body.enabled : !s.enabled;
        saveCloudStrats();
      }
      return send(req, res, 200, { ok: true, enabled: s ? s.enabled : false });
    }
    if (p === '/api/candles') {
      const sym = (u.searchParams.get('symbol') || 'NIFTY').toUpperCase(), tf = +u.searchParams.get('tf') || 5;
      if (!store[sym] || ![5, 15, 30].includes(tf)) return send(req, res, 400, { error: 'Unknown symbol or timeframe' });
      const S = store[sym]; let c = S.cache[tf];
      if (!c || c.ver !== S.ver) { const a = aggregate(sym, tf); c = S.cache[tf] = { ver: S.ver, gz: zlib.gzipSync(JSON.stringify({ symbol: sym, tf, t: a.t, o: a.o, h: a.h, l: a.l, c: a.c }), { level: 6 }) }; }
      if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) return send(req, res, 200, c.gz, 'application/json', { 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store' });
      return send(req, res, 200, zlib.gunzipSync(c.gz), 'application/json', { 'Cache-Control': 'no-store', 'Content-Encoding': 'identity' });
    }
    if (p === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'Access-Control-Allow-Origin': ORIGIN, 'X-Accel-Buffering': 'no' });
      res.write(`retry: 2000\ndata: ${JSON.stringify({ type: 'hello', marketOpen: marketOpenNow(), symbols: Object.keys(SYMBOLS).map(statusOf) })}\n\n`);
      clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    if (p === '/api/import' && req.method === 'POST') {
      if (ADMIN_KEY && req.headers['x-admin-key'] !== ADMIN_KEY) return send(req, res, 401, { error: 'Wrong admin key' });
      const sym = (u.searchParams.get('symbol') || '').toUpperCase(); if (!store[sym]) return send(req, res, 400, { error: 'Unknown symbol' });
      const chunks = []; let size = 0;
      for await (const ch of req) { size += ch.length; if (size > 80 * 1024 * 1024) return send(req, res, 413, { error: 'File is larger than 80 MB' }); chunks.push(ch); }
      let rows; try { rows = parseCsv(Buffer.concat(chunks).toString('utf8')); } catch (e) { return send(req, res, 400, { error: e.message }); }
      const good = rows.filter(validBar), added = merge(sym, good, u.searchParams.get('overwrite') === '1'); save(sym);
      return send(req, res, 200, { ok: true, rows: rows.length, inSession: good.length, added, total: store[sym].t.length });
    }
    if (p.startsWith('/api/')) return send(req, res, 404, { error: 'Not found' });
    let rel = p === '/' ? '/index.html' : p === '/app' ? '/app.html' : p; rel = path.normalize(rel).replace(/^([/\\])+/, '');
    const file = path.join(WEB, rel);
    if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(req, res, 404, 'Not found', 'text/plain');
    return send(req, res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream', { 'Cache-Control': 'no-cache' });
  } catch (e) { log('request failed:', e.message); try { send(req, res, 500, { error: 'Server error' }); } catch (_) { /* reply already started */ } }
});

async function boot() {
  for (const sym in SYMBOLS) load(sym);
  server.listen(PORT, () => log(`TradeX is running. Open http://localhost:${PORT}`));
  for (const sym in SYMBOLS) {
    const S = store[sym];
    if (S.t.length < 1000) await seedFromOldSite(sym);
    await yahooHistory(sym); S.seeded = true; save(sym);
    broadcast({ type: 'reload', s: sym });
  }
  pollLoop();
  setInterval(() => { for (const sym in SYMBOLS) save(sym); }, 60000);
  setInterval(() => broadcast({ type: 'ping', marketOpen: marketOpenNow() }), 15000);
  setInterval(() => { for (const sym in SYMBOLS) yahooHistory(sym); }, 6 * 3600 * 1000);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { for (const sym in SYMBOLS) save(sym); process.exit(0); });
boot();
