import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTRIBUTION_TTL_MS,
  validCreatorId,
  readCookie,
  readCreatorAttribution,
  buildCheckoutUrl,
  initializeBrowserAttribution,
} from '../creator-attribution.mjs';

const storageMap = (entries = []) => new Map(entries);
const webStorage = (map = new Map()) => ({
  getItem: (key) => map.has(key) ? map.get(key) : null,
  setItem: (key, value) => map.set(key, value),
  removeItem: (key) => map.delete(key),
});

test('validCreatorId accepts bounded safe identifiers and rejects unsafe values', () => {
  assert.equal(validCreatorId('Alice_01'), true);
  assert.equal(validCreatorId('a'.repeat(64)), true);
  for (const value of ['', '../admin', 'x/y', '<script>', 'a'.repeat(65), null, 42]) {
    assert.equal(validCreatorId(value), false, String(value));
  }
});

test('readCookie decodes only the requested cookie and handles malformed values', () => {
  assert.equal(readCookie('foo=bar; ls_aff_ref=hello%20world; other=x%2Fy', 'ls_aff_ref'), 'hello world');
  assert.equal(readCookie('foo=bar', 'ls_aff_ref'), '');
  assert.equal(readCookie('ls_aff_ref=%E0%A4%A', 'ls_aff_ref'), '');
  assert.equal(readCookie('foo=%E0%A4%A; ls_aff_ref=ok', 'ls_aff_ref'), 'ok');
});

test('current creator query persists creator, campaigns, and landing URL', () => {
  const storage = storageMap();
  const result = readCreatorAttribution({
    search: '?creator=maya&utm_source=ig&utm_medium=social&utm_campaign=spring&utm_content=video&utm_term=matcha',
    storage,
    now: 1000,
    landingUrl: 'https://ghostreply.com/path?creator=maya#fragment',
  });
  assert.deepEqual(result, {
    creator_id: 'maya', saved_at: 1000, utm_source: 'ig', utm_medium: 'social',
    utm_campaign: 'spring', utm_content: 'video', utm_term: 'matcha',
    landing_url: 'https://ghostreply.com/path',
  });
  assert.deepEqual(JSON.parse(storage.get('ghostreply_creator_attribution')), result);
});

test('stored attribution remains valid through 30 days and expires thereafter', () => {
  const saved = { creator_id: 'maya', saved_at: 1000, landing_url: 'https://example.com/' };
  const storage = webStorage(new Map([['ghostreply_creator_attribution', JSON.stringify(saved)]]));
  assert.deepEqual(readCreatorAttribution({ search: '', storage, now: 1000 + ATTRIBUTION_TTL_MS }), saved);
  assert.deepEqual(readCreatorAttribution({ search: '', storage, now: 1001 + ATTRIBUTION_TTL_MS }), {});
});

test('invalid storage is ignored and a valid current query works without storage', () => {
  const throwing = { getItem() { throw new Error('unavailable'); }, setItem() { throw new Error('unavailable'); } };
  assert.deepEqual(readCreatorAttribution({ search: '?creator=zoe', storage: throwing, now: 5 }), { creator_id: 'zoe', saved_at: 5 });
  assert.deepEqual(readCreatorAttribution({ search: '', storage: { getItem() { return '{bad'; } }, now: 5 }), {});
  assert.deepEqual(readCreatorAttribution({ search: '', storage: new Map([['ghostreply_creator_attribution', JSON.stringify({ creator_id: '../x', saved_at: 1 })]]), now: 5 }), {});
});

test('landing attribution stores only safe origin and pathname', () => {
  const storage = new Map();
  const result = readCreatorAttribution({
    search: '?creator=maya', storage, now: 5,
    landingUrl: 'https://user:secret@ghostreply.com/dating?email=user%40example.com&token=secret#reset',
  });
  assert.equal(result.landing_url, 'https://ghostreply.com/dating');
  assert.equal(JSON.parse(storage.get('ghostreply_creator_attribution')).landing_url, 'https://ghostreply.com/dating');
  assert.equal(readCreatorAttribution({ search: '?creator=zoe', storage, now: 6, landingUrl: 'javascript:alert(1)' }).landing_url, undefined);
});

test('malformed, invalid, and expired storage records are physically removed', () => {
  for (const stored of ['{bad', JSON.stringify({ creator_id: '../unsafe', saved_at: 1 }), JSON.stringify({ creator_id: 'maya', saved_at: 1 })]) {
    const map = new Map([['ghostreply_creator_attribution', stored]]);
    const storage = webStorage(map);
    readCreatorAttribution({ search: '', storage, now: stored.includes('saved_at') ? 1 + ATTRIBUTION_TTL_MS + 1 : 1 });
    assert.equal(map.has('ghostreply_creator_attribution'), false);
  }
  const map = new Map([['ghostreply_creator_attribution', '{bad']]);
  readCreatorAttribution({ search: '', storage: map, now: 1 });
  assert.equal(map.has('ghostreply_creator_attribution'), false);
});

