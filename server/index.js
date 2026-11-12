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
const serverBootSec = Math.floor(Date.now() / 1000);
const TELEGRAM_FILE = path.join(DATA, 'telegram.json');
const FRIENDS_FILE = path.join(DATA, 'friends.json');
const OWNER_CHAT_IDS = (process.env.TELEGRAM_CHAT_ID || '1149546127')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

let telegramConfig = {
  token: process.env.TELEGRAM_BOT_TOKEN || '',
  extraChatIds: [],
  disabledStrategyOwners: [],
  enabled: true,
  notifyEntries: true,
  notifyExits: true,
  notifyMarket: true
};
let friendsList = []; // [{ id: string, name: string, welcomed: boolean, strategyAlerts: boolean }]
const recentFriendSenders = []; // [{ chatId, name, username, ts }]
const welcomeInFlight = new Map(); // chatId -> Promise

function escapeTgHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function isValidChatId(id) {
  const clean = String(id || '').trim();
  return /^-?\d+$/.test(clean) ? clean : '';
}
function normalizeFriendEntry(raw) {
  const id = isValidChatId(raw && typeof raw === 'object' ? raw.id : raw);
  if (!id || OWNER_CHAT_IDS.includes(id)) return null;
  return {
    id,
    name: raw && typeof raw === 'object' ? String(raw.name || '').trim() : '',
    welcomed: !!(raw && typeof raw === 'object' && raw.welcomed),
    strategyAlerts: !!(raw && typeof raw === 'object' && raw.strategyAlerts)
  };
}
function loadTelegramConfig() {
  if (fs.existsSync(TELEGRAM_FILE)) {
    try {
      const j = JSON.parse(fs.readFileSync(TELEGRAM_FILE, 'utf8'));
      if (j.token) telegramConfig.token = j.token;
      if (Array.isArray(j.extraChatIds)) telegramConfig.extraChatIds = j.extraChatIds;
      if (Array.isArray(j.disabledStrategyOwners)) {
        telegramConfig.disabledStrategyOwners = j.disabledStrategyOwners.map(s => String(s || '').trim()).filter(Boolean);
      }
      if (j.enabled !== undefined) telegramConfig.enabled = !!j.enabled;
      if (j.notifyEntries !== undefined) telegramConfig.notifyEntries = !!j.notifyEntries;
      if (j.notifyExits !== undefined) telegramConfig.notifyExits = !!j.notifyExits;
      if (j.notifyMarket !== undefined) telegramConfig.notifyMarket = !!j.notifyMarket;
    } catch (e) { log('Telegram config read error:', e.message); }
  }
}
function loadFriends() {
  const byId = new Map();
  if (fs.existsSync(FRIENDS_FILE)) {
    try {
      const arr = JSON.parse(fs.readFileSync(FRIENDS_FILE, 'utf8'));
      if (Array.isArray(arr)) {
        for (const item of arr) {
          const norm = normalizeFriendEntry(item);
          if (norm) byId.set(norm.id, norm);
        }
      }
    } catch (e) { log('Friends read error:', e.message); }
  }
  const envFriends = String(process.env.TELEGRAM_FRIEND_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const rawId of [...envFriends, ...(telegramConfig.extraChatIds || [])]) {
    const norm = normalizeFriendEntry(rawId);
    if (norm && !byId.has(norm.id)) byId.set(norm.id, norm);
  }
  friendsList = [...byId.values()];
  telegramConfig.extraChatIds = friendsList.map(f => f.id);
}
function saveTelegramConfig() {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    telegramConfig.extraChatIds = friendsList.map(f => f.id);
    fs.writeFileSync(TELEGRAM_FILE, JSON.stringify(telegramConfig, null, 2));
  } catch (e) { log('Telegram config save error:', e.message); }
}
function saveFriends(syncGitHub = true) {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    const deduped = [];
    const seen = new Set();
    for (const item of friendsList) {
      const norm = normalizeFriendEntry(item);
      if (norm && !seen.has(norm.id)) {
        seen.add(norm.id);
        deduped.push(norm);
      }
    }
    friendsList = deduped;
    telegramConfig.extraChatIds = friendsList.map(f => f.id);
    fs.writeFileSync(FRIENDS_FILE, JSON.stringify(friendsList, null, 2));
    if (fs.existsSync(TELEGRAM_FILE)) saveTelegramConfig();
    if (syncGitHub) queueGitHubSync('friends');
  } catch (e) { log('Friends save error:', e.message); }
}
function getFriend(chatId) {
  const clean = isValidChatId(chatId);
  return clean ? (friendsList.find(f => f.id === clean) || null) : null;
}
function upsertFriend(chatId, opts = {}) {
  const clean = isValidChatId(chatId);
  if (!clean || OWNER_CHAT_IDS.includes(clean)) return { friend: null, added: false };
  const existing = friendsList.find(f => f.id === clean);
  if (existing) {
    let changed = false;
    if (opts.name && !existing.name) { existing.name = String(opts.name).trim(); changed = true; }
    if (opts.welcomed !== undefined && existing.welcomed !== !!opts.welcomed) { existing.welcomed = !!opts.welcomed; changed = true; }
    if (changed) saveFriends(true);
    return { friend: existing, added: false };
  }
  const entry = {
    id: clean,
    name: String(opts.name || '').trim(),
    welcomed: !!opts.welcomed,
    strategyAlerts: !!opts.strategyAlerts
  };
  friendsList.push(entry);
  saveFriends(true);
  return { friend: entry, added: true };
}
function isStrategyAlertsEnabled(chatId) {
  const clean = isValidChatId(chatId);
  if (!clean) return false;
  if (OWNER_CHAT_IDS.includes(clean)) {
    const offList = Array.isArray(telegramConfig.disabledStrategyOwners) ? telegramConfig.disabledStrategyOwners : [];
    return !offList.includes(clean);
  }
  const f = getFriend(clean);
  return !!(f && f.strategyAlerts);
}
function setStrategyAlertsForUser(chatId, enabled) {
  const clean = isValidChatId(chatId);
  const on = !!enabled;
  if (!clean) return false;
  if (OWNER_CHAT_IDS.includes(clean)) {
    const off = new Set(Array.isArray(telegramConfig.disabledStrategyOwners) ? telegramConfig.disabledStrategyOwners : []);
    if (on) off.delete(clean);
    else off.add(clean);
    telegramConfig.disabledStrategyOwners = [...off];
    saveTelegramConfig();
    return on;
  }
  const f = getFriend(clean);
  if (!f) return false;
  if (!!f.strategyAlerts !== on) {
    f.strategyAlerts = on;
    saveFriends(true);
  }
  return !!f.strategyAlerts;
}
function removeFriendById(chatId) {
  const clean = isValidChatId(chatId);
  if (!clean) return false;
  const before = friendsList.length;
  friendsList = friendsList.filter(f => f.id !== clean);
  if (friendsList.length !== before) {
    saveFriends(true);
    return true;
  }
  return false;
}
function extractTgSenderInfo(msg) {
  if (!msg || !msg.chat || !msg.chat.id) return null;
  const chatId = String(msg.chat.id);
  const from = msg.from || {};
  const chat = msg.chat || {};
  const fullName = `${from.first_name || ''} ${from.last_name || ''}`.trim()
    || `${chat.first_name || ''} ${chat.last_name || ''}`.trim()
    || String(chat.title || '').trim();
  const username = String(from.username || chat.username || '').trim();
  return { chatId, name: fullName, username, ts: Date.now() };
}
function recordFriendSender(msg) {
  const info = extractTgSenderInfo(msg);
  if (!info || OWNER_CHAT_IDS.includes(info.chatId)) return null;
  const idx = recentFriendSenders.findIndex(x => x.chatId === info.chatId);
  if (idx >= 0) recentFriendSenders.splice(idx, 1);
  recentFriendSenders.unshift(info);
  if (recentFriendSenders.length > 25) recentFriendSenders.length = 25;
  const existing = getFriend(info.chatId);
  if (existing && info.name && !existing.name) {
    existing.name = info.name;
    saveFriends(true);
  }
  return info;
}
function getRecipientChatIds() {
  const ids = new Set(OWNER_CHAT_IDS);
  for (const f of friendsList) {
    if (f && f.id && !OWNER_CHAT_IDS.includes(f.id)) ids.add(f.id);
  }
  return [...ids];
}
loadTelegramConfig();
loadFriends();

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

