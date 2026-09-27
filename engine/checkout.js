import { MSG, DC_POOL } from './schema.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const X_UA_DESKTOP = UA + ' FKUA/website/42/website/Desktop';

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
}

// Per-checkout session context. Owns the isolated cookie jar and the DC state
// so multiple parallel checkouts against different accounts can't step on
// each other. `id` is a unique tag sent on every outbound request via
// `X-Snipe-Ctx-Id`; background's webRequest listeners key Set-Cookie captures
// by this id so we can flush them back into the right per-account jar.
let _ctxCounter = 0;
// DC_POOL is imported from schema.js — starting each lane on a different DC
// turns N concurrent identical POSTs against DC=2 into ceil(N/5) per DC, and
// breaks the "same IP hitting same shard N times in one tick" bot signature
// that Flipkart Shield keys on during flash drops.
export function createCheckoutContext(account, opts = {}) {
  return {
    id: `ctx-${Date.now().toString(36)}-${++_ctxCounter}`,
    jar: account?.cookies ? [...account.cookies] : [],
    dc: opts.startDc || 2,
    name: account?.name || 'default',
    accountId: account?.id || null,
  };
}

// Snapshot the browser's Flipkart cookies into a fresh jar — used when no
// account is selected, so the "use current browser session" flow keeps working
// while still going through the jar-explicit transport.
export async function snapshotBrowserJar() {
  if (!chrome.cookies?.getAll) return [];
  try { return await chrome.cookies.getAll({ domain: 'flipkart.com' }); }
  catch (e) { console.warn('[Snipe/co] browser jar snapshot failed', e.message); return []; }
}

function logToPopup(text, kind = 'info') {
  chrome.runtime.sendMessage({ type: MSG.LOG, text, kind }).catch(() => {});
}

// ─── HTTP transport ────────────────────────────────────────────

// All Flipkart fetches are routed through the service worker via FK_FETCH.
// Cookie is a forbidden Fetch request header, so JavaScript cannot attach a
// saved account's cookie string manually. The service worker temporarily
// installs the requested account into Chrome's managed cookie jar and uses
// credentials: 'include'. Account runs are serialized in offscreen.js.
async function fkFetch(ctx, url, init = {}) {
  const headers = { 'X-Snipe-Ctx-Id': ctx.id, ...(init.headers || {}) };
  const r = await chrome.runtime.sendMessage({
    type: 'FK_FETCH',
    ctxId: ctx.id,
    url,
    method: init.method || 'GET',
    headers,
    body: init.body,
  });
  if (!r?.ok) throw new Error(`FK_FETCH failed: ${r?.error || 'unknown'}`);
  const response = new Response(r.bodyText, { status: r.status, statusText: r.statusText });
  Object.defineProperty(response, 'finalUrl', { value: r.finalUrl || url });
  return response;
}

// Full "browser-realistic" header set derived from thefksuite reference —
// /api/5/checkout returns 401 with sparse headers even when cookies auth.
// Cart/viewcart don't check, so we couldn't spot the missing headers earlier.
const FK_DEFAULT_HEADERS = {
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Content-Type': 'application/json',
  'Origin': 'https://www.flipkart.com',
  'Referer': 'https://www.flipkart.com/',
  'DNT': '1',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
  'User-Agent': UA,
  'X-User-Agent': X_UA_DESKTOP,
};

async function fkRomeFetch(ctx, path, init = {}, depth = 0) {
  const url = path.startsWith('http')
    ? path
    : `https://${ctx.dc}.rome.api.flipkart.com${path}`;
  const headers = { ...FK_DEFAULT_HEADERS, ...(init.headers || {}) };
  const res = await fkFetch(ctx, url, { ...init, headers });
  let data = null;
  try { data = await res.json(); } catch {}

  if (res.status === 406 && data?.ERROR_MESSAGE === 'DC Change' && depth < 3) {
    const newDC = data?.META_INFO?.dcInfo?.id || data?.RESPONSE?.id;
    if (newDC && newDC !== ctx.dc) {
      ctx.dc = newDC;
      console.log(`[Snipe/co:${ctx.name}] rome DC →`, ctx.dc);
      return fkRomeFetch(ctx, path, init, depth + 1);
    }
  }
  return { res, data };
}

// v5-style headers required by newer /fkpay endpoints. Omitting the
// x-device-details / x-payment-revamp / x-device-source trio returns
// INTERNAL_SERVER_ERROR from instrument/select (per Thefksuite reference).
const DEVICE_DETAILS_JSON = JSON.stringify({ channel: 'web', platform: 'web', appVersion: 0 });
function paymentsHeaders(token) {
  return {
    'Content-Type': 'application/json',
    'X-User-Agent': X_UA_DESKTOP,
    'device-details': DEVICE_DETAILS_JSON,
    'x-device-details': DEVICE_DETAILS_JSON,
    'user-language': 'en',
    'x-user-language': 'en',
    'x-device-source': 'web',
    'x-payment-revamp': 'm1',
    'x-client-trace-id': uuid(),
    'x-trace-id': uuid(),
    'x-session-id': uuid(),
    ...(token ? { token } : {}),
    'Referer': `https://www.flipkart.com/payments?isRevampedDesktopView=true${token ? `&token=${encodeURIComponent(token)}` : ''}`,
    'Origin': 'https://www.flipkart.com',
    'Sec-Fetch-Site': 'same-site',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
  };
}