test('stored landing URLs are normalized and rewritten during hydration', () => {
  const unsafe = 'https://user:secret@ghostreply.com/dating?email=user%40example.com&token=secret#reset';
  const map = new Map([['ghostreply_creator_attribution', JSON.stringify({ creator_id: 'maya', saved_at: 5, landing_url: unsafe })]]);
  const result = readCreatorAttribution({ search: '', storage: map, now: 6 });
  assert.equal(result.landing_url, 'https://ghostreply.com/dating');
  assert.equal(JSON.parse(map.get('ghostreply_creator_attribution')).landing_url, 'https://ghostreply.com/dating');

  const nonHttp = new Map([['ghostreply_creator_attribution', JSON.stringify({ creator_id: 'maya', saved_at: 5, landing_url: 'javascript:alert(1)' })]]);
  const withoutLanding = readCreatorAttribution({ search: '', storage: nonHttp, now: 6 });
  assert.equal(withoutLanding.landing_url, undefined);
  assert.deepEqual(JSON.parse(nonHttp.get('ghostreply_creator_attribution')), { creator_id: 'maya', saved_at: 5 });
});

test('checkout URL preserves query parameters and merges custom attribution data', () => {
  const result = buildCheckoutUrl({
    checkoutBase: 'https://buy.example/checkout?variant=pro&checkout[custom][creator_id]=old',
    attribution: { creator_id: 'maya', landing_url: 'https://example.com', utm_source: 'instagram', utm_medium: 'social' },
    custom: { plan: 'annual', creator_id: 'override', empty: '', long: 'x'.repeat(600) },
  });
  const url = new URL(result);
  assert.equal(url.searchParams.get('variant'), 'pro');
  assert.equal(url.searchParams.get('checkout[custom][creator_id]'), 'override');
  assert.equal(url.searchParams.get('checkout[custom][landing_url]'), 'https://example.com');
  assert.equal(url.searchParams.get('checkout[custom][utm_source]'), 'instagram');
  assert.equal(url.searchParams.get('checkout[custom][plan]'), 'annual');
  assert.equal(url.searchParams.get('checkout[custom][long]')?.length, 500);
});

test('checkout hands enriched URL to Lemon affiliate Build and falls back to cookie ref', () => {
  let handed;
  const built = buildCheckoutUrl({ checkoutBase: 'https://buy.example', attribution: { creator_id: 'maya' }, affiliateBuild: (url) => { handed = url; return `${url}&affiliate=1`; }, affiliateRef: 'ref-1' });
  assert.equal(built.endsWith('&affiliate=1'), true);
  assert.equal(new URL(handed).searchParams.get('checkout[custom][creator_id]'), 'maya');
  const fallback = buildCheckoutUrl({ checkoutBase: 'https://buy.example?x=1', affiliateBuild: () => { throw new Error('not ready'); }, affiliateRef: 'ref-2' });
  assert.equal(new URL(fallback).searchParams.get('aff_ref'), 'ref-2');
});

test('checkout preserves Lemon Affiliate Build receiver and rejects unusable results', () => {
  const affiliate = {
    Build(url) {
      assert.equal(this, affiliate);
      return `${url}&built=1`;
    },
  };
  const built = buildCheckoutUrl({ checkoutBase: 'https://buy.example?x=1', attribution: { creator_id: 'maya' }, affiliateBuild: affiliate.Build.bind(affiliate) });
  assert.equal(new URL(built).searchParams.get('built'), '1');
  for (const result of [undefined, null, Promise.resolve('https://other.example'), 'relative/path', 'ftp://other.example', '']) {
    const fallback = buildCheckoutUrl({ checkoutBase: 'https://buy.example?x=1', attribution: { creator_id: 'maya' }, affiliateBuild: () => result, affiliateRef: 'cookie-ref' });
    const url = new URL(fallback);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.searchParams.get('checkout[custom][creator_id]'), 'maya');
    assert.equal(url.searchParams.get('aff_ref'), 'cookie-ref');
  }
});

test('browser initialization is defensive and resolves Lemon data at checkout time', () => {
  const map = new Map();
  const browser = { location: { search: '?creator=maya', href: 'https://ghostreply.com/?creator=maya' }, localStorage: webStorage(map), document: { cookie: 'ls_aff_ref=from-cookie' } };
  const api = initializeBrowserAttribution(browser);
  assert.equal(api.attribution.creator_id, 'maya');
  assert.equal(browser.GhostReplyAttribution, api);
  browser.LemonSqueezy = { Affiliate: { Build(url) { assert.equal(this, browser.LemonSqueezy.Affiliate); return `${url}&built=1`; } } };
  const checkout = api.buildCheckoutUrl('https://buy.example', {});
  assert.equal(new URL(checkout).searchParams.get('built'), '1');
  const noBrowser = initializeBrowserAttribution({});
  assert.equal(noBrowser, null);
});