function fmtAlertTime(sec, refSec) {
  if (!sec) return '';
  const d = new Date((sec + IST) * 1000);
  const dRef = new Date(((refSec || sec) + IST) * 1000);
  const isSameDay = d.getUTCFullYear() === dRef.getUTCFullYear() &&
                    d.getUTCMonth() === dRef.getUTCMonth() &&
                    d.getUTCDate() === dRef.getUTCDate();
  let h = d.getUTCHours(), m = d.getUTCMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ampm}`;
  if (isSameDay) return timeStr;
  const day = String(d.getUTCDate()).padStart(2, '0');
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()];
  return `${day} ${mon}, ${timeStr}`;
}

let lastSentHash = '';
let lastSentTime = 0;

function sendTelegramSingle(token, chatId, text) {
  const cleanId = String(chatId || '').trim();
  const postData = JSON.stringify({
    chat_id: cleanId,
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
          if (j && j.ok) ok({ ok: true, chatId: cleanId, result: j.result });
          else ok({ ok: false, chatId: cleanId, error: (j && j.description) || 'Telegram error' });
        } catch (e) { ok({ ok: false, chatId: cleanId, error: 'Invalid response from Telegram' }); }
      });
    });
    req.on('error', e => ok({ ok: false, chatId: cleanId, error: e.message }));
    req.setTimeout(8000, () => { req.destroy(); ok({ ok: false, chatId: cleanId, error: 'Telegram request timeout' }); });
    req.write(postData);
    req.end();
  });
}

function isTelegramUnreachableError(err) {
  return /chat not found|bot was blocked|user is deactivated|initiate conversation|forbidden/i.test(String(err || ''));
}

function buildFriendWelcomeMessage() {
  return [
    '👋 <b>Welcome to TradeX!</b>',
    '━━━━━━━━━━━━━━━━━━━━━',
    'Built by <b>Dhruv</b>, <b>TradeX</b> is a real-time algorithmic trading terminal &amp; cloud alert engine for Indian markets (<b>NIFTY 50</b> &amp; <b>BANK NIFTY</b>).',
    '',
    '<b>What TradeX does:</b>',
    '• 📡 Streams live index market data &amp; runs Pine Script strategies 24/7 on the cloud',
    '• 🔔 Delivers Market Open (09:15 IST) &amp; Close (15:30 IST) summaries automatically',
    '• ⚡ Sends real-time BUY / SELL entries &amp; exit PnL alerts (opt-in per chat)',
    '',
    '<b>📋 Bot Commands:</b>',
    '• /strategies — Turn live strategy entry/exit alerts <b>ON / OFF</b> (for your chat only)',
    '   (Or use /strategies_on or /strategies_off directly)',
    '• /status or /market — Request live NIFTY 50 &amp; BANK NIFTY market data &amp; session status',
    '• /info — View currently open trade positions &amp; active strategies',
    '• /help — Show all commands and your current alert setting',
    '━━━━━━━━━━━━━━━━━━━━━',
    '🔕 <b>Live Strategy Alerts: OFF</b> for your Telegram by default.',
    '👉 Tap /strategies_on (or /strategies) anytime to start receiving live daily strategy alerts!',
    '🔔 Market Open/Close summaries and /status market data are already active.'
  ].join('\n');
}

async function sendFriendWelcomeIfNeeded(chatId, customToken, msgContext) {
  const clean = isValidChatId(chatId);
  if (!clean || OWNER_CHAT_IDS.includes(clean)) return { ok: true, sent: false, skipped: 'owner' };
  const token = customToken || telegramConfig.token;
  if (!token) return { ok: false, sent: false, chatId: clean, error: 'Bot token is missing' };
  const friend = getFriend(clean);
  if (!friend) return { ok: false, sent: false, chatId: clean, error: 'Friend not registered' };
  if (friend.welcomed) return { ok: true, sent: false, chatId: clean, alreadyWelcomed: true, name: friend.name };

  if (welcomeInFlight.has(clean)) return welcomeInFlight.get(clean);
  const p = (async () => {
    try {
      const r = await sendTelegramSingle(token, clean, buildFriendWelcomeMessage());
      if (r.ok) {
        const chatMeta = (r.result && r.result.chat) || {};
        const learnedName = `${chatMeta.first_name || ''} ${chatMeta.last_name || ''}`.trim()
          || String(chatMeta.title || '').trim()
          || (msgContext && extractTgSenderInfo(msgContext) ? extractTgSenderInfo(msgContext).name : '');
        friend.welcomed = true;
        if (learnedName && !friend.name) friend.name = learnedName;
        saveFriends(true);
        return { ok: true, sent: true, chatId: clean, name: friend.name };
      }
      return {
        ok: false,
        sent: false,
        chatId: clean,
        needsStart: isTelegramUnreachableError(r.error),
        error: r.error || 'Telegram error'
      };
    } finally {
      welcomeInFlight.delete(clean);
    }
  })();
  welcomeInFlight.set(clean, p);
  return p;
}

async function sendTelegram(text, customToken, customChatId, skipThrottle = false, opts = {}) {
  const token = customToken || telegramConfig.token;
  const category = (opts && opts.category) || 'general';
  let targets = customChatId
    ? String(customChatId).split(',').map(s => s.trim()).filter(s => /^-?\d+$/.test(s))
    : getRecipientChatIds();
  if (!token) return { ok: false, error: 'Bot token is missing' };
  if (!customChatId && category === 'strategy') {
    targets = targets.filter(cid => isStrategyAlertsEnabled(cid));
    if (!targets.length) return { ok: true, skipped: 'no_strategy_subscribers' };
  }
  if (!targets.length) return { ok: false, error: 'Chat ID is missing' };

  // Safety net throttle: never deliver identical alert text within 45 seconds
  const h = String(text || '').trim();
  const now = Date.now();
  if (!skipThrottle && h && h === lastSentHash && now - lastSentTime < 45000) {
    return { ok: true, skipped: 'duplicate_throttle' };
  }
  if (!skipThrottle) {
    lastSentHash = h;
    lastSentTime = now;
  }

  const results = await Promise.all(targets.map(async cid => {
    const friend = getFriend(cid);
    if (friend && !friend.welcomed) {
      const wr = await sendFriendWelcomeIfNeeded(cid, token);
      if (!wr.ok) {
        return { ok: false, chatId: cid, needsStart: !!wr.needsStart, error: wr.error || 'Failed to send welcome message' };
      }
    }
    return sendTelegramSingle(token, cid, text);
  }));
  const firstOk = results.find(r => r.ok);
  if (firstOk) return { ok: true, result: firstOk.result, results };
  return results[0] || { ok: false, error: 'Failed to send', results };
}

async function detectTelegramChatId(customToken) {
  const token = customToken || telegramConfig.token;
  if (!token) return { ok: false, error: 'Bot token is missing' };

  if (!customToken) {
    if (tgPollingActive) {
      const deadline = Date.now() + 3500;
      while (tgPollingActive && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 120));
      }
    }
    if (!tgPollingActive) {
      await pollTelegramUpdates(0, true);
    }
    const freshSender = recentFriendSenders.find(s => !getFriend(s.chatId));
    if (freshSender) {
      return {
        ok: true,
        chatId: freshSender.chatId,
        name: freshSender.name,
        username: freshSender.username,
        alreadyAdded: false
      };
    }
    if (recentFriendSenders.length) {
      const latest = recentFriendSenders[0];
      return {
        ok: true,
        chatId: latest.chatId,
        name: latest.name,
        username: latest.username,
        alreadyAdded: !!getFriend(latest.chatId)
      };
    }
    return { ok: false, error: 'No friend messages found yet. Ask your friend to open @TradeX_terminal_bot in Telegram and tap Start!' };
  }

  return new Promise(ok => {
    const req = https.get(`https://api.telegram.org/bot${encodeURIComponent(token)}/getUpdates`, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (!j.ok) return ok({ ok: false, error: j.description || 'Invalid bot token' });
          const updates = j.result || [];
          for (let i = updates.length - 1; i >= 0; i--) {
            const m = updates[i].message || updates[i].channel_post;
            if (m && m.chat && m.chat.id) {
              const info = extractTgSenderInfo(m);
              if (!info || OWNER_CHAT_IDS.includes(info.chatId)) continue;
              return ok({
                ok: true,
                chatId: info.chatId,
                name: info.name,
                username: info.username,
                alreadyAdded: !!getFriend(info.chatId)
              });
            }
          }
          return ok({ ok: false, error: 'No friend messages found yet. Ask your friend to open @TradeX_terminal_bot in Telegram and tap Start!' });
        } catch (e) { ok({ ok: false, error: e.message }); }
      });
    });
    req.on('error', e => ok({ ok: false, error: e.message }));
    req.setTimeout(8000, () => { req.destroy(); ok({ ok: false, error: 'Telegram request timeout' }); });
  });
}