async function fkPaymentsFetch(ctx, path, init = {}, token = null, depth = 0) {
  const url = path.startsWith('http')
    ? path
    : `https://${ctx.dc}.payments.flipkart.com${path}`;
  const headers = { ...paymentsHeaders(token), ...(init.headers || {}) };
  const res = await fkFetch(ctx, url, { ...init, headers });
  let data = null;
  try { data = await res.json(); } catch {}

  if (res.status === 406 && data?.ERROR_MESSAGE === 'DC Change' && depth < 3) {
    const newDC = data?.META_INFO?.dcInfo?.id || data?.RESPONSE?.id;
    if (newDC && newDC !== ctx.dc) {
      ctx.dc = newDC;
      console.log(`[Snipe/co:${ctx.name}] payments DC →`, ctx.dc);
      return fkPaymentsFetch(ctx, path, init, token, depth + 1);
    }
  }
  return { res, data };
}

// ─── Cart / checkout ───────────────────────────────────────────

async function resolveListingId(ctx, productUrl) {
  const body = JSON.stringify({
    pageUri: productUrl,
    pageContext: { trackingContext: { context: { eVar61: 'direct_product' } } },
    locationContext: { pincode: null, changed: false },
  });
  const { data } = await fkRomeFetch(ctx, '/api/4/page/fetch?cacheFirst=false', {
    method: 'POST', body,
  });
  const lst = data?.RESPONSE?.pageData?.pageContext?.listingId;
  if (!lst) throw new Error('Failed to resolve listing id');
  return lst;
}

// Flipkart's saved-address API (the dedicated /addresses routes are gone).
// This is intentionally kept separate from checkout address selection below:
// adding an address creates a persistent contact, while selecting one changes
// only the active checkout session.
export async function addAddress(ctx, addressData) {
  const required = ['name', 'addressLine1', 'city', 'state', 'pincode', 'phone'];
  for (const key of required) {
    if (!String(addressData?.[key] ?? '').trim()) throw new Error(`Address field missing: ${key}`);
  }
  const body = JSON.stringify({
    name: String(addressData.name).trim(),
    addressLine1: String(addressData.addressLine1).trim(),
    addressLine2: String(addressData.addressLine2 || '').trim(),
    landmark: String(addressData.landmark || '').trim(),
    city: String(addressData.city).trim(),
    state: String(addressData.state).trim(),
    pincode: String(addressData.pincode).trim(),
    phone: String(addressData.phone).trim(),
    locationTypeTag: addressData.locationTypeTag === 'WORK' ? 'WORK' : 'HOME',
  });
  const { res, data } = await fkRomeFetch(ctx, '/api/3/user/contact', {
    method: 'POST', body,
    headers: { 'flipkart_secure': 'true' },
  });
  if (res.status < 200 || res.status >= 300 || data?.STATUS_CODE >= 400) {
    throw new Error(data?.ERROR_MESSAGE || data?.RESPONSE?.errorMessage || `Address add failed (HTTP ${res.status})`);
  }
  return data;
}

export async function switchCheckoutAddress(ctx, cartItemRefID, addressId, pincode) {
  if (!cartItemRefID || !addressId) throw new Error('Checkout address switch needs cartItemRefID and addressId.');
  const pageUri = '/viewcheckout?view=FLIPKART&marketplace=FLIPKART';
  const body = JSON.stringify({
    pageUri,
    pageContext: {
      fetchAllPages: true, networkSpeed: 10000, pageNumber: 1,
      paginatedFetch: false, trackingContext: { context: { eVar61: '' } },
    },
    actionRequestContext: {
      actionContext: {},
      checkoutUpsertGroupRequest: {
        cartItemRefIds: [cartItemRefID],
        contactId: addressId,
        preferredMarketplace: 'FLIPKART',
      },
      expressCoFlow: false,
      isPartialPageLoadEnabled: false,
      pageNumber: 0,
      pageUri,
      type: 'CHECKOUT_CHANGE_SHIPPING_ADDRESS',
    },
    locationContext: { changed: false, pincode: Number(pincode) || 0 },
  });
  const { res, data } = await fkRomeFetch(ctx, '/api/1/action/view', {
    method: 'POST', body,
    headers: { 'flipkart_secure': 'true' },
  });
  if (res.status < 200 || res.status >= 300 || data?.STATUS_CODE >= 400) {
    throw new Error(data?.ERROR_MESSAGE || data?.RESPONSE?.errorMessage || `Address switch failed (HTTP ${res.status})`);
  }
  return data;
}

function generateAffExtParam1() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const rand = String(Math.floor(1000 + Math.random() * 9000));
  return `ENKR${date}A${time}${rand}`;
}

