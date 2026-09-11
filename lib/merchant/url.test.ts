import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkShopUrl, hostOfUrl, SHOP_URL_MESSAGES } from './url';

describe('checkShopUrl', () => {
  it('accepts an https address and returns its canonical form', () => {
    assert.deepEqual(checkShopUrl('https://maboutique.com'), {
      ok: true,
      url: 'https://maboutique.com/',
      hostname: 'maboutique.com',
    });
  });

  it('trims, lowercases the host, keeps the path and query, drops the fragment', () => {
    assert.deepEqual(checkShopUrl('  HTTPS://Www.MaBoutique.fr/Collections?page=2#top  '), {
      ok: true,
      url: 'https://www.maboutique.fr/Collections?page=2',
      hostname: 'www.maboutique.fr',
    });
  });

  it('adds https:// to a bare domain', () => {
    assert.deepEqual(checkShopUrl('maboutique.com/shop'), {
      ok: true,
      url: 'https://maboutique.com/shop',
      hostname: 'maboutique.com',
    });
  });

  it('accepts an internationalised domain, which the server converts', () => {
    assert.equal(checkShopUrl('https://café-léon.fr').ok, true);
  });

  it('requires an address', () => {
    assert.deepEqual(checkShopUrl('   '), { ok: false, error: SHOP_URL_MESSAGES.required });
  });

  it('refuses http with a dedicated message', () => {
    assert.deepEqual(checkShopUrl('http://maboutique.com'), { ok: false, error: SHOP_URL_MESSAGES.httpsOnly });
  });

  for (const [label, value] of [
    ['another scheme', 'ftp://maboutique.com'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a mailto link', 'mailto:hello@maboutique.com'],
    ['inner whitespace', 'https://ma boutique.com'],
    ['credentials', 'https://user:pass@maboutique.com'],
    ['a port', 'https://maboutique.com:8443'],
    ['an IPv4 literal', 'https://192.168.1.10'],
    ['an IPv6 literal', 'https://[::1]/'],
    ['localhost', 'https://localhost'],
    ['a local name', 'https://boutique.local'],
    ['a single label', 'https://intranet'],
    ['an underscore in the host', 'https://ma_boutique.com'],
  ] as const) {
    it(`refuses ${label}`, () => {
      assert.deepEqual(checkShopUrl(value), { ok: false, error: SHOP_URL_MESSAGES.invalid });
    });
  }

  it('refuses an address that is too long', () => {
    assert.deepEqual(checkShopUrl(`https://maboutique.com/${'a'.repeat(2100)}`), {
      ok: false,
      error: SHOP_URL_MESSAGES.tooLong,
    });
  });
});

describe('hostOfUrl', () => {
  it('reads the exact host of an http(s) URL', () => {
    assert.equal(hostOfUrl('https://WWW.Shop.fr/a?b'), 'www.shop.fr');
    assert.equal(hostOfUrl('http://shop.fr.'), 'shop.fr');
    assert.equal(hostOfUrl('https://shop.fr:443/'), 'shop.fr');
  });

  it('returns null for anything else', () => {
    assert.equal(hostOfUrl('ftp://shop.fr'), null);
    assert.equal(hostOfUrl(null), null);
    assert.equal(hostOfUrl('shop.fr'), null);
  });
});
