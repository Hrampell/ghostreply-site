export const ATTRIBUTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const STORAGE_KEY = 'ghostreply_creator_attribution';
const UTM_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
const ATTRIBUTION_FIELDS = ['creator_id', 'landing_url', ...UTM_FIELDS];

export function validCreatorId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value);
}

export function readCookie(cookieHeader, name) {
  if (typeof cookieHeader !== 'string' || typeof name !== 'string' || !name) return '';
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    try { return decodeURIComponent(value); } catch { return ''; }
  }
  return '';
}

function storageRead(storage) {
  try {
    if (!storage) return null;
    return typeof storage.getItem === 'function'
      ? storage.getItem(STORAGE_KEY)
      : typeof storage.get === 'function' ? storage.get(STORAGE_KEY) : null;
  } catch { return null; }
}

function storageWrite(storage, value) {
  try {
    if (!storage) return;
    if (typeof storage.setItem === 'function') storage.setItem(STORAGE_KEY, value);
    else if (typeof storage.set === 'function') storage.set(STORAGE_KEY, value);
  } catch { /* Storage can be blocked by browser privacy settings. */ }
}

function storageRemove(storage) {
  try {
    if (!storage) return;
    if (typeof storage.removeItem === 'function') storage.removeItem(STORAGE_KEY);
    else if (typeof storage.delete === 'function') storage.delete(STORAGE_KEY);
  } catch { /* Storage can be blocked by browser privacy settings. */ }
}

function queryParams(search) {
  try { return new URLSearchParams(typeof search === 'string' ? search : ''); } catch { return new URLSearchParams(); }
}

function normalizeLandingUrl(value) {
  if (typeof value !== 'string' || !value) return '';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return `${parsed.origin}${parsed.pathname}`.slice(0, 500);
  } catch { return ''; }
}

function currentAttribution(params, now, landingUrl) {
  const creator = params.get('creator');
  if (!validCreatorId(creator)) return {};
  const result = { creator_id: creator, saved_at: now };
  for (const field of UTM_FIELDS) {
    const value = params.get(field);
    if (value) result[field] = value.slice(0, 200);
  }
  const normalizedLandingUrl = normalizeLandingUrl(landingUrl);
  if (normalizedLandingUrl) result.landing_url = normalizedLandingUrl;
  return result;
}

function validStored(value, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !validCreatorId(value.creator_id)) return {};
  if (typeof value.saved_at !== 'number' || !Number.isFinite(value.saved_at) || value.saved_at > now || now - value.saved_at > ATTRIBUTION_TTL_MS) return {};
  const result = { creator_id: value.creator_id, saved_at: value.saved_at };
  for (const field of UTM_FIELDS) if (typeof value[field] === 'string' && value[field]) result[field] = value[field].slice(0, 200);
  const normalizedLandingUrl = normalizeLandingUrl(value.landing_url);
  if (normalizedLandingUrl) result.landing_url = normalizedLandingUrl;
  return result;
}

export function readCreatorAttribution({ search, storage, now = Date.now(), landingUrl = '' } = {}) {
  const current = currentAttribution(queryParams(search), now, landingUrl);
  if (Object.keys(current).length) {
    storageWrite(storage, JSON.stringify(current));
    return current;
  }
  const raw = storageRead(storage);
  if (raw === null || raw === undefined) return {};
  try {
    const result = validStored(typeof raw === 'string' ? JSON.parse(raw) : raw, now);
    if (!Object.keys(result).length) storageRemove(storage);
    else storageWrite(storage, JSON.stringify(result));
    return result;
  } catch {
    storageRemove(storage);
    return {};
  }
}

export function buildCheckoutUrl({ checkoutBase, custom, attribution = {}, affiliateBuild, affiliateThis, affiliateRef } = {}) {
  let url;
  try { url = new URL(checkoutBase); } catch { return typeof checkoutBase === 'string' ? checkoutBase : ''; }
  const values = {};
  for (const field of ATTRIBUTION_FIELDS) {
    if (typeof attribution[field] === 'string' && attribution[field]) values[field] = attribution[field];
  }
  if (custom && typeof custom === 'object') {
    for (const [field, value] of Object.entries(custom)) {
      if (value !== null && value !== undefined && String(value)) values[field] = String(value);
    }
  }
  for (const [field, value] of Object.entries(values)) url.searchParams.set(`checkout[custom][${field}]`, value.slice(0, 500));
  const enriched = url.toString();
  if (typeof affiliateBuild === 'function') {
    try {
      const built = affiliateBuild.call(affiliateThis, enriched);
      if (typeof built === 'string') {
        const builtUrl = new URL(built);
        if (builtUrl.protocol === 'http:' || builtUrl.protocol === 'https:') return built;
      }
    } catch { /* fall through to the cookie ref. */ }
  }
  if (typeof affiliateRef === 'string' && affiliateRef) url.searchParams.set('aff_ref', affiliateRef);
  return url.toString();
}

export function initializeBrowserAttribution(browser = globalThis.window) {
  if (!browser?.location) return null;
  let storage;
  try { storage = browser.localStorage; } catch { storage = undefined; }
  const attribution = readCreatorAttribution({ search: browser.location.search, storage, landingUrl: browser.location.href });
  const api = {
    attribution,
    buildCheckoutUrl(checkoutBase, custom) {
      let affiliateBuild;
      let affiliateThis;
      try {
        affiliateThis = browser.LemonSqueezy?.Affiliate;
        affiliateBuild = affiliateThis?.Build;
      } catch { affiliateBuild = undefined; }
      let cookie = '';
      try { cookie = readCookie(browser.document?.cookie, 'ls_aff_ref'); } catch { /* unavailable document */ }
      return buildCheckoutUrl({ checkoutBase, custom, attribution, affiliateBuild, affiliateThis, affiliateRef: cookie });
    },
  };
  try { browser.GhostReplyAttribution = api; } catch { /* frozen host objects are allowed */ }
  return api;
}

if (typeof window !== 'undefined') initializeBrowserAttribution(window);