async function affiliateWarmup(ctx, productUrl, affid, affExtParam2) {
  let url;
  try {
    const u = new URL(productUrl);
    if (affid) {
      u.searchParams.set('affid', affid);
      u.searchParams.set('affExtParam1', generateAffExtParam1());
    }
    if (affExtParam2) u.searchParams.set('affExtParam2', affExtParam2);
    url = u.toString();
  } catch {
    console.warn(`[Snipe/co:${ctx.name}] warmup skipped: invalid product URL`);
    return;
  }

  const beforeCookies = new Map(ctx.jar.map((c) => [c.name, c.value]));
  let warmupOk = false;
  try {
    const res = await fkFetch(ctx, url, { method: 'GET', redirect: 'follow' });
    console.log(`[Snipe/co:${ctx.name}] product warmup: ${res.status} · affid=${affid || 'none'}`);
    warmupOk = true;
  } catch (e) {
    console.warn(`[Snipe/co:${ctx.name}] product warmup failed:`, e.message);
  }
  // fkFetch has already merged any Set-Cookie into ctx.jar. Log names only;
  // cookie values are credentials and must never enter the event log.
  const afterCookies = new Map(ctx.jar.map((c) => [c.name, c.value]));
  const added = [...afterCookies.keys()].filter((name) => !beforeCookies.has(name));
  const updated = [...afterCookies.keys()].filter((name) => beforeCookies.has(name) && beforeCookies.get(name) !== afterCookies.get(name));
  const removed = [...beforeCookies.keys()].filter((name) => !afterCookies.has(name));
  console.log(`[Snipe/aff:${ctx.name}] warmup Set-Cookie diff`, { ok: warmupOk, added, updated, removed });
}

async function removeGST(ctx, businessDetails) {
  const body = JSON.stringify({
    actionRequestContext: {
      businessIntent: { actionType: 'UPDATE', businessDetails, selected: false },
      expressCoFlow: false,
      pageNumber: 1,
      pageUri: '/viewcheckout?loginFlow=false&checkoutInitiated=true',
      type: 'CHECKOUT_UPDATE_GST',
    },
  });
  await fkRomeFetch(ctx, '/api/1/action/view', { method: 'POST', body });
}

async function applySupercoins(ctx, cartRefID) {
  const body = JSON.stringify({
    serviceType: 'USE_COINS',
    checkoutUpdateData: [{ cartItemRefId: cartRefID, coinSelected: true }],
  });
  await fkRomeFetch(ctx, '/api/5/checkout', { method: 'PUT', body });
}

