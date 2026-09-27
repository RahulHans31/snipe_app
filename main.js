const { app, BrowserWindow, ipcMain, session, shell, dialog, safeStorage, Menu, Tray, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

// Keep Chromium's cache, cookies, service-worker DB, and app state in one
// dedicated profile. A separate cache path avoids collisions with stale
// profiles created by earlier Electron runs or another Chromium app.
const legacyUserData = app.getPath('userData');
const profileRoot = path.join(app.getPath('appData'), 'Snipe Desktop');
app.setPath('userData', profileRoot);
app.setPath('cache', path.join(profileRoot, 'Cache'));
fs.mkdirSync(profileRoot, { recursive: true });

let singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  // Chromium can leave the profile mutex inaccessible after an interrupted
  // shutdown or a permissions/security-software race. Retry with a separate
  // profile while preserving the original profile and its saved state.
  const recoveryRoot = path.join(path.dirname(profileRoot), 'Snipe Desktop Recovery');
  try {
    fs.mkdirSync(recoveryRoot, { recursive: true });
    const oldState = path.join(profileRoot, 'snipe-state.json');
    const recoveryState = path.join(recoveryRoot, 'snipe-state.json');
    if (fs.existsSync(oldState) && !fs.existsSync(recoveryState)) fs.copyFileSync(oldState, recoveryState);
    app.setPath('userData', recoveryRoot);
    app.setPath('cache', path.join(recoveryRoot, 'Cache'));
    singleInstance = app.requestSingleInstanceLock();
    if (singleInstance) console.warn('[Snipe/startup] normal profile lock unavailable; using recovery profile');
  } catch (err) {
    console.error('[Snipe/startup] recovery profile failed —', err.message);
  }
}
if (!singleInstance) app.quit();

let mainWindow;
let sessionWindow;
let tray = null;
let isQuitting = false;
const targetWindows = new Map();
const paymentWindows = new Map();
const upiWindows = new Map();
const checkoutContexts = new Map();
const laneStates = new Map(); // jobId -> { id, label, phase, detail, startedAt }
let runCheckout;
let engineReady;
let DC_POOL;
let trackingActive = false;
let trackingRunId = 0;
let serviceabilityDC = 2;
const checkoutInFlight = new Set();
const paymentReadyProducts = new Set();
// Login flow state — one struct, one auto-timeout. When the timeout fires or
// verifyLoginOtp succeeds/fails, endLoginSession() restores the pre-login
// cookies so the browser session stays consistent even if the user walks away.
const LOGIN_TIMEOUT_MS = 5 * 60_000;
let loginSession = null; // { snapshot, requestId, phone, dc, timer }
const stateFile = () => path.join(app.getPath('userData'), 'snipe-state.json');

const defaults = {
  targets: [],
  settings: { pincode: '', paymentMode: 'off', quantity: 1, pollInterval: 3, parallelism: 2, bank: '', vpa: '', addressId: '', addressPincode: '', conditionalBuy: false, supercoins: false, gst: false, telegramToken: '', telegramChatId: '', notifyPlaced: true, notifyFailed: true, sound: false },
  accounts: [],
  cards: [],
  selectedCardId: null,
  events: [],
  orders: [],
  presets: []
};

function recordOrder({ orderRef, target, accountName, grandTotal }) {
  const state = readState();
  const entry = { orderRef: orderRef || null, targetName: target?.name || '', productId: target?.productId || '', accountName: accountName || 'browser', at: Date.now(), grandTotal: grandTotal || null };
  state.orders = [entry, ...(state.orders || [])].slice(0, 500);
  writeState(state);
  mainWindow?.webContents.send('snipe:orders', state.orders);
}

// In-memory state cache. Populated by hydrateState() on app-ready and mutated
// through writeState(); the disk file is refreshed via a 200 ms debounced
// atomic flush (tempfile + rename) so a crash mid-write can't corrupt state.
let currentState = null;
let flushTimer = null;
let flushInFlight = false;

// Sensitive fields (Telegram token + account cookies) are stored on disk via
// Electron safeStorage (Windows DPAPI / macOS Keychain / Linux keyring) so
// they aren't recoverable from a copied state file. In-memory currentState
// always holds plaintext; the transform runs at the disk boundary only.
const ENC_MARK = '__snipeEnc';
function encryptionAvailable() {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}
function encryptSensitive(value) {
  if (value == null || value === '' || (Array.isArray(value) && !value.length)) return value;
  if (!encryptionAvailable()) return value;
  try {
    const plain = typeof value === 'string' ? value : JSON.stringify(value);
    return { [ENC_MARK]: true, cipher: safeStorage.encryptString(plain).toString('base64') };
  } catch { return value; }
}
function decryptSensitive(field, kind) {
  if (!field || typeof field !== 'object' || Array.isArray(field) || !field[ENC_MARK]) return field;
  if (!encryptionAvailable()) return null;
  try {
    const plain = safeStorage.decryptString(Buffer.from(field.cipher, 'base64'));
    return kind === 'json' ? JSON.parse(plain) : plain;
  } catch { return null; }
}

function serializeStateForDisk(state) {
  const clone = structuredClone(state);
  if (clone.settings?.telegramToken) {
    clone.settings.telegramToken = encryptSensitive(clone.settings.telegramToken);
  }
  if (Array.isArray(clone.accounts)) {
    for (const account of clone.accounts) {
      if (Array.isArray(account.cookies) && account.cookies.length) {
        account.cookies = encryptSensitive(account.cookies);
      }
    }
  }
  // Encrypt full PAN + CVV per card; keep nickname/lastFour/expiry/network in
  // plaintext so the UI can render the card list without a decrypt round-trip.
  if (Array.isArray(clone.cards)) {
    for (const card of clone.cards) {
      if (card.number && typeof card.number === 'string') card.number = encryptSensitive(card.number);
      if (card.cvv && typeof card.cvv === 'string') card.cvv = encryptSensitive(card.cvv);
    }
  }
  return clone;
}

