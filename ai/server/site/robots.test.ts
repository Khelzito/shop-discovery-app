import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isPathAllowed, parseRobots } from './robots.ts';

const allowed = (robots: string, path: string) => isPathAllowed(parseRobots(robots), path);

describe('robots.txt groups', () => {
  it('allows everything when the file is empty or has no group', () => {
    assert.equal(allowed('', '/'), true);
    assert.equal(allowed('# nothing here', '/shop'), true);
    assert.equal(parseRobots('').matched, 'none');
  });

  it('applies the wildcard group when no group names us', () => {
    const robots = 'User-agent: *\nDisallow: /';
    assert.equal(allowed(robots, '/'), false);
    assert.equal(parseRobots(robots).matched, 'wildcard');
  });

  it('prefers a group naming ShopDiscoveryBot over the wildcard, case-insensitively', () => {
    const robots = 'User-agent: *\nDisallow: /\n\nUser-agent: shopdiscoverybot\nAllow: /';
    assert.equal(allowed(robots, '/collections'), true);
    assert.equal(parseRobots(robots).matched, 'product_token');

    const reverse = 'User-agent: *\nAllow: /\n\nUser-Agent: ShopDiscoveryBot/1.0\nDisallow: /';
    assert.equal(allowed(reverse, '/'), false);
  });

  it('ignores groups for other crawlers', () => {
    assert.equal(allowed('User-agent: Googlebot\nDisallow: /', '/'), true);
  });

  it('merges every group that names us, and shares rules across consecutive agents', () => {
    const robots = [
      'User-agent: ShopDiscoveryBot',
      'Disallow: /checkout',
      '',
      'User-agent: OtherBot',
      'User-agent: ShopDiscoveryBot',
      'Disallow: /account',
    ].join('\n');
    assert.equal(allowed(robots, '/checkout/pay'), false);
    assert.equal(allowed(robots, '/account'), false);
    assert.equal(allowed(robots, '/'), true);
  });

  it('ignores rules that precede any User-agent line, and comments', () => {
    assert.equal(allowed('Disallow: /\nUser-agent: *\nAllow: / # all good', '/'), true);
  });

  it('treats an empty Disallow as allowing everything', () => {
    assert.equal(allowed('User-agent: *\nDisallow:', '/anything'), true);
  });
});

describe('robots.txt rules', () => {
  it('lets the longest match win, and Allow win a tie', () => {
    const robots = 'User-agent: *\nDisallow: /shop\nAllow: /shop/public';
    assert.equal(allowed(robots, '/shop/private'), false);
    assert.equal(allowed(robots, '/shop/public/page'), true);
    assert.equal(allowed('User-agent: *\nDisallow: /page\nAllow: /page', '/page'), true);
  });

  it('supports * and the $ end anchor', () => {
    const robots = 'User-agent: *\nDisallow: /*.pdf$\nDisallow: /*?sort=';
    assert.equal(allowed(robots, '/files/catalogue.pdf'), false);
    assert.equal(allowed(robots, '/files/catalogue.pdf?v=2'), true);
    assert.equal(allowed(robots, '/collections?sort=price'), false);
    assert.equal(allowed(robots, '/collections'), true);
  });

  it('matches from the start of the path only, and treats regex characters literally', () => {
    const robots = 'User-agent: *\nDisallow: /a.b(c)';
    assert.equal(allowed(robots, '/a.b(c)/x'), false);
    assert.equal(allowed(robots, '/aXb(c)'), true);
    assert.equal(allowed(robots, '/x/a.b(c)'), true);
  });

  it('compares percent-escapes case-insensitively', () => {
    assert.equal(allowed('User-agent: *\nDisallow: /caf%c3%a9', '/caf%C3%A9'), false);
  });

  it('always allows /robots.txt itself', () => {
    assert.equal(allowed('User-agent: *\nDisallow: /', '/robots.txt'), true);
  });

  it('reads CRLF and CR line endings', () => {
    assert.equal(allowed('User-agent: *\r\nDisallow: /private\r\n', '/private'), false);
    assert.equal(allowed('User-agent: *\rDisallow: /private\r', '/private'), false);
  });
});