async function initiateCheckout(ctx, lst, qty, cfg) {
  const body = JSON.stringify({
    cartRequest: { cartContext: { [lst]: { quantity: qty, payWithEMISelected: false } } },
    checkoutType: 'PHYSICAL',
  });

  const MAX_ATTEMPTS = 5;
  const RETRY_BACKOFF_MS = [500, 1500, 4500, 8000];
  const MAX_NOT_SERVICEABLE = 5;
  let lastReason = 'unknown';
  let notServiceableCount = 0;

  const retryDelay = async (attempt) => {
    if (attempt >= MAX_ATTEMPTS) return;
    const baseMs = RETRY_BACKOFF_MS[attempt - 1] || RETRY_BACKOFF_MS.at(-1);
    const backoffMs = Math.round(baseMs * (0.8 + Math.random() * 0.4));
    console.log(`[Snipe/co:${ctx.name}] retry ${attempt + 1}/${MAX_ATTEMPTS} in ${backoffMs}ms`);
    await delay(backoffMs);
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { data } = await fkRomeFetch(ctx, '/api/5/checkout?loginFlow=false&view=FLIPKART', {
      method: 'POST', body,
    });

    if (data?.STATUS_CODE === 401) throw new Error('Not logged in to Flipkart');
    if (data?.STATUS_CODE === 400 && data?.RESPONSE?.errorCode === 'CHECKOUT_SHIELD_RESTRICTED_ITEM') {
      throw new Error(`Restricted item: ${data.RESPONSE.errorMessage}`);
    }
    const responseText = JSON.stringify(data || '').toLowerCase();
    if (responseText.includes('item not available for purchase') || responseText.includes('not available for purchase')) {
      throw new Error(`Item not available for purchase: ${data?.ERROR_MESSAGE || data?.RESPONSE?.errorMessage || 'Flipkart rejected the item'}`);
    }
    if (data?.STATUS_CODE === 429) {
      lastReason = 'rate limited (429)';
      console.warn(`[Snipe/co:${ctx.name}] initiateCheckout attempt ${attempt}: ${lastReason}`);
      await retryDelay(attempt);
      continue;
    }
    if (data?.STATUS_CODE !== 200) {
      lastReason = data?.ERROR_MESSAGE || data?.RESPONSE?.errorMessage || `STATUS ${data?.STATUS_CODE}`;
      const bodySnippet = JSON.stringify(data).slice(0, 400);
      console.warn(`[Snipe/co:${ctx.name}] initiateCheckout attempt ${attempt} on DC=${ctx.dc}: ${lastReason} · body=${bodySnippet}`);
      // 5xx or opaque failure → hop DC before next retry. Flipkart shards
      // checkout capacity and Shield state per DC, so a 500 on DC=2 may
      // succeed on DC=1 immediately. Cheap enough to always try.
      if (data?.STATUS_CODE >= 500 || data?.STATUS_CODE == null) {
        const idx = DC_POOL.indexOf(ctx.dc);
        const nextDc = DC_POOL[(idx + 1) % DC_POOL.length];
        if (nextDc !== ctx.dc) {
          console.log(`[Snipe/co:${ctx.name}] hopping DC ${ctx.dc} → ${nextDc} after ${data?.STATUS_CODE || 'no-status'}`);
          ctx.dc = nextDc;
        }
        if (data?.STATUS_CODE >= 500) {
          logToPopup(`[${ctx.name}] Checkout server error ${data.STATUS_CODE} · retrying on DC ${ctx.dc}`, 'warn');
        }
      }
      await retryDelay(attempt);
      continue;
    }

    try {
      const store = data?.RESPONSE?.orderSummary?.requestedStores?.[0];
      const item = store?.buyableStateItems?.[0];
      if (!item) {
        throw new Error('Item not available for purchase: no buyable items in orderSummary');
      }
      const serviceable = item?.itemPromiseInfo?.serviceable;
      if (!serviceable) {
        notServiceableCount++;
        const svcText = item?.itemPromiseInfo?.serviceabilityText || 'no serviceability text';
        lastReason = `not serviceable · ${svcText}`;
        console.warn(`[Snipe/co:${ctx.name}] not serviceable (${notServiceableCount}/${MAX_NOT_SERVICEABLE}): ${svcText}`);
        if (notServiceableCount >= MAX_NOT_SERVICEABLE) {
          throw new Error(`checkout says not serviceable to your pincode — ${svcText}`);
        }
        await retryDelay(attempt);
        continue;
      }

      const cartRefID = item.cartItemRefId;
      const grandTotal = data.RESPONSE.orderSummary.checkoutSummary.grandTotal;
      const gstInfo = data.RESPONSE.orderSummary.checkoutSummary.gstInfo;

      if (!cfg.GST_apply && gstInfo?.applicable && gstInfo?.businessDetails) {
        try { await removeGST(ctx, gstInfo.businessDetails); }
        catch (e) { console.warn(`[Snipe/co:${ctx.name}] removeGST failed`, e); }
      }
      if (cfg.supercoins_apply && cartRefID) {
        try { await applySupercoins(ctx, cartRefID); }
        catch (e) { console.warn(`[Snipe/co:${ctx.name}] applySupercoins failed`, e); }
      }
      return { cartRefID, grandTotal };
    } catch (e) {
      if (/not serviceable to your pincode|Restricted|logged in|Item not available/.test(e.message)) throw e;
      lastReason = 'parse error: ' + e.message;
      console.warn(`[Snipe/co:${ctx.name}] initiateCheckout attempt ${attempt}: parse error`, e.message);
      await retryDelay(attempt);
    }
  }
  throw new Error(`initiateCheckout exhausted retries — last: ${lastReason}`);
}

async function getPaymentToken(ctx) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data } = await fkRomeFetch(ctx, '/api/3/checkout/paymentToken', { method: 'GET' });
    const gpt = data?.RESPONSE?.getPaymentToken;
    const token = gpt?.token;
    if (token) return token;
    const alertMsg = gpt?.alertMessage?.message;
    if (alertMsg) {
      console.log(`[Snipe/co:${ctx.name}] payment token alert:`, alertMsg);
      logToPopup(`[${ctx.name}] Payment token alert: ${alertMsg}`, 'warn');
    }
    await delay(300 * (attempt + 1));
  }
  throw new Error('getPaymentToken exhausted retries');
}

// ─── Payment instruments ───────────────────────────────────────

const DEVICE_INFO = {
  colorDepth: 24, javaEnabled: false, javaScriptEnabled: true,
  language: 'en-IN', screenHeight: 1080, screenWidth: 1920, timeDifference: -330,
};
const DEVICE_CAPS = {
  read_sms: false, phonepe_sdk: false, juspay_sdk: false, nda_enabled: false, upi_enabled: false,
};

// Extract order reference from primary_action.parameters (used by COD/GV).
function extractOrderRef(pa) {
  const p = pa?.parameters || {};
  return p.order_id || p.orderId || p.reference_id || p.referenceId || null;
}

function extractPaymentOrderRef(data) {
  return extractOrderRef(data?.primary_action)
    || data?.order_id || data?.orderId || data?.reference_id || data?.referenceId || null;
}

function paymentResponseSummary(data) {
  return {
    response_type: data?.response_type || null,
    response_status: data?.response_status || null,
    response_keys: data && typeof data === 'object' ? Object.keys(data) : [],
    primary_action_keys: data?.primary_action && typeof data.primary_action === 'object'
      ? Object.keys(data.primary_action) : [],
    parameter_keys: data?.primary_action?.parameters && typeof data.primary_action.parameters === 'object'
      ? Object.keys(data.primary_action.parameters) : [],
    message_codes: Array.isArray(data?.messages)
      ? data.messages.map((message) => message?.status_code || message?.code || 'unknown') : [],
  };
}