function deserializeStateFromDisk(state) {
  const tokenField = state?.settings?.telegramToken;
  if (tokenField && typeof tokenField === 'object' && tokenField[ENC_MARK]) {
    const dec = decryptSensitive(tokenField, 'string');
    state.settings.telegramToken = dec == null ? '' : dec;
  }
  if (Array.isArray(state?.accounts)) {
    for (const account of state.accounts) {
      if (account.cookies && !Array.isArray(account.cookies) && account.cookies[ENC_MARK]) {
        const dec = decryptSensitive(account.cookies, 'json');
        account.cookies = Array.isArray(dec) ? dec : [];
      }
    }
  }
  if (Array.isArray(state?.cards)) {
    for (const card of state.cards) {
      if (card.number && typeof card.number === 'object' && card.number[ENC_MARK]) {
        card.number = decryptSensitive(card.number, 'string') || '';
      }
      if (card.cvv && typeof card.cvv === 'object' && card.cvv[ENC_MARK]) {
        card.cvv = decryptSensitive(card.cvv, 'string') || '';
      }
    }
  }
  return state;
}

function hydrateState() {
  const target = stateFile();
  try {
    if (!fs.existsSync(target)) {
      const legacy = path.join(legacyUserData, 'snipe-state.json');
      if (legacy !== target && fs.existsSync(legacy)) fs.copyFileSync(legacy, target);
    }
  } catch (err) {
    console.error(`[Snipe/state] legacy migration failed — ${err.message}`);
  }
  if (fs.existsSync(target)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
      const state = deserializeStateFromDisk({ ...defaults, ...parsed });
      state.targets = (state.targets || []).map((t, i) => ({ ...t, id: t.id || `target_${t.productId || i}` }));
      if (state.settings?.pmode) state.settings.paymentMode = state.settings.paymentMode || state.settings.pmode;
      currentState = state;
      return;
    } catch (err) {
      // Preserve the bad file for forensics instead of silently defaulting.
      try {
        const backup = `${target}.corrupt-${Date.now()}`;
        fs.copyFileSync(target, backup);
        console.error(`[Snipe/state] corrupt state backed up to ${backup} — ${err.message}`);
      } catch (backupErr) {
        console.error(`[Snipe/state] failed to back up corrupt state — ${backupErr.message}`);
      }
    }
  }
  currentState = structuredClone(defaults);
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flushStateNow(); }, 200);
}

function flushStateNow() {
  if (!currentState || flushInFlight) return;
  flushInFlight = true;
  try {
    const target = stateFile();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(serializeStateForDisk(currentState), null, 2));
    fs.renameSync(tmp, target);
  } catch (err) {
    console.error(`[Snipe/state] flush failed — ${err.message}`);
  } finally {
    flushInFlight = false;
  }
}

function readState() {
  if (!currentState) hydrateState();
  return currentState;
}

function writeState(state) {
  currentState = state;
  flushStateNow();
}

function writeStateDebounced(state) {
  currentState = state;
  scheduleFlush();
}

function emit(event) {
  const state = readState();
  const stamped = { at: Date.now(), ...event };
  state.events = [stamped, ...(state.events || [])].slice(0, 100);
  writeStateDebounced(state);
  mainWindow?.webContents.send('snipe:event', stamped);
}

// Per-endpoint request budgets. AbortSignal.timeout throws AbortError once
// exceeded, letting a caller retry or move on instead of wedging a lane on a
// single hung POST during a drop.
const FETCH_TIMEOUT = { telegram: 5000, serviceability: 10000, login: 10000, checkout: 20000 };

async function telegramSend(text) {
  const settings = readState().settings || {};
  if (!settings.telegramToken || !settings.telegramChatId) {
    return { ok: false, error: 'Telegram token or chat id missing' };
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(settings.telegramToken)}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: settings.telegramChatId, text }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT.telegram),
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    return { ok: true };
  } catch (error) { return { ok: false, error: error.message }; }
}

async function telegramAlert(text, kind) {
  const settings = readState().settings || {};
  const enabled = kind === 'placed' ? settings.notifyPlaced !== false : settings.notifyFailed !== false;
  if (!enabled || !settings.telegramToken || !settings.telegramChatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${encodeURIComponent(settings.telegramToken)}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: settings.telegramChatId, text }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT.telegram),
    });
  } catch (error) { emit({ kind: 'warn', text: `Telegram alert failed · ${error.message}` }); }
}

function cookieHeader(cookies) {
  return (cookies || []).map((c) => `${c.name}=${c.value}`).join('; ');
}

function mergeSetCookies(context, setCookies, responseUrl) {
  if (!context || !setCookies?.length) return;
  const host = new URL(responseUrl).hostname;
  for (const raw of setCookies) {
    const pair = String(raw).split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    const existing = context.cookies.find((cookie) => cookie.name === name);
    if (existing) existing.value = value;
    else context.cookies.push({ name, value, domain: `.${host}`, path: '/' });
  }
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Ring buffer of last N poll RTTs (ms) — powers the header sparkline. Not
// persisted; ephemeral to the running session.
const POLL_RTT_MAX = 60;
const pollRttBuffer = [];
function recordPollRtt(ms) {
  pollRttBuffer.push(ms);
  while (pollRttBuffer.length > POLL_RTT_MAX) pollRttBuffer.shift();
  mainWindow?.webContents.send('snipe:metrics', { pollRtt: pollRttBuffer.slice() });
}

async function pollServiceability(targets, pincode) {
  const body = JSON.stringify({
    requestContext: { products: targets.map((target) => ({ productId: target.productId })), marketplace: 'FLIPKART' },
    locationContext: { pincode: String(pincode) },
  });
  const started = Date.now();
  const response = await fetch(`https://${serviceabilityDC}.rome.api.flipkart.com/api/3/product/serviceability`, {
    method: 'POST',
    headers: {
      Accept: '*/*',
      'Content-Type': 'application/json',
      'X-User-Agent': 'Mozilla/5.0 FKUA/msite/0.0.3/msite/Mobile',
      Cookie: cookieHeader(await browserCookies()),
    },
    body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT.serviceability),
  });
  recordPollRtt(Date.now() - started);
  const data = await response.json().catch(() => null);
  if (response.status === 406 && data?.ERROR_MESSAGE === 'DC Change') {
    const next = data?.META_INFO?.dcInfo?.id || data?.RESPONSE?.id;
    if (next) serviceabilityDC = next;
    return [];
  }
  if (!response.ok) throw new Error(`serviceability HTTP ${response.status}`);
  const responseObj = data?.RESPONSE || data?.response || {};
  const out = [];
  for (const target of targets) {
    const listing = responseObj[target.productId]?.listingSummary;
    if (!listing) continue;
    const serviceable = listing.serviceable === true
      || !!listing.deliveryInfo?.primaryOption?.text
      || (Array.isArray(listing.deliveryInfo?.fasterOptions) && listing.deliveryInfo.fasterOptions.length > 0);
    if (listing.available === true && serviceable) {
      // Forward the buybox lid from the same response that said this listing
      // was available, so checkout buys the exact seller-listing that flipped
      // in — not whatever /api/4/page/fetch happens to return moments later.
      out.push({ ...target, pollLid: listing.listingId || null });
    }
  }
  return out;
}

