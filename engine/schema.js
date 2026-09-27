export const SYNC_DEFAULTS = {
  pmode: 'off',
  bank: '',
  vpa: '',
  qty: 1,
  conditional_buy: false,
  supercoins_apply: false,
  GST_apply: false,
  delivery_pincode: '',
  address_id: '',
  address_pincode: '',
  poll_interval: 3,
  // Premium-only user overrides. Ignored unless local.premium is true.
  affiliate_id: '',
  affiliate_ext_param: '',
};

// Hardcoded affiliate defaults. Applied to every checkout unless the
// user has premium AND has entered their own override. Disclosed to
// users in the store listing + privacy policy.
export const AFFILIATE = Object.freeze({
  id: 'growthte',
  extParam: '1215048',
});

// Persistent state: survives browser restart.
export const LOCAL_DEFAULTS = {
  tracking: false,
  eventLog: [],
  orderHistory: [],
  watchlist: [],
  saved_cards: [],
  selected_card_id: null,
  accounts: [],
  active_account_id: null,
  premium: false,
  telegram_bot_token: '',
  telegram_chat_id: '',
  telegram_notify_placed: true,
  telegram_notify_failed: true,
};

// Ephemeral state: session-scoped, cleared on browser restart.
export const SESSION_DEFAULTS = {
  inFlight: null,
  paymentTab: null,
  pendingPayment: null,
  account_session: null,
  upi_popup_opened: false,
  loginInProgress: false,
};

export const EVENT_LOG_MAX = 20;
export const ORDER_HISTORY_MAX = 100;

export const MSG = {
  OFFSCREEN_READY: 'OFFSCREEN_READY',
  STATE: 'SNIPE_STATE',
  STOP: 'SNIPE_STOP',
  BUY_START: 'BUY_START',
  BUY_COMPLETE: 'BUY_COMPLETE',
  BUY_FAILED: 'BUY_FAILED',
  OPEN_PAYMENT_TAB: 'OPEN_PAYMENT_TAB',
  RELEASE_INFLIGHT: 'RELEASE_INFLIGHT',
  LOG: 'LOG',
  UPI_QR_READY: 'UPI_QR_READY',
  BUY_FANOUT_DONE: 'BUY_FANOUT_DONE',
  OFFSCREEN_AUTH_PROBE: 'OFFSCREEN_AUTH_PROBE',
};

export const DC_POOL = [2, 1, 3, 4, 5];

// Payment modes the extension can drive end-to-end.
// off = drop user at Flipkart payment page and let them pick.
export const PMODES = ['off', 'cod', 'netbank', 'creditcard', 'upi', 'emi'];

export function parseFlipkartUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'Invalid URL.' };
  }
  if (!/(^|\.)flipkart\.com$/.test(u.hostname)) {
    return { ok: false, error: 'Not a flipkart.com URL.' };
  }
  const productId = u.searchParams.get('pid');
  const listingId = u.searchParams.get('lid');
  if (!productId) {
    return { ok: false, error: 'URL is missing ?pid= — use a link from a search or listing page.' };
  }
  const slug = u.pathname.split('/').filter(Boolean)[0] || 'Product';
  const name = slug
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return {
    ok: true,
    productId,
    listingId: listingId || null,
    url: rawUrl,
    name,
  };
}