async function submitFinalOrder(ctx, action) {
  const target = action?.target || action?.url;
  if (!target) return { orderRef: null, status: null };
  const method = String(action?.http_method || action?.httpMethod || 'POST').toUpperCase();
  const parameters = action?.parameters || {};
  const formBody = typeof parameters === 'string'
    ? parameters
    : new URLSearchParams(parameters).toString();
  const init = {
    method,
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
      Referer: 'https://www.flipkart.com/payments?isRevampedDesktopView=true',
    },
    ...(method === 'GET' ? {} : { body: formBody }),
  };
  const res = await fkFetch(ctx, target, init);
  const text = await res.text();
  logToPopup(`[${ctx.name}] Verifying final order response · HTTP ${res.status}`, res.status >= 200 && res.status < 300 ? 'info' : 'warn');
  const match = `${res.finalUrl || ''}\n${text}`.match(/OD\d{16,18}/i);
  return {
    orderRef: match ? match[0].toUpperCase() : null,
    status: res.status,
    finalUrl: res.finalUrl || null,
    accepted: res.status >= 200 && res.status < 300,
  };
}

async function payCOD(ctx, token) {
  const body = JSON.stringify({
    token,
    payment_instrument: 'COD',
    remove_captcha_page: true,
    device_information: DEVICE_INFO,
    device_capabilities: DEVICE_CAPS,
    is_diff_shown_to_user: false,
  });
  let lastReason = 'no response';
  for (let i = 0; i < 5; i++) {
    const { data } = await fkPaymentsFetch(ctx, '/fkpay/api/v3/payments/pay?instrument=COD', {
      method: 'POST', body,
    }, token);

    const rtype = data?.response_type;
    const rstatus = data?.response_status;

    if (rtype === 'PAYMENT_SUCCESS') {
      const action = data?.primary_action || data?.primaryAction;
      let finalOrder;
      try {
        finalOrder = await submitFinalOrder(ctx, action);
      } catch (error) {
        console.warn(`[Snipe/co:${ctx.name}] final COD order submission failed`, error.message);
        return { ok: false, reason: `COD payment succeeded but final order submission failed: ${error.message}` };
      }
      const orderRef = finalOrder?.orderRef || extractPaymentOrderRef(data);
      if (!orderRef && finalOrder?.accepted) {
        console.warn(`[Snipe/co:${ctx.name}] final COD order accepted without order reference`, {
          final_status: finalOrder.status,
          ...paymentResponseSummary(data),
        });
        return { ok: true, headless: true, orderRef: null, orderRefUnavailable: true };
      }
      if (!orderRef) {
        console.warn(`[Snipe/co:${ctx.name}] final COD submission returned no order reference`, {
          final_status: finalOrder?.status || null,
          ...paymentResponseSummary(data),
        });
        return { ok: false, reason: 'COD payment succeeded but Flipkart returned no confirmed order reference' };
      }
      return { ok: true, headless: true, orderRef };
    }

    // Captcha / challenge / any non-success needs manual handling.
    if (rtype === 'CAPTCHA' || rtype === 'CHALLENGE' || rtype === 'OTP') {
      const paymentUrl = `https://www.flipkart.com/payments?isRevampedDesktopView=true&token=${encodeURIComponent(token)}`;
      logToPopup(`[${ctx.name}] COD requires ${rtype} — opening payment page for manual completion`, 'warn');
      return {
        ok: true, headless: false,
        openTab: { target: paymentUrl, method: 'GET' },
        reason: `manual: ${rtype}`,
      };
    }

    const msg = (data?.messages && data.messages[0]?.status_code) || rtype || rstatus || 'no status';
    lastReason = msg;
    console.log(`[Snipe/co:${ctx.name}] COD not yet success:`, msg);
    await delay(200 * (i + 1));
  }
  return { ok: false, reason: `COD payment did not succeed — last: ${lastReason}` };
}

