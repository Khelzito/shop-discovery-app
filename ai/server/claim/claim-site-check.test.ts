import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSafeFetcher } from '../site/safe-fetch.ts';
import { FakeNetwork, htmlPage, httpResponse } from '../testing/fake-network.ts';
import type { FakeReply, FakeRequest } from '../testing/fake-network.ts';
import { claimTargetFor } from './claim-domain.ts';
import { checkClaimOnSite, outcomeForFetchError } from './claim-site-check.ts';

/**
 * The home-page check end to end over a scripted network: the real safe-fetch,
 * the real robots parser, the real meta scan. No socket, no Internet.
 */

const V4 = '93.184.215.14';
const TOKEN = `sd-claim-${'5e'.repeat(32)}`;
const TAG = `<meta name="shop-discovery-verification" content="${TOKEN}">`;

function site(
  routes: Record<string, (request: FakeRequest) => FakeReply>,
  hosts: Record<string, string[]> = { 'maison-leon.fr': [V4], 'www.maison-leon.fr': [V4], 'autre-site.fr': [V4] },
  serverOptions: { tlsError?: Error } = {}
) {
  const net = new FakeNetwork();
  for (const [host, addresses] of Object.entries(hosts)) {
    net.host(host, { A: addresses });
  }
  net.server(V4, {
    ...serverOptions,
    reply: (request) => {
      const route = routes[`${request.hostname}${request.path}`];
      return route ? route(request) : httpResponse(404, { 'Content-Type': 'text/html' }, 'not found');
    },
  });
  return net;
}

const noRobots = () => httpResponse(404, { 'Content-Type': 'text/html' }, 'none');
const home = (head: string) => () => htmlPage(`<html><head>${head}</head><body>Boutique</body></html>`);
const redirect = (location: string) => () => httpResponse(301, { Location: location }, '');

async function check(net: FakeNetwork, shopUrl = 'https://maison-leon.fr/') {
  const target = claimTargetFor(shopUrl);
  assert.ok(target);
  return checkClaimOnSite({ target }, { fetcher: createSafeFetcher(net) });
}

describe('claim site check — reads the proof', () => {
  it('returns the token found on the exact host', async () => {
    const net = site({ 'maison-leon.fr/robots.txt': noRobots, 'maison-leon.fr/': home(TAG) });
    assert.deepEqual(await check(net), { kind: 'read', finalHost: 'maison-leon.fr', metaTags: 1, tokens: [TOKEN] });
    assert.deepEqual(net.tlsHostnames, ['maison-leon.fr', 'maison-leon.fr']);
    assert.equal(net.openResources, 0);
  });

  it('follows a redirect to the www sibling and reports that host', async () => {
    const net = site({
      'maison-leon.fr/robots.txt': noRobots,
      'maison-leon.fr/': redirect('https://www.maison-leon.fr/'),
      'www.maison-leon.fr/robots.txt': noRobots,
      'www.maison-leon.fr/': home(TAG),
    });
    const result = await check(net);
    assert.deepEqual(result, { kind: 'read', finalHost: 'www.maison-leon.fr', metaTags: 1, tokens: [TOKEN] });
  });

  it('always asks for the home page, whatever path the catalogue stores', async () => {
    const net = site({ 'maison-leon.fr/robots.txt': noRobots, 'maison-leon.fr/': home(TAG) });
    await check(net, 'https://maison-leon.fr/fr/collections?utm=1');
    assert.deepEqual(net.requests.map((request) => request.path), ['/robots.txt', '/']);
  });

  it('reports a page without the tag as read, with no candidate', async () => {
    const net = site({ 'maison-leon.fr/robots.txt': noRobots, 'maison-leon.fr/': home('<meta name="description" content="x">') });
    assert.deepEqual(await check(net), { kind: 'read', finalHost: 'maison-leon.fr', metaTags: 0, tokens: [] });
  });
});