function getOpenCloudTrades() {
  const openTrades = [];
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
    const candleData = { t: a.t.slice(i0), o: a.o.slice(i0), h: a.h.slice(i0), l: a.l.slice(i0), c: a.c.slice(i0) };
    try {
      const r = Pine.run(cs.code, candleData, { tf, symbol: sym, inputs: cs.inputs || {} });
      if (r && r.trades) {
        for (const t of r.trades) {
          if (t.open || t.reason === 'Still open') {
            openTrades.push({
              stratId: cs.id,
              stratName: cs.name || cs.id,
              symbol: sym,
              symName: SYMBOLS[sym] ? SYMBOLS[sym].name : sym,
              tf,
              trade: t
            });
          }
        }
      }
    } catch (_) {}
  }
  return openTrades;
}

let lastOpenAlert = '', lastCloseAlert = '';
function getDailyMarketSummary(sym, today) {
  const S = store[sym];
  if (!S) return null;
  let barOpen = null, barHigh = -Infinity, barLow = Infinity, barClose = null;
  for (let i = Math.max(0, S.t.length - 120); i < S.t.length; i++) {
    if (dayOf(S.t[i]) === today) {
      if (barOpen === null) barOpen = S.o[i];
      if (S.h[i] > barHigh) barHigh = S.h[i];
      if (S.l[i] < barLow) barLow = S.l[i];
      barClose = S.c[i];
    }
  }
  const hasTodayMeta = S.dayKey === today;
  const open = hasTodayMeta && Number.isFinite(S.dayOpen) ? S.dayOpen : barOpen;
  const close = Number.isFinite(S.price) && S.price > 0 ? S.price : barClose;
  let high = hasTodayMeta && Number.isFinite(S.dayHigh) ? S.dayHigh : (barHigh > -Infinity ? barHigh : null);
  let low = hasTodayMeta && Number.isFinite(S.dayLow) ? S.dayLow : (barLow < Infinity ? barLow : null);
  if (high != null && barHigh > -Infinity) high = Math.max(high, barHigh);
  if (low != null && barLow < Infinity) low = Math.min(low, barLow);
  if (high != null && Number.isFinite(close)) high = Math.max(high, close);
  if (low != null && Number.isFinite(close)) low = Math.min(low, close);
  const prevClose = Number.isFinite(S.prevClose) ? S.prevClose : null;
  const diff = (close != null && prevClose) ? +(close - prevClose).toFixed(2) : 0;
  const pct = prevClose ? +((diff / prevClose) * 100).toFixed(2) : 0;
  return { open, close, high, low, prevClose, diff, pct };
}

