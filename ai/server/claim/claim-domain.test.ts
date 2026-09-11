import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { claimHostsOf, claimTargetFor, isClaimHost } from './claim-domain.ts';

describe('claim domain binding', () => {
  it('targets the https home page of the exact host', () => {
    assert.deepEqual(claimTargetFor('https://maison-leon.fr/collections/ete?x=1'), {
      hostname: 'maison-leon.fr',
      homepageUrl: 'https://maison-leon.fr/',
      allowedHosts: ['maison-leon.fr', 'www.maison-leon.fr'],
    });
  });

  it('checks over https even when the catalogue stores http', () => {
    assert.equal(claimTargetFor('http://maison-leon.fr/')?.homepageUrl, 'https://maison-leon.fr/');
  });

  it('normalises case and the trailing dot', () => {
    const target = claimTargetFor('https://WWW.Maison-Leon.FR./');
    assert.equal(target?.hostname, 'www.maison-leon.fr');
    assert.equal(target?.homepageUrl, 'https://www.maison-leon.fr/');
  });

  it('uses punycode for internationalised names', () => {
    const expected = new URL('https://bijouterie-élan.fr/').hostname;
    assert.ok(expected.startsWith('xn--'));
    const target = claimTargetFor('https://bijouterie-élan.fr/');
    assert.equal(target?.hostname, expected);
    assert.deepEqual(target?.allowedHosts, [expected, `www.${expected}`]);
  });

  it('allows exactly the www sibling, in both directions', () => {
    assert.deepEqual(claimHostsOf('shop.fr'), ['shop.fr', 'www.shop.fr']);
    assert.deepEqual(claimHostsOf('www.shop.fr'), ['www.shop.fr', 'shop.fr']);
    assert.deepEqual(claimHostsOf('boutique.shop.fr'), ['boutique.shop.fr', 'www.boutique.shop.fr']);
    // `www.fr` never yields the bare TLD.
    assert.deepEqual(claimHostsOf('www.fr'), ['www.fr']);
  });

  it('refuses parents, other subdomains and look-alikes', () => {
    const target = claimTargetFor('https://boutique.shop.fr/')!;
    for (const host of ['shop.fr', 'www.shop.fr', 'autre.shop.fr', 'boutique.shop.fr.evil.com', 'evilboutique.shop.fr', 'www2.boutique.shop.fr']) {
      assert.equal(isClaimHost(target, host), false, host);
    }
    assert.equal(isClaimHost(target, 'www.boutique.shop.fr'), true);
  });

  it('has no target for URLs the policy refuses', () => {
    for (const url of ['https://maison-leon.example/', 'https://127.0.0.1/', 'https://user:pw@shop.fr/', 'https://shop.fr:8443/', 'ftp://shop.fr/', 'not a url', null]) {
      assert.equal(claimTargetFor(url), null, String(url));
    }
  });
});