async function payCard(ctx, token, card) {
  if (!card || !card.number || !card.expiry || !card.cvv) {
    return { ok: false, reason: 'card details incomplete (need number, expiry MM/YY, cvv)' };
  }
  const parts = String(card.expiry).split('/').map((s) => s.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, reason: 'card expiry must be MM/YY' };
  }
  const [expMonth, expYearRaw] = parts;
  const expYear = expYearRaw.length === 2 ? '20' + expYearRaw : expYearRaw;
  const body = JSON.stringify({
    payment_instrument: 'CREDIT',
    token,
    card_number: String(card.number).replace(/\s+/g, ''),
    expiry_month: expMonth,
    expiry_year: expYear,
    cvv: String(card.cvv),
    device_information: DEVICE_INFO,
    device_capabilities: DEVICE_CAPS,
    is_diff_shown_to_user: false,
  });
  let lastReason = 'no response';
  for (let i = 0; i < 3; i++) {
    const { data } = await fkPaymentsFetch(ctx, '/fkpay/api/v3/payments/paywithdetails?instrument=CREDIT', {
      method: 'POST', body,
    }, token);

    const rstatus = data?.response_status;
    const rtype = data?.response_type;
    const pa = data?.primary_action;

    // Non-3DS or auto-approved: headless success.
    if (rtype === 'PAYMENT_SUCCESS') {
      const orderRef = extractOrderRef(pa);
      return { ok: true, headless: true, orderRef };
    }

    // 3DS handoff: response_status SUCCESS + primary_action → bank ACS URL.
    if (rstatus === 'SUCCESS' && pa?.target) {
      return {
        ok: true, headless: false,
        openTab: {
          target: pa.target,
          method: (pa.http_method || 'POST').toUpperCase(),
          params: pa.parameters || {},
        },
      };
    }

    // PAYMENT_INITIATE_FAILURE with primary_action → let bank show error page (per FlashBuy).
    const msg = (data?.messages && data.messages[0]?.status_code) || null;
    if (msg && pa?.target) {
      logToPopup(`[${ctx.name}] Card init warning: ${msg} — opening bank page`, 'warn');
      return {
        ok: true, headless: false,
        openTab: {
          target: pa.target,
          method: (pa.http_method || 'POST').toUpperCase(),
          params: pa.parameters || {},
        },
      };
    }

    lastReason = msg || rtype || rstatus || 'no status';
    console.log(`[Snipe/co:${ctx.name}] card pay not ready:`, lastReason);
    await delay(200 * (i + 1));
  }
  return { ok: false, reason: `card payment did not return primary_action — last: ${lastReason}` };
}

async function payNetbank(ctx, token, bankcode) {
  const body = JSON.stringify({
    token,
    payment_instrument: 'NET_OPTIONS',
    bank_code: bankcode,
    device_information: DEVICE_INFO,
    device_capabilities: DEVICE_CAPS,
    is_diff_shown_to_user: false,
  });
  let lastReason = 'no response';
  for (let i = 0; i < 3; i++) {
    const { data } = await fkPaymentsFetch(ctx, '/fkpay/api/v3/payments/paywithdetails?instrument=NET_OPTIONS', {
      method: 'POST', body,
    }, token);

    const rstatus = data?.response_status;
    const pa = data?.primary_action;

    if (rstatus === 'SUCCESS' && pa?.target) {
      return {
        ok: true, headless: false,
        openTab: {
          target: pa.target,
          method: (pa.http_method || 'POST').toUpperCase(),
          params: pa.parameters || {},
        },
      };
    }

    // Some Flipkart NB responses carry a primary_action with a `messages` list
    // even though response_status isn't SUCCESS — surface the bank page so the
    // user can complete or see the failure.
    const msg = (data?.messages && data.messages[0]?.status_code) || null;
    if (msg && pa?.target) {
      logToPopup(`[${ctx.name}] Netbank init warning: ${msg} — opening bank page`, 'warn');
      return {
        ok: true, headless: false,
        openTab: {
          target: pa.target,
          method: (pa.http_method || 'POST').toUpperCase(),
          params: pa.parameters || {},
        },
      };
    }
    lastReason = msg || data?.response_type || rstatus || 'no status';
    console.log(`[Snipe/co:${ctx.name}] netbank not yet ready:`, lastReason);
    await delay(200 * (i + 1));
  }
  return { ok: false, reason: `netbank pay did not return primary_action — last: ${lastReason}` };
}

// ─── UPI (DYNAMIC_QR) ──────────────────────────────────────────

async function payUpiInit(ctx, token, vpa) {
  const body = JSON.stringify({
    token,
    payment_instrument: 'DYNAMIC_QR',
    provider: 'FLIPKART',
    user_selected_adjustment_ids: [],
    device_information: DEVICE_INFO,
    device_capabilities: { ...DEVICE_CAPS, upi_enabled: true },
    is_diff_shown_to_user: false,
    ...(vpa ? { vpa } : {}),
  });
  const { data } = await fkPaymentsFetch(ctx, '/fkpay/api/v3/payments/paywithdetails?instrument=DYNAMIC_QR', {
    method: 'POST', body,
  }, token);
  if (data?.response_status !== 'SUCCESS') {
    const msg = (data?.messages && data.messages[0]?.status_code) || data?.response_type || 'init failed';
    throw new Error(`UPI init: ${msg}`);
  }
  const idet = data?.instrument_details || {};
  return {
    txn_id: data?.txn_id,
    qr_code: idet.qr_code || null,
    upi_intent: idet.upi_intent || null,
    polling_interval_ms: (idet.polling_interval || 3) * 1000,
    expiry_time: idet.expiry_time || null,
    polling_text: idet.polling_text || 'Waiting for UPI payment…',
  };
}

async function payUpiPoll(ctx, token, txn_id) {
  const body = JSON.stringify({ transactionId: txn_id, token });
  const { data } = await fkPaymentsFetch(ctx, '/fkpay/api/v3/payments/upi/poll', {
    method: 'POST', body,
  }, token);
  return data || {};
}