async function sendMarketCloseAlert(dateKey, today) {
  try {
    await Promise.all(Object.keys(SYMBOLS).map(sym => pollYahoo(sym).catch(() => {})));
    await pollTradingView().catch(() => {});
  } catch (_) {}

  const formatIdxBlock = (icon, title, sym) => {
    const s = getDailyMarketSummary(sym, today);
    const f = v => (v != null && Number.isFinite(v)) ? v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
    const diffStr = s && s.prevClose ? ` (${s.diff >= 0 ? '+' : ''}${s.diff.toFixed(2)} / ${s.pct >= 0 ? '+' : ''}${s.pct.toFixed(2)}%)` : '';
    const rangeStr = (s && s.low != null && s.high != null) ? `${f(s.low)} – ${f(s.high)} Pts.` : '—';
    return [
      `${icon} <b>${title}</b>`,
      `   • Open: ${f(s && s.open)} Pts.  |  Close: <b>${f(s && s.close)} Pts.</b>${diffStr}`,
      `   • Day Range: ${rangeStr}`
    ].join('\n');
  };

  const openTrades = getOpenCloudTrades();
  let posSection = '⚡ <b>Open Overnight Positions</b>: 0 active\nAll cloud strategies closed flat before market close.';
  if (openTrades.length) {
    posSection = `⚡ <b>Open Overnight Positions (${openTrades.length})</b>:\n` + openTrades.map(ot => {
      const dir = ot.trade.dir > 0 ? 'BUY' : 'SELL';
      const ep = ot.trade.ep.toLocaleString('en-IN', { minimumFractionDigits: 2 });
      const pts = ot.trade.pts != null ? ot.trade.pts : 0;
      const ptsStr = `${pts >= 0 ? '+' : '−'}${Math.abs(pts).toFixed(2)} pts`;
      return `   • <b>${ot.symName} (${ot.tf}m)</b>: ${dir} @ ${ep} (${ptsStr}) [${ot.stratName}]`;
    }).join('\n');
  }

  const msg = [
    '🏁 <b>NSE MARKET CLOSED (03:31 PM IST)</b>',
    '━━━━━━━━━━━━━━━━━━━━━',
    formatIdxBlock('📈', 'NIFTY 50', 'NIFTY'),
    '',
    formatIdxBlock('🏦', 'BANK NIFTY', 'BANKNIFTY'),
    '━━━━━━━━━━━━━━━━━━━━━',
    posSection,
    '━━━━━━━━━━━━━━━━━━━━━',
    'Trading session ended. Have a great evening!'
  ].join('\n');
  sendTelegram(msg, null, null, false, { category: 'market' }).catch(() => {});
}