async function browserCookies() {
  const cookies = await session.defaultSession.cookies.get({ url: 'https://www.flipkart.com' });
  return cookies.filter((cookie) => cookie.domain === 'flipkart.com' || cookie.domain.endsWith('.flipkart.com'));
}

const LOGIN_HEADERS = {
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Content-Type': 'application/json',
  Origin: 'https://www.flipkart.com',
  Referer: 'https://www.flipkart.com/',
  'X-User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/145.0.0.0 Safari/537.36 FKUA/website/42/website/Desktop',
};

function normalizeLoginId(raw) {
  const value = String(raw || '').trim();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return value.toLowerCase();
  const phone = value.replace(/[\s()-]/g, '');
  if (/^\d{10}$/.test(phone)) return `+91${phone}`;
  if (/^91\d{10}$/.test(phone)) return `+${phone}`;
  return value;
}

function responseSetCookies(response) {
  if (typeof response.headers.getSetCookie === 'function') return response.headers.getSetCookie();
  const raw = response.headers.get('set-cookie');
  return raw ? raw.split(/,(?=\s*[^;,=\s]+\s*=)/) : [];
}

async function persistLoginResponseCookies(response) {
  for (const header of responseSetCookies(response)) {
    const parts = header.split(';').map((part) => part.trim()).filter(Boolean);
    const first = parts.shift();
    const separator = first?.indexOf('=');
    if (!first || separator < 1) continue;
    const details = {
      url: 'https://www.flipkart.com',
      name: first.slice(0, separator),
      value: first.slice(separator + 1),
      domain: '.flipkart.com',
      path: '/',
      secure: false,
      httpOnly: false,
    };
    for (const attribute of parts) {
      const [rawName, ...rawValue] = attribute.split('=');
      const name = rawName.toLowerCase();
      const value = rawValue.join('=').trim();
      if (name === 'domain' && value) details.domain = value;
      else if (name === 'path' && value) details.path = value;
      else if (name === 'secure') details.secure = true;
      else if (name === 'httponly') details.httpOnly = true;
      else if (name === 'max-age' && /^\d+$/.test(value)) details.expirationDate = Math.floor(Date.now() / 1000) + Number(value);
      else if (name === 'expires') {
        const timestamp = Date.parse(value);
        if (Number.isFinite(timestamp)) details.expirationDate = timestamp / 1000;
      }
    }
    try { await session.defaultSession.cookies.set(details); } catch {}
  }
}

async function loginFetch(pathname, body, depth = 0) {
  const cookieHeader = (await browserCookies()).map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  const dc = loginSession?.dc ?? 1;
  const response = await fetch(`https://${dc}.rome.api.flipkart.com${pathname}`, {
    method: 'POST',
    credentials: 'include',
    redirect: 'manual',
    headers: { ...LOGIN_HEADERS, Cookie: cookieHeader },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT.login),
  });
  await persistLoginResponseCookies(response);
  let data = null;
  try { data = await response.json(); } catch {}
  if (response.status === 406 && data?.ERROR_MESSAGE === 'DC Change' && depth < 3) {
    const nextDC = data?.META_INFO?.dcInfo?.id || data?.RESPONSE?.id;
    if (nextDC && loginSession && nextDC !== loginSession.dc) {
      loginSession.dc = nextDC;
      return loginFetch(pathname, body, depth + 1);
    }
  }
  return { response, data };
}

async function endLoginSession({ restore = true } = {}) {
  const s = loginSession;
  loginSession = null;
  if (!s) return;
  if (s.timer) clearTimeout(s.timer);
  if (restore && s.snapshot) await restoreLoginCookies(s.snapshot);
}

function armLoginTimeout() {
  if (!loginSession) return;
  if (loginSession.timer) clearTimeout(loginSession.timer);
  loginSession.timer = setTimeout(() => {
    console.warn('[Snipe/login] session timed out — restoring pre-login cookies');
    endLoginSession({ restore: true }).catch((err) => console.warn('[Snipe/login] timeout restore failed —', err?.message));
  }, LOGIN_TIMEOUT_MS);
}

async function clearLoginCookies() {
  const cookies = await browserCookies();
  let removed = 0;
  for (const cookie of cookies) {
    if (cookie.name === 'T' || cookie.name === 'Network-Type') continue;
    const domain = (cookie.domain || 'flipkart.com').replace(/^\./, '');
    try {
      await session.defaultSession.cookies.remove(`https://${domain}${cookie.path || '/'}`, cookie.name);
      removed++;
    } catch {}
  }
  return removed;
}

async function restoreLoginCookies(cookies) {
  await clearLoginCookies();
  for (const cookie of cookies || []) {
    try {
      const details = {
        url: `https://${(cookie.domain || 'flipkart.com').replace(/^\./, '')}${cookie.path || '/'}`,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path || '/',
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
      };
      if (cookie.expirationDate) details.expirationDate = cookie.expirationDate;
      if (cookie.sameSite) details.sameSite = cookie.sameSite;
      await session.defaultSession.cookies.set(details);
    } catch {}
  }
}

async function prepareLoginSession() {
  if (!loginSession) {
    loginSession = { snapshot: await browserCookies(), requestId: null, phone: null, dc: 1, timer: null };
  } else {
    loginSession.dc = 1;
  }
  armLoginTimeout();
  await clearLoginCookies();
  const deviceId = Array.from({ length: 25 }, () => crypto.randomInt(0, 10)).join('');
  await session.defaultSession.cookies.set({ url: 'https://www.flipkart.com', name: 'T', value: deviceId, domain: '.flipkart.com', path: '/', secure: true });
  await session.defaultSession.cookies.set({ url: 'https://www.flipkart.com', name: 'Network-Type', value: '4g', domain: '.flipkart.com', path: '/', secure: true });
}