async function payUpi(ctx, token, vpa, deferPolling = false) {
  const init = await payUpiInit(ctx, token, vpa);
  logToPopup(`[${ctx.name}] UPI QR ready · scan to pay (expires ${init.expiry_time || 'soon'})`, 'action');
  const qrPayload = {
    accountId: ctx.accountId,
    accountName: ctx.name,
    qr_code: init.qr_code,
    upi_intent: init.upi_intent,
    expiry_time: init.expiry_time,
    polling_text: init.polling_text,
    at: Date.now(),
  };
  // Background persists this into chrome.storage.session on receipt — offscreen
  // storage writes aren't reliable, so persistence must go through the SW.
  chrome.runtime.sendMessage({ type: MSG.UPI_QR_READY, ...qrPayload }).catch(() => {});

  if (deferPolling) {
    return {
      ok: true,
      pending: { ...init, token },
    };
  }

  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    await delay(init.polling_interval_ms);
    let poll;
    try { poll = await payUpiPoll(ctx, token, init.txn_id); }
    catch (e) { console.warn(`[Snipe/co:${ctx.name}] upi poll error`, e.message); continue; }

    const rtype = poll?.response_type;
    if (rtype === 'PAYMENT_SUCCESS') {
      const pa = poll?.primary_action;
      const orderRef = extractOrderRef(pa);
      return { ok: true, headless: true, orderRef };
    }
    if (rtype === 'PAYMENT_FAILURE') {
      return { ok: false, reason: poll?.response_message || 'UPI payment failed' };
    }
    // PAYMENT_PENDING → keep polling.
  }
  return { ok: false, reason: 'UPI payment timed out (5 min)' };
}

async function pollUpiUntilDone(ctx, pending) {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    await delay(pending.polling_interval_ms || 3000);
    let poll;
    try { poll = await payUpiPoll(ctx, pending.token, pending.txn_id); }
    catch (e) { console.warn(`[Snipe/co:${ctx.name}] upi poll error`, e.message); continue; }

    const rtype = poll?.response_type;
    if (rtype === 'PAYMENT_SUCCESS') {
      return { ok: true, headless: true, orderRef: extractOrderRef(poll?.primary_action) };
    }
    if (rtype === 'PAYMENT_FAILURE') {
      return { ok: false, reason: poll?.response_message || 'UPI payment failed' };
    }
  }
  return { ok: false, reason: 'UPI payment timed out (5 min)' };
}

export async function completeUpiPayment(pending, account = null) {
  const ctx = createCheckoutContext(account);
  ctx.name = account?.name || 'browser';
  if (account) {
    const switched = await chrome.runtime.sendMessage({
      type: 'ACCOUNT_SESSION_START',
      ctxId: ctx.id,
      accountId: account.id,
      cookies: account.cookies || [],
    });
    if (!switched?.ok) throw new Error(switched?.error || 'Could not activate saved account session');
  }
  try {
    return await pollUpiUntilDone(ctx, pending);
  } finally {
    if (account) {
      await chrome.runtime.sendMessage({
        type: 'ACCOUNT_SESSION_END',
        ctxId: ctx.id,
        accountId: account.id,
      }).catch((e) => console.warn(`[Snipe/co:${ctx.name}] account session restore failed:`, e?.message));
    }
  }
}

// Poll one UPI transaction without waiting. The offscreen scheduler uses this
// to round-robin many accounts while keeping each individual cookie swap
// isolated.
export async function pollUpiOnce(pending, account = null) {
  const ctx = createCheckoutContext(account);
  ctx.name = account?.name || 'browser';
  if (account) {
    const switched = await chrome.runtime.sendMessage({
      type: 'ACCOUNT_SESSION_START',
      ctxId: ctx.id,
      accountId: account.id,
      cookies: account.cookies || [],
    });
    if (!switched?.ok) throw new Error(switched?.error || 'Could not activate saved account session');
  }
  try {
    const poll = await payUpiPoll(ctx, pending.token, pending.txn_id);
    if (poll?.response_type === 'PAYMENT_SUCCESS') {
      return { done: true, ok: true, orderRef: extractOrderRef(poll.primary_action) };
    }
    if (poll?.response_type === 'PAYMENT_FAILURE') {
      return { done: true, ok: false, reason: poll.response_message || 'UPI payment failed' };
    }
    return { done: false };
  } finally {
    if (account) {
      const ended = await chrome.runtime.sendMessage({
        type: 'ACCOUNT_SESSION_END',
        ctxId: ctx.id,
        accountId: account.id,
        persist: false,
      }).catch((e) => ({ ok: false, error: e?.message || String(e) }));
      if (ended?.cookies?.length) account.cookies = ended.cookies;
      if (!ended?.ok) console.warn(`[Snipe/co:${ctx.name}] account session restore failed:`, ended?.error);
    }
  }
}

// ─── Public entry ──────────────────────────────────────────────