function checkMarketAlerts() {
  if (!telegramConfig.enabled || !telegramConfig.notifyMarket || !getRecipientChatIds().length) return;
  const now = Date.now() / 1000;
  const wd = new Date((now + IST) * 1000).getUTCDay();
  if (wd < 1 || wd > 5) return;
  const m = minOfDay(now);
  const secIST = Math.floor((now + IST) % 86400);
  const dateKey = new Date((now + IST) * 1000).toISOString().slice(0, 10);

  // 1. Market Open Alert at 09:15 AM IST
  const openKey = `market_open_${dateKey}`;
  if (m >= OPEN_MIN && m < OPEN_MIN + 4 && lastOpenAlert !== dateKey && !isAlertSent(openKey)) {
    lastOpenAlert = dateKey;
    recordSentAlert(openKey);
    const n = store.NIFTY, b = store.BANKNIFTY;
    const openTrades = getOpenCloudTrades();
    let posLine = '⚡ <b>Open Positions</b>: 0 active (All flat)';
    if (openTrades.length) {
      posLine = `⚡ <b>Open Positions (${openTrades.length})</b>:\n` + openTrades.map(ot => {
        const dir = ot.trade.dir > 0 ? 'BUY' : 'SELL';
        const ep = ot.trade.ep.toLocaleString('en-IN', { minimumFractionDigits: 2 });
        return `   • <b>${ot.symName} (${ot.tf}m)</b>: ${dir} @ ${ep} [${ot.stratName}]`;
      }).join('\n');
    }

    const msg = [
      '🔔 <b>NSE MARKET IS OPEN (09:15 AM IST)</b>',
      '━━━━━━━━━━━━━━━━━━━━━',
      `📈 <b>NIFTY 50</b>: ${n && n.price ? n.price.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '—'} Pts.`,
      `🏦 <b>BANK NIFTY</b>: ${b && b.price ? b.price.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '—'} Pts.`,
      posLine,
      '',
      '🎯 TradeX is tracking live tick-by-tick. Have a disciplined trading session!'
    ].join('\n');
    sendTelegram(msg, null, null, false, { category: 'market' }).catch(() => {});
  }

  // 2. Market Close Alert at 03:31 PM IST (after official NSE closing settlement)
  const closeKey = `market_close_${dateKey}`;
  if (secIST >= CLOSE_MIN * 60 + 65 && secIST < (CLOSE_MIN + 10) * 60 && lastCloseAlert !== dateKey && !isAlertSent(closeKey)) {
    lastCloseAlert = dateKey;
    recordSentAlert(closeKey);
    sendMarketCloseAlert(dateKey, dayOf(now)).catch(err => log('Market close alert error:', err.message));
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
    queueGitHubSync('strats');
  } catch (e) { log('Cloud strats save error:', e.message); }
}

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'DhruvKaunHai/tradex';
const GITHUB_SYNC_TARGETS = {
  strats: { file: CLOUD_STRATS_FILE, repoPath: 'data/cloud_strats.json', message: 'Auto-sync cloud strategies' },
  friends: { file: FRIENDS_FILE, repoPath: 'data/friends.json', message: 'Auto-sync Telegram friends' }
};
const syncGhTimers = {};
async function syncFileToGitHub(filePath, repoPath, commitMsg) {
  if (!GITHUB_TOKEN || !GITHUB_REPO || !fs.existsSync(filePath)) return;
  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${repoPath}`;
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
    const content = fs.readFileSync(filePath, 'utf8');
    const putRes = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: commitMsg,
        content: Buffer.from(content).toString('base64'),
        sha: sha || undefined,
        branch: 'main'
      })
    });
    if (putRes.ok) log(`Synced ${repoPath} to GitHub repository`);
    else log(`GitHub sync status (${repoPath}):`, putRes.status);
  } catch (err) {
    log(`GitHub sync error (${repoPath}):`, err.message);
  }
}
function queueGitHubSync(kind = 'strats') {
  const target = GITHUB_SYNC_TARGETS[kind] || GITHUB_SYNC_TARGETS.strats;
  if (syncGhTimers[kind]) clearTimeout(syncGhTimers[kind]);
  syncGhTimers[kind] = setTimeout(() => {
    syncFileToGitHub(target.file, target.repoPath, target.message);
  }, 15000);
}
loadCloudStrats();

function runCloudStrats() {
  if (!telegramConfig.enabled || !getRecipientChatIds().length || !cloudStrats.length) return;
  for (const cs of cloudStrats) {
    try {
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
      const m = minOfDay(nowSec);

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
        const isOvernightExit = !t.open && t.reason !== 'Still open' && t.xi >= lastBarIdx - 1 &&
          m >= OPEN_MIN && m < OPEN_MIN + 25 &&
          (Math.abs(nowSec - (candleData.t[t.xi] || exitTime)) < 3600);
        const isRecentExit = !t.open && t.reason !== 'Still open' && t.xi >= lastBarIdx - 1 &&
          (Math.abs(nowSec - exitTime) < tf * 60 * 3 || isOvernightExit);

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

            sendTelegram(msg, null, null, false, { category: 'strategy' }).catch(() => {});
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
            const epStr = t.ep.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            const xpStr = t.xp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            const exitTimeStr = fmtAlertTime(exitTime || nowSec);
            const entryTimeStr = fmtAlertTime(entryTime, exitTime || nowSec);
            const resPill = isWin ? `${ptsSign}${ptsAbs} Pts. ✅ WIN` : `${ptsSign}${ptsAbs} Pts. ❌ LOSS`;
            const reason = t.reason && t.reason !== 'Still open' ? ` (${t.reason})` : '';

            const candlesHeld = t.bars != null ? t.bars : (t.xi != null && t.ei != null ? Math.max(1, t.xi - t.ei) : null);
            const isOvernight = entryTime && exitTime && dayOf(entryTime) !== dayOf(exitTime);
            const durationStr = candlesHeld != null
              ? `${candlesHeld} candle${candlesHeld === 1 ? '' : 's'}${isOvernight ? ' (overnight)' : ` (${candlesHeld * tf}m)`}`
              : (isOvernight ? 'Overnight' : '—');

            const msg = [
              '🏁 <b>TRADE COMPLETED</b>',
              '━━━━━━━━━━━━━━━━━━━━━',
              `📈 <b>Symbol</b>: ${symName} (${tf}m)`,
              `🎯 <b>Action</b>: EXIT ${t.dir > 0 ? 'BUY' : 'SELL'}${reason}`,
              `💰 <b>Entry</b>: ${epStr} Pts. (${entryTimeStr} IST)`,
              `💰 <b>Exit</b>: ${xpStr} Pts. (${exitTimeStr} IST)`,
              `⏳ <b>Duration</b>: ${durationStr}`,
              `📊 <b>Result</b>: ${resPill}`,
              `🧠 <b>Strategy</b>: ${stratName}`
            ].join('\n');

            sendTelegram(msg, null, null, false, { category: 'strategy' }).catch(() => {});
          }
        }
      }
    } catch (stratErr) {
      log('Cloud strat eval error:', cs && cs.name, stratErr.message);
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
  const nowDay = dayOf(Math.floor(Date.now() / 1000));
  const ptIsToday = Number.isFinite(pt) && dayOf(pt) === nowDay;
  const todayBars = bars.filter(b => dayOf(b[0]) === nowDay);
  if (todayBars.length || ptIsToday) {
    if (S.dayKey !== nowDay) {
      S.dayKey = nowDay;
      S.dayOpen = todayBars.length ? todayBars[0][1] : null;
      S.dayHigh = null;
      S.dayLow = null;
    } else if (!Number.isFinite(S.dayOpen) && todayBars.length) {
      S.dayOpen = todayBars[0][1];
    }
    if (ptIsToday && Number.isFinite(meta.regularMarketDayHigh)) S.dayHigh = Number.isFinite(S.dayHigh) ? Math.max(S.dayHigh, meta.regularMarketDayHigh) : +meta.regularMarketDayHigh.toFixed(2);
    if (ptIsToday && Number.isFinite(meta.regularMarketDayLow)) S.dayLow = Number.isFinite(S.dayLow) ? Math.min(S.dayLow, meta.regularMarketDayLow) : +meta.regularMarketDayLow.toFixed(2);
  }
  let last = null;
  if (Number.isFinite(price) && Number.isFinite(pt)) { last = applyTick(sym, +price.toFixed(2), pt); S.price = +price.toFixed(2); S.priceAt = pt; }
  // Only fall back to Yahoo chartPreviousClose when TradingView has not supplied exact exchange prevClose for this day
  if (!S.prevClose || S.tvPrevDay !== nowDay) {
    if (Number.isFinite(meta.previousClose)) S.prevClose = meta.previousClose;
    else if (Number.isFinite(meta.chartPreviousClose)) S.prevClose = meta.chartPreviousClose;
  }
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
    columns: ['close', 'open', 'high', 'low', 'change_abs']
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
            const today = dayOf(now);
            for (const item of j.data) {
              const sym = item.s === 'NSE:NIFTY' ? 'NIFTY' : item.s === 'NSE:BANKNIFTY' ? 'BANKNIFTY' : null;
              if (!sym) continue;
              const S = store[sym];
              const price = item.d && item.d[0];
              if (Number.isFinite(price) && price > 0) {
                const p = +price.toFixed(2);
                const dOpen = item.d[1], dHigh = item.d[2], dLow = item.d[3], dChgAbs = item.d[4];
                if (S.dayKey !== today) {
                  S.dayKey = today;
                  S.dayOpen = null; S.dayHigh = null; S.dayLow = null;
                }
                if (Number.isFinite(dOpen) && dOpen > 0) S.dayOpen = +dOpen.toFixed(2);
                if (Number.isFinite(dHigh) && dHigh > 0) S.dayHigh = +dHigh.toFixed(2);
                if (Number.isFinite(dLow) && dLow > 0) S.dayLow = +dLow.toFixed(2);
                if (Number.isFinite(dChgAbs)) {
                  S.prevClose = +(p - dChgAbs).toFixed(2);
                  S.tvPrevCloseAt = Date.now();
                  S.tvPrevDay = today;
                }
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
let pollTimer = null, tvFails = 0, lastYahooPoll = 0, lastTvPoll = 0;
async function pollLoop() {
  const fast = marketOpenNow() || recentlyTicked();
  const now = Date.now();
  try {
    // 1. Periodic Yahoo Finance sync for full candle data (every 5s during market, or every idle cycle, or on TV fallback)
    if (!fast || tvFails > 0 || now - lastYahooPoll >= 5000) {
      lastYahooPoll = now;
      await Promise.all(Object.keys(SYMBOLS).map(async sym => {
        const S = store[sym];
        try { await pollYahoo(sym); }
        catch (e) { S.fails++; S.lastErr = 'Yahoo: ' + e.message; if (S.fails >= 5 && fast) { try { await pollOldSite(sym); } catch (e2) { S.lastErr += ' | history site: ' + e2.message; } } }
      }));
    }

    // 2. Authoritative live/settled quotes from TradingView (every 500ms in market hours, every 60s when idle)
    if (fast || now - lastTvPoll >= 60000) {
      lastTvPoll = now;
      try {
        await pollTradingView();
        tvFails = 0;
      } catch (e) {
        tvFails++;
      }
    }
    checkMarketAlerts();
    runCloudStrats();
  } catch (err) {
    log('Poll loop error:', err.message || String(err));
  } finally {
    pollTimer = setTimeout(pollLoop, fast ? 500 : IDLE_POLL_MS);
  }
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
    const publicTgConfig = () => ({
      ownerActive: OWNER_CHAT_IDS.length > 0,
      extraChatIds: friendsList.map(f => f.id),
      friends: friendsList.map(f => ({ id: f.id, name: f.name || '', welcomed: !!f.welcomed, strategyAlerts: !!f.strategyAlerts })),
      enabled: telegramConfig.enabled,
      notifyEntries: telegramConfig.notifyEntries,
      notifyExits: telegramConfig.notifyExits,
      notifyMarket: telegramConfig.notifyMarket,
      configured: !!telegramConfig.token
    });
    const sanitizeTgSendResult = (r) => {
      if (!r || !Array.isArray(r.results)) {
        return {
          ok: !!(r && r.ok),
          skipped: r ? r.skipped : undefined,
          error: r && !r.ok ? (r.error || 'Failed to send') : undefined,
          ownerOk: false,
          ownerError: r && !r.ok ? (r.error || 'Failed to send') : null,
          friendResults: []
        };
      }
      let hasOwner = false, ownerOk = false, ownerError = null;
      const friendResults = [];
      for (const item of r.results) {
        if (OWNER_CHAT_IDS.includes(item.chatId)) {
          hasOwner = true;
          if (item.ok) ownerOk = true;
          else if (!ownerError) ownerError = item.error || 'Telegram error';
        } else {
          const fr = getFriend(item.chatId);
          friendResults.push({
            chatId: item.chatId,
            name: fr ? fr.name : '',
            ok: !!item.ok,
            needsStart: !!item.needsStart,
            error: item.ok ? null : (item.error || 'Telegram error')
          });
        }
      }
      if (hasOwner && ownerOk) ownerError = null;
      const allDelivered = (!hasOwner || ownerOk) && friendResults.every(f => f.ok);
      return {
        ok: !!(ownerOk || friendResults.some(f => f.ok)),
        allDelivered,
        ownerOk: hasOwner ? ownerOk : undefined,
        ownerError: hasOwner ? ownerError : undefined,
        friendResults,
        error: !(ownerOk || friendResults.some(f => f.ok)) ? (ownerError || (friendResults[0] && friendResults[0].error) || r.error || 'Failed to send') : undefined
      };
    };

    if (p === '/api/telegram/config') {
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        if (body.token) telegramConfig.token = String(body.token).trim();
        const newlyAddedFriends = [];
        if (body.extraChatIds !== undefined) {
          const raw = Array.isArray(body.extraChatIds)
            ? body.extraChatIds
            : String(body.extraChatIds || '').split(',');
          const nextIds = [...new Set(
            raw.map(s => String(s || '').trim()).filter(s => /^-?\d+$/.test(s) && !OWNER_CHAT_IDS.includes(s))
          )];
          const byOldId = new Map(friendsList.map(f => [f.id, f]));
          friendsList = nextIds.map(id => {
            if (byOldId.has(id)) return byOldId.get(id);
            const known = recentFriendSenders.find(s => s.chatId === id);
            newlyAddedFriends.push(id);
            return { id, name: known ? known.name : '', welcomed: false, strategyAlerts: false };
          });
          saveFriends(true);
        }
        if (body.enabled !== undefined) telegramConfig.enabled = !!body.enabled;
        if (body.notifyEntries !== undefined) telegramConfig.notifyEntries = !!body.notifyEntries;
        if (body.notifyExits !== undefined) telegramConfig.notifyExits = !!body.notifyExits;
        if (body.notifyMarket !== undefined) telegramConfig.notifyMarket = !!body.notifyMarket;
        saveTelegramConfig();
        for (const fid of newlyAddedFriends) {
          await sendFriendWelcomeIfNeeded(fid);
        }
        return send(req, res, 200, { ok: true, config: publicTgConfig() });
      }
      return send(req, res, 200, { ok: true, config: publicTgConfig() });
    }
    if (p === '/api/telegram/friends/add' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const rawInput = body.chatIds !== undefined ? body.chatIds : body.chatId;
      const tokens = Array.isArray(rawInput)
        ? rawInput.map(s => String(s || '').trim()).filter(Boolean)
        : String(rawInput || '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
      if (!tokens.length) {
        return send(req, res, 400, { ok: false, error: 'Please enter a valid numeric Telegram Chat ID.', config: publicTgConfig() });
      }
      const invalid = tokens.filter(t => !/^-?\d+$/.test(t));
      if (invalid.length) {
        return send(req, res, 400, { ok: false, error: `Invalid Telegram Chat ID "${invalid[0]}". Use digits only (or click Auto-Detect Friend ID).`, config: publicTgConfig() });
      }
      const friendIds = [...new Set(tokens.filter(t => !OWNER_CHAT_IDS.includes(t)))];
      if (!friendIds.length) {
        return send(req, res, 400, { ok: false, error: 'That is the Owner Telegram ID, which is already active and locked on the server.', config: publicTgConfig() });
      }
      const results = [];
      for (const id of friendIds) {
        const known = recentFriendSenders.find(s => s.chatId === id);
        const hintName = friendIds.length === 1 && body.name ? String(body.name).trim() : (known ? known.name : '');
        const { friend, added } = upsertFriend(id, { name: hintName });
        const wr = await sendFriendWelcomeIfNeeded(id);
        results.push({
          chatId: id,
          name: (friend && friend.name) || '',
          added,
          welcomed: !!(friend && friend.welcomed),
          welcomeSent: !!wr.sent,
          needsStart: !!wr.needsStart,
          error: wr.ok ? null : (wr.error || 'Could not reach Telegram chat')
        });
      }
      return send(req, res, 200, { ok: true, config: publicTgConfig(), results });
    }
    if (p === '/api/telegram/friends/remove' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const cid = isValidChatId(body.chatId);
      if (!cid) return send(req, res, 400, { ok: false, error: 'Invalid Telegram Chat ID.', config: publicTgConfig() });
      if (OWNER_CHAT_IDS.includes(cid)) {
        return send(req, res, 403, { ok: false, error: 'Owner Telegram ID is locked on the server and cannot be removed.', config: publicTgConfig() });
      }
      const removed = removeFriendById(cid);
      return send(req, res, 200, { ok: true, removed, config: publicTgConfig() });
    }
    if (p === '/api/telegram/detect') {
      const r = await detectTelegramChatId();
      return send(req, res, 200, r);
    }
    if (p === '/api/telegram/test' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const targetChat = body.chatId ? String(body.chatId).trim() : null;
      const d = new Date(Date.now() + IST * 1000);
      let h = d.getUTCHours(), m = d.getUTCMinutes(), sec = d.getUTCSeconds();
      const ap = h >= 12 ? 'PM' : 'AM';
      h = h % 12; if (!h) h = 12;
      const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')} ${ap}`;
      const text = [
        '🔔 <b>TRADEX NOTIFICATION TEST</b>',
        '━━━━━━━━━━━━━━━━━━━━━',
        '✅ Telegram bot connected successfully!',
        '📈 Live alerts for BUY / SELL entries, trade exits, and market open/close summaries are active.',
        `⏰ Time: ${timeStr} IST`
      ].join('\n');
      const r = await sendTelegram(text, null, targetChat, true);
      return send(req, res, 200, sanitizeTgSendResult(r));
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
      const cat = (body.type === 'entry' || body.type === 'exit') ? 'strategy' : (body.category || 'general');
      const r = await sendTelegram(body.text, null, null, false, { category: cat });
      return send(req, res, 200, sanitizeTgSendResult(r));
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

/* ---------- telegram bot interactive polling (/info, /status) ---------- */
let tgPollOffset = 0;
let tgPollingActive = false;

async function pollTelegramUpdates(timeoutSec = 2, allowWhenDisabled = false) {
  const token = telegramConfig.token;
  if (!token || (!allowWhenDisabled && !telegramConfig.enabled) || tgPollingActive) return;
  tgPollingActive = true;
  try {
    const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/getUpdates?offset=${tgPollOffset}&timeout=${timeoutSec}`;
    const res = await new Promise(ok => {
      const req = https.get(url, r => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => {
          try { ok(JSON.parse(d)); } catch (_) { ok(null); }
        });
      });
      req.on('error', () => ok(null));
      req.setTimeout((timeoutSec + 6) * 1000, () => { req.destroy(); ok(null); });
    });

    if (res && res.ok && Array.isArray(res.result)) {
      for (const u of res.result) {
        if (u.update_id >= tgPollOffset) tgPollOffset = u.update_id + 1;
        if (u.my_chat_member && u.my_chat_member.chat) {
          recordFriendSender({ chat: u.my_chat_member.chat, from: u.my_chat_member.from });
        }
        const msg = u.message || u.channel_post;
        if (!msg || !msg.chat || !msg.chat.id) continue;
        recordFriendSender(msg); // preserve sender for Auto-Detect before recipient filter
        const chatId = String(msg.chat.id);
        const recipients = getRecipientChatIds();
        if (!recipients.includes(chatId)) continue; // security: only answer authorized recipients

        const rawText = msg.text ? String(msg.text).trim() : '';
        const parts = rawText ? rawText.split(/\s+/) : [];
        const text = parts.length ? parts[0].toLowerCase().replace(/@\w+$/, '') : '';
        const arg = parts.length > 1 ? parts[1].toLowerCase() : '';
        const friend = getFriend(chatId);
        if (friend && !friend.welcomed) {
          await sendFriendWelcomeIfNeeded(chatId, token, msg);
          if (!text || text === '/start') continue;
        }
        if (!text) continue;
        if (msg.date && msg.date < serverBootSec - 300) continue;
        if (text === '/info' || text === '/trades' || text === 'info') {
          const openTrades = getOpenCloudTrades();
          const d = new Date(Date.now() + IST * 1000);
          let h = d.getUTCHours(), mi = d.getUTCMinutes();
          const ap = h >= 12 ? 'PM' : 'AM';
          h = h % 12; if (!h) h = 12;
          const timeStr = `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')} ${ap}`;

          if (!openTrades.length) {
            const resp = [
              '📊 <b>TRADEX POSITION STATUS</b>',
              '━━━━━━━━━━━━━━━━━━━━━',
              '⚡ <b>Open Positions</b>: 0 active',
              `🤖 <b>Cloud Strategies</b>: ${cloudStrats.length} running 24/7`,
              `📈 <b>Market</b>: ${marketOpenNow() ? 'OPEN' : 'CLOSED'} (${timeStr} IST)`,
              '',
              'All strategies are flat (no active positions). Alerts will fire automatically on the next entry/exit.'
            ].join('\n');
            sendTelegramSingle(token, chatId, resp).catch(() => {});
          } else {
            const lines = openTrades.map((ot, idx) => {
              const tr = ot.trade;
              const dir = tr.dir > 0 ? 'BUY' : 'SELL';
              const icon = tr.dir > 0 ? '🟢' : '🔴';
              const ep = tr.ep.toLocaleString('en-IN', { minimumFractionDigits: 2 });
              const pts = tr.pts != null ? tr.pts : 0;
              const ptsStr = `${pts >= 0 ? '+' : '−'}${Math.abs(pts).toFixed(2)} Pts.`;
              const entryTime = fmtAlertTime(tr.et);
              const candles = tr.bars != null ? `${tr.bars} candle${tr.bars === 1 ? '' : 's'}` : '';
              return [
                `<b>${idx + 1}. ${icon} ${ot.symName} (${ot.tf}m) — ${dir}</b>`,
                `   • Strategy: <i>${ot.stratName}</i>`,
                `   • Entry: ${ep} Pts. (${entryTime} IST)`,
                `   • Current PnL: <b>${ptsStr}</b>${candles ? ` (${candles})` : ''}`,
                tr.sl != null ? `   • Trailing SL: ${tr.sl.toLocaleString('en-IN', { minimumFractionDigits: 2 })} Pts.` : '',
                tr.tp != null ? `   • Target: ${tr.tp.toLocaleString('en-IN', { minimumFractionDigits: 2 })} Pts.` : ''
              ].filter(Boolean).join('\n');
            });

            const resp = [
              `📊 <b>TRADEX OPEN POSITIONS (${openTrades.length})</b>`,
              '━━━━━━━━━━━━━━━━━━━━━',
              lines.join('\n\n'),
              '━━━━━━━━━━━━━━━━━━━━━',
              `⏰ As of: ${timeStr} IST`
            ].join('\n');
            sendTelegramSingle(token, chatId, resp).catch(() => {});
          }
        } else if (text === '/status' || text === 'status' || text === '/market' || text === 'market') {
          const d = new Date(Date.now() + IST * 1000);
          let h = d.getUTCHours(), mi = d.getUTCMinutes();
          const ap = h >= 12 ? 'PM' : 'AM';
          h = h % 12; if (!h) h = 12;
          const timeStr = `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')} ${ap}`;
          const today = dayOf(Math.floor(Date.now() / 1000));
          const nSum = getDailyMarketSummary('NIFTY', today);
          const bSum = getDailyMarketSummary('BANKNIFTY', today);
          const fmtLine = (icon, label, sum) => {
            if (!sum || !sum.close) return `${icon} <b>${label}</b>: —`;
            const chg = sum.pct != null ? ` (${sum.diff >= 0 ? '+' : ''}${sum.diff.toFixed(2)} | ${sum.diff >= 0 ? '+' : ''}${sum.pct.toFixed(2)}%)` : '';
            const extra = (sum.open != null && sum.low != null && sum.high != null)
              ? `\n   <i>Open:</i> ${sum.open.toFixed(2)} | <i>Range:</i> ${sum.low.toFixed(2)} – ${sum.high.toFixed(2)}`
              : '';
            return `${icon} <b>${label}</b>: ${sum.close.toFixed(2)} Pts.${chg}${extra}`;
          };
          const resp = [
            '⚡ <b>TRADEX SYSTEM STATUS</b>',
            '━━━━━━━━━━━━━━━━━━━━━',
            `📈 <b>Market Status</b>: ${marketOpenNow() ? 'OPEN ✅' : 'CLOSED ⏸️'}`,
            `⏰ <b>Server Time</b>: ${timeStr} IST`,
            fmtLine('🎯', 'NIFTY 50', nSum),
            fmtLine('🏦', 'BANK NIFTY', bSum),
            `🤖 <b>Cloud Strategies</b>: ${cloudStrats.length} active`,
            `🔔 <b>Alert Notifications</b>: ${telegramConfig.enabled ? 'Enabled' : 'Disabled'}`,
            '━━━━━━━━━━━━━━━━━━━━━',
            'Send /info to view open trades • /market for live quotes.'
          ].join('\n');
          sendTelegramSingle(token, chatId, resp).catch(() => {});
        } else if (['/strategies', '/strategy', '/strategies_on', '/strategy_on', '/strategies_off', '/strategy_off'].includes(text)) {
          let nextState;
          if (text.endsWith('_on') || ['on', 'start', 'enable', '1', 'yes'].includes(arg)) {
            nextState = setStrategyAlertsForUser(chatId, true);
          } else if (text.endsWith('_off') || ['off', 'stop', 'disable', '0', 'no'].includes(arg)) {
            nextState = setStrategyAlertsForUser(chatId, false);
          } else if (arg === 'status') {
            nextState = isStrategyAlertsEnabled(chatId);
          } else if (arg) {
            const cur = isStrategyAlertsEnabled(chatId);
            const usage = [
              '⚙️ <b>STRATEGY ALERTS USAGE</b>',
              '━━━━━━━━━━━━━━━━━━━━━',
              `Current status (your chat): <b>${cur ? 'ON ✅' : 'OFF ⏸️'}</b>`,
              '• /strategies_on — Start live daily strategy alerts',
              '• /strategies_off — Stop live daily strategy alerts',
              '• /strategies — Toggle ON / OFF'
            ].join('\n');
            sendTelegramSingle(token, chatId, usage).catch(() => {});
            continue;
          } else {
            nextState = setStrategyAlertsForUser(chatId, !isStrategyAlertsEnabled(chatId));
          }

          const resp = nextState
            ? [
                '✅ <b>LIVE STRATEGY ALERTS: ON</b>',
                '━━━━━━━━━━━━━━━━━━━━━',
                '🚀 You will now receive real-time cloud strategy <b>BUY / SELL entries</b> and <b>exit PnL</b> alerts on your Telegram every trading day.',
                '',
                '<i>Exclusive to your Telegram chat only.</i>',
                'Tap /strategies_off (or /strategies) anytime to stop.'
              ].join('\n')
            : [
                '⏸️ <b>LIVE STRATEGY ALERTS: OFF</b>',
                '━━━━━━━━━━━━━━━━━━━━━',
                '🔕 Live strategy entry &amp; exit alerts are turned off for your Telegram.',
                '✅ Market Open / Close summaries (09:15 &amp; 15:30 IST) and /status / /info commands remain active.',
                '',
                '<i>Exclusive to your Telegram chat only.</i>',
                'Tap /strategies_on (or /strategies) anytime to turn them back ON.'
              ].join('\n');
          sendTelegramSingle(token, chatId, resp).catch(() => {});
        } else if (text === '/help' || text === '/start') {
          const stratOn = isStrategyAlertsEnabled(chatId);
          const resp = [
            '🤖 <b>TradeX Terminal Bot</b>',
            '━━━━━━━━━━━━━━━━━━━━━',
            '<b>Available Commands:</b>',
            '• /strategies — Start or stop live strategy BUY/SELL &amp; exit alerts (your chat only)',
            '   ↳ /strategies_on  |  /strategies_off',
            '• /status or /market — View live NIFTY 50 &amp; BANK NIFTY market data &amp; market state',
            '• /info — View active trade positions &amp; running strategy details',
            '• /help — Show this commands guide',
            '━━━━━━━━━━━━━━━━━━━━━',
            `🔔 <b>Your Live Strategy Alerts:</b> ${stratOn ? '<b>ON ✅</b>' : '<b>OFF ⏸️</b> (send /strategies_on to enable)'}`,
            '📡 Market Open/Close summaries (09:15 / 15:31 IST) are delivered automatically.'
          ].join('\n');
          sendTelegramSingle(token, chatId, resp).catch(() => {});
        }
      }
    }
  } catch (_) {}
  finally {
    tgPollingActive = false;
  }
}

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
  const scheduleTgPoll = () => {
    pollTelegramUpdates(2).finally(() => setTimeout(scheduleTgPoll, 1500));
  };
  scheduleTgPoll();
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { for (const sym in SYMBOLS) save(sym); process.exit(0); });
boot();