async function sendLoginOtp(rawPhone) {
  const phone = normalizeLoginId(rawPhone);
  if (!phone) throw new Error('Enter a mobile number or email address.');
  await prepareLoginSession();
  const status = await loginFetch('/api/6/user/signup/status', { loginId: [phone], supportAllStates: true });
  const accountStatus = status.data?.RESPONSE?.userDetails?.[phone];
  if (status.response.status === 200 && ['NOT_FOUND', 'NOT_REGISTERED'].includes(accountStatus)) {
    throw new Error(`Flipkart has no account for "${phone}".`);
  }
  const result = await loginFetch('/api/7/user/otp/generate', { loginId: phone });
  if (result.response.status !== 200) {
    const code = result.data?.errorCode || result.data?.RESPONSE?.errorCode;
    if (code === 'LOGIN_1004') throw new Error('Too many OTP requests — wait before trying again.');
    throw new Error(`Send OTP failed (${result.response.status}) ${result.data?.ERROR_MESSAGE || result.data?.RESPONSE?.errorMessage || ''}`.trim());
  }
  const requestId = result.data?.RESPONSE?.requestId || result.data?.requestId || result.data?.['REQUEST-ID'];
  if (!requestId) throw new Error('OTP sent but Flipkart returned no request ID.');
  loginSession.requestId = String(requestId);
  loginSession.phone = phone;
  armLoginTimeout();
  return { requestId: loginSession.requestId, emailMask: result.data?.RESPONSE?.emailMask, smsServers: result.data?.RESPONSE?.smsServers };
}

async function verifyLoginOtp(rawPhone, rawOtp, requestId) {
  const phone = normalizeLoginId(rawPhone);
  const otp = String(rawOtp || '').trim();
  if (!otp) throw new Error('Enter the OTP.');
  if (!requestId || requestId !== loginSession?.requestId || phone !== loginSession?.phone) throw new Error('This OTP request has expired. Send a new OTP.');
  const result = await loginFetch('/api/1/user/login/otp', { userId: phone, requestId, otp });
  if (![200, 302].includes(result.response.status)) throw new Error(`Verify OTP failed (${result.response.status}) ${result.data?.ERROR_MESSAGE || ''}`.trim());
  const errorMessage = result.data?.RESPONSE?.errorMessage || result.data?.RESPONSE?.error;
  if (errorMessage) throw new Error(String(errorMessage));
  await new Promise((resolve) => setTimeout(resolve, 250));
  const cookies = await browserCookies();
  if (!cookies.some((cookie) => cookie.name === 'at' && cookie.value?.length >= 10)) throw new Error('OTP verified but no Flipkart session token was created.');
  return cookies;
}

function parseCookieHeader(raw) {
  return String(raw || '')
    .split(/;\s*/)
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf('=');
      if (separator < 1) return null;
      const name = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      if (!name) return null;
      return {
        name,
        value,
        domain: '.flipkart.com',
        path: '/',
        secure: true,
        httpOnly: false,
        expirationDate: Math.floor(Date.now() / 1000) + 86400,
      };
    })
    .filter(Boolean);
}

function installElectronChromeBridge() {
  global.chrome = {
    cookies: { getAll: browserCookies },
    runtime: {
      sendMessage: async (message) => {
        if (!message) return { ok: false, error: 'Empty runtime message' };
        if (message.type === 'LOG') {
          emit({ kind: message.kind || 'info', text: message.text || '' });
          return { ok: true };
        }
        if (message.type === 'UPI_QR_READY') {
          emit({ kind: 'action', text: `[${message.accountName || 'browser'}] UPI QR ready · scan in the payment window` });
          mainWindow?.webContents.send('snipe:upi', message);
          return { ok: true };
        }
        if (message.type === 'ACCOUNT_SESSION_START') {
          checkoutContexts.set(message.ctxId, { cookies: message.cookies || [], accountId: message.accountId || null });
          return { ok: true };
        }
        if (message.type === 'ACCOUNT_SESSION_END') {
          const ctx = checkoutContexts.get(message.ctxId);
          const cookies = ctx?.cookies ? [...ctx.cookies] : [];
          checkoutContexts.delete(message.ctxId);
          return { ok: true, cookies };
        }
        if (message.type === 'FK_FETCH') {
          const ctx = checkoutContexts.get(message.ctxId);
          const cookies = ctx?.cookies?.length ? ctx.cookies : await browserCookies();
          const headers = { ...(message.headers || {}), Cookie: cookieHeader(cookies) };
          const response = await fetch(message.url, {
            method: message.method || 'GET',
            headers,
            body: message.body,
            redirect: 'follow',
            signal: AbortSignal.timeout(FETCH_TIMEOUT.checkout),
          });
          const setCookies = typeof response.headers.getSetCookie === 'function'
            ? response.headers.getSetCookie()
            : [];
          if (ctx) mergeSetCookies(ctx, setCookies, message.url);
          return {
            ok: true,
            status: response.status,
            statusText: response.statusText,
            finalUrl: response.url,
            bodyText: await response.text(),
          };
        }
        return { ok: true };
      },
    },
  };
}

async function loadCheckoutEngine() {
  if (!engineReady) {
    installElectronChromeBridge();
    engineReady = (async () => {
      const schema = await import('./engine/schema.js');
      DC_POOL = schema.DC_POOL;
      const co = await import('./engine/checkout.js');
      runCheckout = co.runCheckout;
      return co;
    })();
  }
  return engineReady;
}