// `account` is optional. When supplied, the service worker temporarily
// installs that account's cookies into Chrome's managed jar. When null, the
// current browser session is used directly.
export async function runCheckout(target, config, account = null, opts = {}) {
  const ctx = createCheckoutContext(account, opts);
  if (!account) {
    ctx.name = 'browser';
  }
  console.log(`[Snipe/co:${ctx.name}] runCheckout ▶`, target.productId, 'pmode=' + config.pmode,
    account ? `account=${account.id}` : 'browser-session', `startDc=${ctx.dc}`);

  if (account) {
    const switched = await chrome.runtime.sendMessage({
      type: 'ACCOUNT_SESSION_START',
      ctxId: ctx.id,
      accountId: account.id,
      cookies: account.cookies || [],
    });
    if (!switched?.ok) throw new Error(switched?.error || 'Could not activate saved account session');
  }

  try {
    if (config.pmode === 'creditcard' && !config.card) {
      throw new Error('Card mode selected but no card saved / picked.');
    }
    if (config.pmode === 'creditcard' && !config.card?.cvv) {
      throw new Error('Card CVV missing. Enter CVV in the popup and try again — CVV is never stored.');
    }
    if (config.pmode === 'netbank' && !config.bank) {
      throw new Error('Netbank selected but no bank code configured.');
    }

    const pincode = config.pincode || '';
    const qty = Math.max(1, config.qty || 1);

    // Prefer the lid captured at poll time (target.pollLid): it is the exact
    // listing the serviceability response reported available, so we buy that
    // seller instead of whatever the page ranker picks a moment later.
    // Falls back to resolveListingId for manual/one-shot flows that skip poll.
    let lst = target.listingId || target.pollLid;
    if (lst) {
      console.log(`[Snipe/co:${ctx.name}] LID from poll:`, lst);
    } else {
      lst = await resolveListingId(ctx, target.url);
      console.log(`[Snipe/co:${ctx.name}] LID resolved:`, lst);
    }

    await affiliateWarmup(ctx, target.url, config.affid, config.affExtParam2);

    // /api/5/checkout accepts cartContext inline and mints its own
    // cartItemRefId — no /api/5/cart round trip needed. Verified end-to-end
    // 2026-08-25 (see research/probe_buynow.js).
    let { cartRefID, grandTotal } = await initiateCheckout(ctx, lst, qty, {
      GST_apply: !!config.GST_apply,
      supercoins_apply: !!config.supercoins_apply,
    });
    if (config.addressId) {
      await switchCheckoutAddress(ctx, cartRefID, config.addressId, config.addressPincode || pincode);
      // Flipkart rotates cartItemRefId and recalculates serviceability after a
      // shipping-address change. Re-initiate before minting the payment token.
      ({ cartRefID, grandTotal } = await initiateCheckout(ctx, lst, qty, {
        GST_apply: !!config.GST_apply,
        supercoins_apply: !!config.supercoins_apply,
      }));
      console.log(`[Snipe/co:${ctx.name}] checkout address selected · ${config.addressId}`);
    }
    console.log(`[Snipe/co:${ctx.name}] checkout initiated · ₹${grandTotal} · cartRef=${cartRefID}`);

    const token = await getPaymentToken(ctx);
    console.log(`[Snipe/co:${ctx.name}] payment token acquired`);

    if (config.pmode === 'cod') {
      const r = await payCOD(ctx, token);
      if (r.ok && r.headless) return { headless: true, orderRef: r.orderRef, grandTotal, accountName: ctx.name };
      if (r.ok && !r.headless) return { headless: false, openTab: r.openTab, grandTotal, accountName: ctx.name };
      throw new Error(r.reason);
    }

    if (config.pmode === 'netbank') {
      const r = await payNetbank(ctx, token, config.bank);
      if (r.ok) return { headless: false, openTab: r.openTab, grandTotal, accountName: ctx.name };
      throw new Error(r.reason);
    }

    if (config.pmode === 'creditcard') {
      const r = await payCard(ctx, token, config.card);
      if (r.ok && r.headless) return { headless: true, orderRef: r.orderRef, grandTotal, accountName: ctx.name };
      if (r.ok && !r.headless) return { headless: false, openTab: r.openTab, grandTotal, accountName: ctx.name };
      throw new Error(r.reason);
    }

    if (config.pmode === 'upi') {
    const r = await payUpi(ctx, token, config.vpa, !!config.deferUpi);
    if (r.ok && r.pending) {
      return { headless: false, upiPending: r.pending, grandTotal, accountName: ctx.name };
    }
    if (r.ok) return { headless: true, orderRef: r.orderRef, grandTotal, accountName: ctx.name };
      throw new Error(r.reason);
    }

    const paymentUrl = config.pmode === 'emi'
      ? `https://www.flipkart.com/payments/emi/banks/plans?isRevampedDesktopView=true&token=${encodeURIComponent(token)}`
      : `https://www.flipkart.com/payments?isRevampedDesktopView=true&token=${encodeURIComponent(token)}`;

    return {
      headless: false,
      openTab: { target: paymentUrl, method: 'GET' },
      grandTotal,
      accountName: ctx.name,
    };
  } finally {
    if (account) {
      const ended = await chrome.runtime.sendMessage({
        type: 'ACCOUNT_SESSION_END',
        ctxId: ctx.id,
        accountId: account.id,
      }).catch((e) => ({ ok: false, error: e?.message || String(e) }));
      if (ended?.cookies?.length) account.cookies = ended.cookies;
      if (!ended?.ok) console.warn(`[Snipe/co:${ctx.name}] account session restore failed:`, ended?.error);
    }
  }
}