describe('claim site check — a proof elsewhere proves nothing', () => {
  it('stops at a redirect to another domain, before contacting it', async () => {
    const net = site({
      'maison-leon.fr/robots.txt': noRobots,
      'maison-leon.fr/': redirect('https://autre-site.fr/'),
      'autre-site.fr/robots.txt': noRobots,
      'autre-site.fr/': home(TAG),
    });
    assert.deepEqual(await check(net), { kind: 'failed', outcome: 'redirect_off_domain', code: 'redirect_off_domain' });
    assert.equal(net.requests.some((request) => request.hostname === 'autre-site.fr'), false);
    assert.equal(net.lookups.some((lookup) => lookup.endsWith('autre-site.fr')), false);
    assert.equal(net.openResources, 0);
  });

  it('stops at a redirect to a subdomain or a parent', async () => {
    for (const location of ['https://shop.maison-leon.fr/', 'https://maison-leon.fr.autre-site.fr/']) {
      const net = site(
        { 'maison-leon.fr/robots.txt': noRobots, 'maison-leon.fr/': redirect(location) },
        { 'maison-leon.fr': [V4], 'shop.maison-leon.fr': [V4], 'maison-leon.fr.autre-site.fr': [V4] }
      );
      const result = await check(net);
      assert.equal(result.kind === 'failed' && result.outcome, 'redirect_off_domain', location);
    }
  });

  it('refuses an https to http downgrade', async () => {
    const net = site({ 'maison-leon.fr/robots.txt': noRobots, 'maison-leon.fr/': redirect('http://maison-leon.fr/') });
    assert.deepEqual(await check(net), { kind: 'failed', outcome: 'site_unreachable', code: 'fetch_redirect_downgrade' });
  });
});

describe('claim site check — robots.txt and transport failures', () => {
  it('obeys an explicit Disallow and never requests the page', async () => {
    const net = site({
      'maison-leon.fr/robots.txt': () => httpResponse(200, { 'Content-Type': 'text/plain' }, 'User-agent: ShopDiscoveryBot\nDisallow: /'),
      'maison-leon.fr/': home(TAG),
    });
    assert.deepEqual(await check(net), { kind: 'failed', outcome: 'robots_disallowed', code: 'robots_disallowed' });
    assert.deepEqual(net.requests.map((request) => request.path), ['/robots.txt']);
  });

  it('fails closed when robots.txt cannot be read', async () => {
    const net = site({ 'maison-leon.fr/robots.txt': () => httpResponse(503, { 'Content-Type': 'text/plain' }, 'down'), 'maison-leon.fr/': home(TAG) });
    assert.deepEqual(await check(net), { kind: 'failed', outcome: 'site_unreachable', code: 'robots_http_status' });
    assert.deepEqual(net.requests.map((request) => request.path), ['/robots.txt']);
  });

  it('refuses a non-HTML home page', async () => {
    const net = site({
      'maison-leon.fr/robots.txt': noRobots,
      'maison-leon.fr/': () => httpResponse(200, { 'Content-Type': 'application/json' }, `{"meta":"${TOKEN}"}`),
    });
    assert.deepEqual(await check(net), { kind: 'failed', outcome: 'not_html', code: 'fetch_content_type_not_allowed' });
  });

  it('reports a TLS failure without detail', async () => {
    const net = site({}, { 'maison-leon.fr': [V4] }, { tlsError: new Error('certificate for 93.184.215.14 expired') });
    const result = await check(net);
    assert.deepEqual(result, { kind: 'failed', outcome: 'site_unreachable', code: 'robots_tls_failed' });
    assert.equal(JSON.stringify(result).includes('93.184'), false);
    assert.equal(net.openResources, 0);
  });

  it('never connects to a private address', async () => {
    const net = site({}, { 'maison-leon.fr': ['10.0.0.8'] });
    const result = await check(net);
    assert.equal(result.kind, 'failed');
    assert.equal(result.kind === 'failed' && result.outcome, 'site_unreachable');
    assert.deepEqual(net.connections, []);
  });

  it('maps every transport failure to a short outcome', () => {
    assert.equal(outcomeForFetchError('timeout'), 'timeout');
    assert.equal(outcomeForFetchError('aborted'), 'timeout');
    assert.equal(outcomeForFetchError('tls_failed'), 'tls_failed');
    assert.equal(outcomeForFetchError('body_too_large'), 'too_large');
    assert.equal(outcomeForFetchError('headers_too_large'), 'too_large');
    assert.equal(outcomeForFetchError('content_type_not_allowed'), 'not_html');
    for (const code of ['dns_failed', 'no_address', 'address_blocked', 'connect_failed', 'remote_address_mismatch', 'http_status', 'redirect_loop', 'redirect_limit'] as const) {
      assert.equal(outcomeForFetchError(code), 'site_unreachable', code);
    }
  });
});