function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Target…', accelerator: 'CmdOrCtrl+N', click: () => mainWindow?.webContents.executeJavaScript(`document.getElementById('url')?.focus()`) },
        { label: 'Import Data…', click: async () => { const win = mainWindow; if (!win) return; const result = await ipcMain._invokeHandlerForTest?.('data:import-extension') || null; if (!result) win.webContents.send('snipe:menu', { action: 'import' }); } },
        { label: 'Export Data…', click: () => mainWindow?.webContents.send('snipe:menu', { action: 'export' }) },
        { type: 'separator' },
        { label: 'Engage / Stop', accelerator: 'CmdOrCtrl+E', click: () => mainWindow?.webContents.send('snipe:menu', { action: 'engage-toggle' }) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      role: 'window',
      submenu: [{ role: 'minimize' }, ...(isMac ? [{ role: 'zoom' }] : []), { role: 'close' }],
    },
    {
      role: 'help',
      submenu: [
        { label: 'About Snipe Desktop', click: () => dialog.showMessageBox(mainWindow, { type: 'info', title: 'Snipe Desktop', message: `Snipe Desktop ${app.getVersion()}`, detail: 'Parallel Flipkart flash-checkout control surface.\n\nAll state is stored locally and sensitive fields (Telegram token, account cookies) are encrypted with the OS keychain via Electron safeStorage.' }) },
        { label: 'Architecture Notes', click: () => shell.openPath(path.join(__dirname, 'README.md')) },
        { label: 'Open State Folder', click: () => shell.openPath(app.getPath('userData')) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createMainWindow() {
  mainWindow = new BrowserWindow({ width: 1180, height: 820, minWidth: 920, minHeight: 650,
    backgroundColor: '#0a0a0b', icon: path.join(__dirname, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  mainWindow.loadFile('index.html');
  // Hide-to-tray on close: keep the poller alive in the background.
  mainWindow.on('close', (event) => {
    if (isQuitting || !tray) return;
    event.preventDefault();
    mainWindow.hide();
  });
}

function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) { createMainWindow(); return; }
  if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
  else { mainWindow.show(); mainWindow.focus(); }
}

function createTray() {
  if (tray) return;
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
    tray = new Tray(img.isEmpty() ? nativeImage.createFromPath(path.join(__dirname, 'icon.ico')) : img);
    tray.setToolTip('Snipe Desktop');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show / Hide', click: toggleWindow },
      { type: 'separator' },
      { label: 'Engage / Stop', click: () => mainWindow?.webContents.send('snipe:menu', { action: 'engage-toggle' }) },
      { label: 'Stop All Lanes', click: () => mainWindow?.webContents.send('snipe:menu', { action: 'stop-all' }) },
      { type: 'separator' },
      { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
    ]));
    tray.on('click', toggleWindow);
  } catch (err) {
    console.warn('[Snipe/tray] failed to create tray icon —', err.message);
    tray = null;
  }
}

function isPaymentUrl(url) {
  try {
    const parsed = new URL(url);
    return /(^|\.)flipkart\.com$/.test(parsed.hostname) && /\/payments?(\/|\?|$)/i.test(parsed.pathname + parsed.search);
  } catch { return false; }
}

function openPaymentWindow(target, url, upiPending = null) {
  const existing = paymentWindows.get(target.id);
  if (existing && !existing.isDestroyed()) {
    existing.loadURL(url);
    existing.focus();
    return existing;
  }
  const partition = `persist:snipe-payment-${String(target.id).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const paymentSession = session.fromPartition(partition);
  const win = new BrowserWindow({
    width: 1150,
    height: 820,
    title: `Snipe · Payment · ${target.name}`,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, partition }
  });
  paymentWindows.set(target.id, win);
  win.on('closed', () => { paymentWindows.delete(target.id); paymentReadyProducts.delete(target.productId); });
  win.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
    if (isPaymentUrl(popupUrl)) { openPaymentWindow(target, popupUrl); return { action: 'deny' }; }
    shell.openExternal(popupUrl);
    return { action: 'deny' };
  });
  win.webContents.on('did-finish-load', () => {
    if (!upiPending) return;
    // Let Flipkart render its own QR. Bail as soon as the page navigates away
    // from /payments, only match real buttons (not arbitrary divs/spans), and
    // cap attempts so the clicker can't run indefinitely.
    win.webContents.executeJavaScript(`(() => {
      if (window.__snipeUqiAutomation) return;
      window.__snipeUqiAutomation = true;
      let attempts = 0;
      const timer = setInterval(() => {
        attempts++;
        if (!/\\/payments?(\\/|\\?|$)/i.test(location.pathname + location.search)) { clearInterval(timer); return; }
        const elements = [...document.querySelectorAll('button,[role="button"]')];
        const showQr = elements.find((el) => /^\\s*(show|view|generate)\\s+(upi\\s+)?qr\\s*$/i.test(el.innerText || el.textContent || ''));
        if (showQr) { showQr.click(); clearInterval(timer); return; }
        const upi = elements.find((el) => /^\\s*upi\\s*$/i.test(el.innerText || el.textContent || ''));
        if (upi && attempts % 4 === 0) upi.click();
        if (attempts > 30) clearInterval(timer);
      }, 500);
    })()`);
  });
  const cookies = target.accountCookies || [];
  Promise.all(cookies.map((cookie) => {
    const domain = (cookie.domain || 'flipkart.com').replace(/^\./, '');
    return paymentSession.cookies.set({
      url: `${cookie.secure === false ? 'http' : 'https'}://${domain}${cookie.path || '/'}`,
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || '/',
      secure: cookie.secure !== false,
      httpOnly: !!cookie.httpOnly,
    }).catch(() => {});
  })).finally(() => win.loadURL(url));
  emit({ kind: 'hit', text: `Payment page opened separately for ${target.name}` });
  return win;
}

function openTarget(target) {
  const win = new BrowserWindow({ width: 1100, height: 780, title: `Snipe · ${target.name}`, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  targetWindows.set(target.id, win);
  win.on('closed', () => targetWindows.delete(target.id));
  win.webContents.on('will-navigate', (event, url) => {
    if (!isPaymentUrl(url)) return;
    event.preventDefault();
    openPaymentWindow(target, url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isPaymentUrl(url)) { openPaymentWindow(target, url); return { action: 'deny' }; }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL(target.url);
  emit({ kind: 'action', text: `Opened ${target.name} in lane ${target.lane}` });
}

function checkoutConfig(config = {}) {
  const out = {
    pmode: config.paymentMode || 'off',
    pincode: config.pincode || '',
    qty: Math.max(1, Number(config.quantity) || 1),
    poll_interval: Number(config.pollInterval) || 3,
    bank: config.bank || '',
    vpa: config.vpa || '',
    addressId: config.addressId || '',
    addressPincode: config.addressPincode || '',
    conditional_buy: !!config.conditionalBuy,
    supercoins_apply: !!config.supercoins,
    GST_apply: !!config.gst,
    affid: config.affiliateId || 'growthte',
    affExtParam2: config.affiliateExtParam || '1215048',
    deferUpi: config.paymentMode === 'upi',
  };
  if (out.pmode === 'creditcard') {
    const state = readState();
    const card = (state.cards || []).find((c) => c.id === state.selectedCardId);
    if (card && card.number && card.expiry && card.cvv) {
      out.card = { number: card.number, expiry: card.expiry, cvv: card.cvv };
    }
  }
  return out;
}

function openUpiWindow(target, pending) {
  const existing = upiWindows.get(target.id);
  if (existing && !existing.isDestroyed()) { existing.focus(); return existing; }
  const win = new BrowserWindow({ width: 430, height: 650, title: `Snipe · UPI QR · ${target.name}`, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  upiWindows.set(target.id, win);
  win.on('closed', () => upiWindows.delete(target.id));
  win.loadFile('upi.html');
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(`window.renderUpi(${JSON.stringify({
      accountName: target.name,
      qrCode: pending.qr_code || '',
      upiIntent: pending.upi_intent || '',
      pollingText: pending.polling_text || 'Scan to pay',
      expiry: pending.expiry_time || '',
    })})`);
  });
  return win;
}

function pushUpiStatus(paymentTarget, payload) {
  const win = upiWindows.get(paymentTarget.id);
  if (win && !win.isDestroyed()) {
    win.webContents.executeJavaScript(`window.snipeUpiUpdate(${JSON.stringify(payload)})`).catch(() => {});
  }
  mainWindow?.webContents.send('snipe:upi-status', { targetId: paymentTarget.id, ...payload });
}

async function pollUpiCompletion(paymentTarget, pending, account) {
  const engine = await loadCheckoutEngine();
  try {
    const result = await engine.completeUpiPayment(pending, account);
    if (result?.ok && result.headless) {
      pushUpiStatus(paymentTarget, { kind: 'success', orderRef: result.orderRef || null });
      const win = upiWindows.get(paymentTarget.id);
      if (win && !win.isDestroyed()) setTimeout(() => { if (!win.isDestroyed()) win.close(); }, 3000);
      const msg = `UPI order placed · ${paymentTarget.name}${result.orderRef ? ` · ${result.orderRef}` : ''}`;
      emit({ kind: 'ok', text: msg });
      telegramAlert(`UPI order placed\n${paymentTarget.name}${result.orderRef ? `\nOrder: ${result.orderRef}` : ''}`, 'placed');
      recordOrder({ orderRef: result.orderRef, target: paymentTarget, accountName: account?.name || 'browser', grandTotal: null });
    } else {
      const reason = result?.reason || 'UPI payment did not complete';
      pushUpiStatus(paymentTarget, { kind: 'failed', reason });
      emit({ kind: 'err', text: `UPI payment failed · ${paymentTarget.name} · ${reason}` });
      telegramAlert(`UPI payment failed\n${paymentTarget.name}\n${reason}`, 'failed');
    }
  } catch (err) {
    pushUpiStatus(paymentTarget, { kind: 'failed', reason: err.message });
    emit({ kind: 'err', text: `UPI polling error · ${paymentTarget.name} · ${err.message}` });
  }
}

function broadcastLanes() {
  mainWindow?.webContents.send('snipe:lanes', [...laneStates.values()]);
}
function updateLane(id, patch) {
  const previous = laneStates.get(id) || { id, phase: 'queued', startedAt: Date.now() };
  laneStates.set(id, { ...previous, ...patch, id });
  broadcastLanes();
}
function clearLanes() { laneStates.clear(); broadcastLanes(); }

// Spread lanes across Flipkart DCs so N concurrent identical POSTs during a
// drop aren't all hitting the same shard (which returns 500 under load and
// signals a bot pattern). Random per-fanout offset so consecutive drops
// don't hit the same rotation. DC_POOL is loaded from engine/schema.js.
async function runParallelCheckout(targets, config) {
  await loadCheckoutEngine();
  const state = readState();
  const accounts = state.accounts || [];
  // Snapshot the active Electron session once. Passing a private cookie jar to
  // every job prevents parallel targets from observing a session mutation made
  // by another checkout attempt.
  const sessionCookies = accounts.length ? null : await browserCookies();
  const jobs = accounts.length
    ? targets.flatMap((target) => accounts.map((account) => ({ target, account })))
    : targets.map((target) => ({
        target,
        account: { id: `browser-${target.id}`, name: 'current session', cookies: [...sessionCookies] },
      }));
  const seenJobs = new Set();
  const uniqueJobs = jobs.filter((job) => {
    const key = `${job.target.productId || job.target.id}:${job.account?.id || 'browser'}`;
    if (seenJobs.has(key)) return false;
    seenJobs.add(key);
    return true;
  });
  if (uniqueJobs.length !== jobs.length) {
    emit({ kind: 'info', text: `Skipped ${jobs.length - uniqueJobs.length} duplicate checkout lane${jobs.length - uniqueJobs.length === 1 ? '' : 's'}` });
  }
  jobs.splice(0, jobs.length, ...uniqueJobs);
  const dcOffset = Math.floor(Math.random() * DC_POOL.length);
  jobs.forEach((job, i) => {
    job.startDc = DC_POOL[(i + dcOffset) % DC_POOL.length];
    job.jobId = `${job.target.productId || job.target.id}:${job.account?.id || 'browser'}`;
    const label = job.account ? `${job.target.name} · ${job.account.name}` : job.target.name;
    updateLane(job.jobId, { label, phase: 'queued', detail: `DC=${job.startDc}`, startedAt: Date.now() });
  });
  const limit = Math.max(1, Math.min(Number(config.parallelism) || 1, jobs.length || 1));
  let cursor = 0;
  const worker = async (lane) => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      const label = job.account ? `${job.target.name} · ${job.account.name}` : job.target.name;
      const laneJitterMs = 40 + Math.floor(Math.random() * 81);
      await delay(laneJitterMs);
      updateLane(job.jobId, { phase: 'running', detail: `lane ${lane} · DC=${job.startDc}` });
      emit({ kind: 'action', text: `Lane ${lane} starting ${label} · DC=${job.startDc} · jitter=${laneJitterMs}ms` });
      try {
        emit({ kind: 'action', text: `Checkout flow started · ${label}` });
        const result = await runCheckout(job.target, checkoutConfig(config), job.account, { startDc: job.startDc });
        if (result?.openTab?.target) {
          // Key on productId (stable) so the persist:snipe-payment-* partition
          // is reused for the same product/account instead of leaking one on
          // every import (target.id can be regenerated during import).
          const paymentTarget = { ...job.target, id: `${job.target.productId}:${job.account?.id || 'browser'}`, name: label, accountCookies: job.account?.cookies || [] };
          paymentReadyProducts.add(job.target.productId);
          openPaymentWindow(paymentTarget, result.openTab.target);
          updateLane(job.jobId, { phase: 'payment', detail: 'manual page opened' });
        } else if (result?.upiPending) {
          const paymentTarget = { ...job.target, id: `${job.target.productId}:${job.account?.id || 'browser'}`, name: label, accountCookies: job.account?.cookies || [] };
          paymentReadyProducts.add(job.target.productId);
          const paymentUrl = `https://www.flipkart.com/payments?isRevampedDesktopView=true&token=${encodeURIComponent(result.upiPending.token || '')}`;
          openPaymentWindow(paymentTarget, paymentUrl, result.upiPending);
          openUpiWindow(paymentTarget, result.upiPending);
          emit({ kind: 'action', text: `Flipkart payment page and dedicated UPI QR opened for ${label}` });
          updateLane(job.jobId, { phase: 'upi', detail: 'QR delivered' });
          // Poll the UPI transaction so the small QR window reflects
          // success/failure and closes on payment confirmation. Fire and
          // forget — the worker moves on to the next lane.
          pollUpiCompletion(paymentTarget, result.upiPending, job.account)
            .then(() => updateLane(job.jobId, { phase: 'done', detail: 'UPI paid' }))
            .catch((err) => updateLane(job.jobId, { phase: 'error', detail: err.message }));
        }
        if (result?.headless) {
          paymentReadyProducts.add(job.target.productId);
          const text = result.orderRef
            ? `Order confirmed\n${label}\nOrder: ${result.orderRef}`
            : `Order submitted and confirmed\n${label}\nOrder ID unavailable in response; verify in Flipkart Orders`;
          emit({ kind: 'ok', text: text.replace(/\n/g, ' · ') });
          telegramAlert(text, 'placed');
          updateLane(job.jobId, { phase: 'done', detail: result.orderRef || 'placed' });
          recordOrder({ orderRef: result.orderRef, target: job.target, accountName: job.account?.name, grandTotal: result.grandTotal });
        }
        else if (!result?.openTab && !result?.upiPending) {
          emit({ kind: 'hit', text: `Checkout ready: ${label}` });
          updateLane(job.jobId, { phase: 'done', detail: 'ready' });
        }
      } catch (error) {
        const reason = error?.message || String(error);
        emit({ kind: 'err', text: `Failed: ${label} · ${reason}` });
        telegramAlert(`Checkout failed\n${label}\n${reason}`, 'failed');
        updateLane(job.jobId, { phase: 'error', detail: reason });
      } finally {
        // Persist refreshed session cookies (at/fk_ts etc.) back onto the saved
        // account so logins survive Flipkart's periodic token rotation.
        const accountId = job.account?.id;
        if (accountId && !String(accountId).startsWith('browser-')
            && Array.isArray(job.account.cookies) && job.account.cookies.length) {
          const current = readState();
          const idx = (current.accounts || []).findIndex((a) => a.id === accountId);
          if (idx >= 0) {
            current.accounts[idx] = { ...current.accounts[idx], cookies: job.account.cookies };
            writeState(current);
          }
        }
      }
    }
  };
  await Promise.all(Array.from({ length: limit }, (_, index) => worker(index + 1)));
  emit({ kind: 'ok', text: `Parallel checkout run complete · ${jobs.length} job${jobs.length === 1 ? '' : 's'}` });
}

async function runTrackingLoop(targets, config, runId) {
  const initialState = readState();
  const initialConfig = { ...config, ...initialState.settings };
  const pincode = String(initialConfig.pincode || '').trim();
  if (!/^\d{6}$/.test(pincode)) {
    emit({ kind: 'err', text: 'Tracking paused · enter a valid 6-digit delivery pincode' });
    return;
  }
  emit({ kind: 'action', text: `API tracking active · ${targets.length} target${targets.length === 1 ? '' : 's'} · every ${initialConfig.pollInterval || 3}s · ${pincode}` });
  let emptyPolls = 0;
  while (trackingActive && trackingRunId === runId) {
    try {
      // Reload the watchlist every cycle so targets added while engaged are
      // included without stopping/restarting the tracker.
      const liveState = readState();
      const liveTargets = liveState.targets || [];
      const liveConfig = { ...config, ...liveState.settings };
      const targetKey = (items) => items.map((item) => item.productId || item.id).join('|');
      if (targetKey(liveTargets) !== targetKey(targets)) {
        targets = liveTargets;
        emit({ kind: 'info', text: `Watchlist updated · ${targets.length} target${targets.length === 1 ? '' : 's'}` });
      }
      const livePincode = String(liveConfig.pincode || '').trim();
      if (!/^\d{6}$/.test(livePincode)) {
        emit({ kind: 'warn', text: 'API poll skipped · enter a valid 6-digit delivery pincode' });
        await delay(1000);
        continue;
      }
      const available = await pollServiceability(targets, livePincode);
      const hits = available.filter((target) => !checkoutInFlight.has(target.productId)
        && !paymentReadyProducts.has(target.productId));
      if (hits.length) {
        emptyPolls = 0;
        hits.forEach((target) => checkoutInFlight.add(target.productId));
        emit({ kind: 'hit', text: `${hits.length} target${hits.length === 1 ? '' : 's'} available · starting checkout` });
        runParallelCheckout(hits, liveConfig)
          .catch((error) => emit({ kind: 'err', text: `Checkout engine stopped · ${error.message}` }))
          .finally(() => hits.forEach((target) => checkoutInFlight.delete(target.productId)));
      } else if (++emptyPolls % 10 === 0) {
        emit({ kind: 'info', text: `API poll healthy · no available/serviceable target yet · ${targets.length} watched` });
      }
    } catch (error) {
      emit({ kind: 'warn', text: `API poll failed · ${error.message}` });
    }
    const currentInterval = Number(readState().settings?.pollInterval || config.pollInterval || 3);
    await delay(Math.max(1000, currentInterval * 1000));
  }
  emit({ kind: 'info', text: 'API tracking stopped' });
}

ipcMain.handle('state:get', () => readState());
ipcMain.handle('state:save', (_, state) => { writeState(state); return state; });
ipcMain.handle('account:capture-current', async () => {
  try {
    const cookies = await browserCookies();
    if (!cookies.length) return { ok: false, error: 'No Flipkart cookies found. Sign in through Open session first.' };
    return { ok: true, cookies };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('account:parse-cookies', (_, raw) => {
  const cookies = parseCookieHeader(raw);
  return cookies.length
    ? { ok: true, cookies }
    : { ok: false, error: 'Paste a valid Cookie header, for example: session_id=...; ...' };
});
ipcMain.handle('login:send-otp', async (_, rawPhone) => {
  try {
    return { ok: true, ...(await sendLoginOtp(rawPhone)) };
  } catch (error) {
    await endLoginSession({ restore: true });
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('login:verify-otp', async (_, payload) => {
  try {
    const cookies = await verifyLoginOtp(payload?.phone, payload?.otp, payload?.requestId);
    await endLoginSession({ restore: true });
    return { ok: true, cookies, cookieCount: cookies.length };
  } catch (error) {
    await endLoginSession({ restore: true });
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('login:cancel', async () => {
  await endLoginSession({ restore: true });
  return { ok: true };
});
ipcMain.handle('data:import-extension', async () => {
  const picked = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'JSON export', extensions: ['json'] }] });
  if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true };
  try {
    const raw = JSON.parse(fs.readFileSync(picked.filePaths[0], 'utf8'));
    const imported = {
      targets: raw.targets || raw.watchlist || [],
      accounts: raw.accounts || [],
      cards: raw.cards || raw.saved_cards || [],
      selectedCardId: raw.selectedCardId || raw.selected_card_id || null,
      events: raw.events || [],
      settings: { ...raw.settings, ...(raw.sync || {}) },
    };
    const state = readState();
    const targets = [...state.targets, ...imported.targets.map((t) => ({ ...t, id: t.id || `target_${t.productId || `${Date.now()}_${Math.random()}`}` }))]
      .filter((t, i, all) => all.findIndex((x) => (x.productId || x.id) === (t.productId || t.id)) === i);
    const seenAccountIds = new Set(state.accounts.map((a) => a.id).filter(Boolean));
    const newAccounts = imported.accounts.filter((a) => !seenAccountIds.has(a.id));
    const merged = { ...state, ...imported, targets, accounts: [...state.accounts, ...newAccounts] };
    writeState(merged);
    return { ok: true, state: merged };
  } catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('data:export-desktop', async () => {
  const picked = await dialog.showSaveDialog({ defaultPath: 'snipe-desktop-backup.json', filters: [{ name: 'Snipe data', extensions: ['json'] }] });
  if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
  try { fs.writeFileSync(picked.filePath, JSON.stringify(readState(), null, 2)); return { ok: true, path: picked.filePath }; }
  catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('session:open', () => {
  if (sessionWindow && !sessionWindow.isDestroyed()) { sessionWindow.focus(); return true; }
  sessionWindow = new BrowserWindow({ width: 1200, height: 800, title: 'Flipkart session', webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  sessionWindow.on('closed', () => { sessionWindow = null; });
  sessionWindow.webContents.on('will-navigate', (event, url) => {
    if (url === 'snipe://close') { event.preventDefault(); sessionWindow.close(); }
  });
  const injectSessionToolbar = () => {
    sessionWindow.webContents.insertCSS(`
      #snipe-session-toolbar{position:fixed;z-index:2147483647;top:10px;left:10px;display:flex;gap:6px;padding:6px;background:#14141aee;border:1px solid #f59e0b;color:#e5e7eb;font:12px ui-monospace,Consolas,monospace;border-radius:4px}
      #snipe-session-toolbar button{background:#0a0a0b;color:#f59e0b;border:1px solid #51401d;padding:6px 10px;cursor:pointer}
      #snipe-session-toolbar button:hover{background:#2a2110}
    `);
    sessionWindow.webContents.executeJavaScript(`(() => {
      document.getElementById('snipe-session-toolbar')?.remove();
      const bar=document.createElement('div'); bar.id='snipe-session-toolbar';
      bar.innerHTML='<button onclick="history.back()">← BACK</button><button onclick="history.forward()">FORWARD →</button><button onclick="location.href=\'snipe://close\'">CLOSE SESSION</button>';
      document.body.appendChild(bar);
    })()`);
  };
  sessionWindow.webContents.on('did-finish-load', injectSessionToolbar);
  sessionWindow.webContents.on('did-navigate-in-page', injectSessionToolbar);
  sessionWindow.loadURL('https://www.flipkart.com');
  return true;
});
ipcMain.handle('targets:launch', async (_, payload) => {
  const { targets, config } = payload;
  trackingActive = true;
  trackingRunId += 1;
  const runId = trackingRunId;
  emit({ kind: 'ok', text: `API tracking started for ${targets.length} target${targets.length === 1 ? '' : 's'} across parallel lanes` });
  runTrackingLoop(targets, config, runId).catch((error) => emit({ kind: 'err', text: `API tracking stopped · ${error.message}` }));
  return true;
});
ipcMain.handle('targets:close', () => {
  trackingActive = false;
  trackingRunId += 1;
  for (const win of targetWindows.values()) win.close();
  for (const win of paymentWindows.values()) win.close();
  for (const win of upiWindows.values()) win.close();
  targetWindows.clear();
  paymentWindows.clear();
  upiWindows.clear();
  paymentReadyProducts.clear();
  checkoutInFlight.clear();
  clearLanes();
  emit({ kind: 'warn', text: 'All target and payment lanes stopped' });
  return true;
});
ipcMain.handle('telegram:test', async () => telegramSend('Snipe Desktop · Telegram test alert · ' + new Date().toLocaleString()));
ipcMain.handle('lanes:stop', (_, jobId) => {
  // Per-lane cancel of an in-flight checkout requires engine-level abort
  // support; not wired yet. For now, mark the lane as cancelled in the UI so
  // the user gets feedback and drop it from the map on next full stop.
  if (!jobId) return { ok: false, error: 'lane id missing' };
  const entry = laneStates.get(jobId);
  if (!entry) return { ok: false, error: 'lane not found' };
  updateLane(jobId, { phase: 'error', detail: 'cancel requested (in-flight jobs finish)' });
  return { ok: true };
});

app.whenReady().then(() => {
  if (!singleInstance) return;
  hydrateState();
  buildAppMenu();
  createMainWindow();
  createTray();
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createMainWindow(); });
});
app.on('before-quit', () => {
  isQuitting = true;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  flushStateNow();
});
app.on('window-all-closed', () => {
  // With a tray icon we keep running so the tracker survives window close.
  if (!tray && process.platform !== 'darwin') app.quit();
});
