import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { chunkedBody, CRLF, FakeNetwork, htmlPage, httpResponse } from '../testing/fake-network.ts';
import type { FakeReply, FakeRequest } from '../testing/fake-network.ts';
import { createSafeFetcher, SafeFetchError } from './safe-fetch.ts';
import type { SafeFetchErrorCode, SafeFetchOptions } from './safe-fetch.ts';

/**
 * safe-fetch against a scripted network. Every test also asserts that no
 * socket or TLS stream was left open.
 */

const V4 = '93.184.215.14';
const V4_B = '151.101.1.140';
const V6 = '2606:4700::6810:84e5';

function options(extra: Partial<SafeFetchOptions> = {}): SafeFetchOptions {
  return { acceptedMediaTypes: ['text/html', 'text/plain'], accept: 'text/html', deadline: Date.now() + 5_000, ...extra };
}

function network(reply: (request: FakeRequest) => FakeReply, records: { A?: string[] | Error; AAAA?: string[] | Error } = { A: [V4], AAAA: [V6] }) {
  return new FakeNetwork().host('shop.fr', records).server(V4, { reply }).server(V6, { reply });
}

async function rejectsWith(promise: Promise<unknown>, code: SafeFetchErrorCode): Promise<SafeFetchError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof SafeFetchError, `expected SafeFetchError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return error;
  }
  return assert.fail(`expected ${code}`);
}

describe('safe-fetch — a normal page', () => {
  it('pins a validated IPv4, validates TLS against the original hostname, and reads the page', async () => {
    const net = network(() => htmlPage('<p>bonjour</p>'));
    const response = await createSafeFetcher(net).fetch('https://shop.fr/collections?x=1', options());

    assert.equal(response.text, '<p>bonjour</p>');
    assert.equal(response.status, 200);
    assert.equal(response.mediaType, 'text/html');
    assert.equal(response.url.url, 'https://shop.fr/collections?x=1');
    assert.equal(response.redirectCount, 0);
    assert.deepEqual(net.lookups.sort(), ['A shop.fr', 'AAAA shop.fr']);
    assert.deepEqual(net.connections, [`${V4} 443`]);
    assert.deepEqual(net.tlsHostnames, ['shop.fr']);

    const raw = net.requests[0]!.raw;
    assert.ok(raw.startsWith(`GET /collections?x=1 HTTP/1.1${CRLF}Host: shop.fr${CRLF}`));
    assert.ok(raw.includes(`User-Agent: ShopDiscoveryBot/1.0${CRLF}`));
    assert.ok(raw.includes(`Accept-Encoding: identity${CRLF}`));
    assert.ok(raw.includes(`Connection: close${CRLF}`));
    assert.equal(net.openResources, 0);
  });

  it('uses IPv6 when the host has no IPv4', async () => {
    const net = network(() => htmlPage('v6'), { A: [], AAAA: [V6] });
    assert.equal((await createSafeFetcher(net).fetch('https://shop.fr/', options())).text, 'v6');
    assert.deepEqual(net.connections, [`${V6} 443`]);
    assert.equal(net.openResources, 0);
  });

  it('falls back to IPv6 when IPv4 refuses the connection', async () => {
    const reply = () => htmlPage('fallback');
    const net = new FakeNetwork()
      .host('shop.fr', { A: [V4], AAAA: [V6] })
      .server(V4, { reply, connectError: new Error('refused') })
      .server(V6, { reply });
    assert.equal((await createSafeFetcher(net).fetch('https://shop.fr/', options())).text, 'fallback');
    assert.deepEqual(net.connections, [`${V4} 443`, `${V6} 443`]);
    assert.equal(net.openResources, 0);
  });

  it('fails when no validated address accepts a connection', async () => {
    const net = new FakeNetwork().host('shop.fr', { A: [V4], AAAA: [V6] });
    await rejectsWith(createSafeFetcher(net).fetch('https://shop.fr/', options()), 'connect_failed');
  });

  it('reads a chunked body delivered three bytes at a time', async () => {
    const reply = () => httpResponse(200, { 'Content-Type': 'text/html', 'Transfer-Encoding': 'chunked' }, chunkedBody(['hello', ' wor', 'ld']));
    const net = new FakeNetwork().host('shop.fr', { A: [V4] }).server(V4, { reply, chunkSize: 3 });
    assert.equal((await createSafeFetcher(net).fetch('https://shop.fr/', options())).text, 'hello world');
    assert.equal(net.openResources, 0);
  });

  it('reads an unframed body until the connection closes', async () => {
    const net = network(() => httpResponse(200, { 'Content-Type': 'text/plain' }, 'eof body', { noLength: true }));
    assert.equal((await createSafeFetcher(net).fetch('https://shop.fr/', options())).text, 'eof body');
  });
});

describe('safe-fetch — URL policy, before any lookup', () => {
  for (const [label, url, code] of [
    ['plain http', 'http://shop.fr/', 'scheme_not_allowed'],
    ['localhost', 'https://localhost/', 'url_rejected'],
    ['a private IP literal', 'https://10.0.0.1/', 'url_rejected'],
    ['the metadata address', 'https://169.254.169.254/latest/meta-data', 'url_rejected'],
    ['a public IP literal', 'https://93.184.215.14/', 'url_rejected'],
    ['embedded credentials', 'https://user:pass@shop.fr/', 'url_rejected'],
    ['a non-default port', 'https://shop.fr:8443/', 'url_rejected'],
    ['a file URL', 'file:///etc/passwd', 'url_rejected'],
  ] as const) {
    it(`refuses ${label}`, async () => {
      const net = network(() => htmlPage('never'));
      await rejectsWith(createSafeFetcher(net).fetch(url, options()), code);
      assert.deepEqual(net.lookups, []);
      assert.deepEqual(net.connections, []);
    });
  }
});

describe('safe-fetch — SSRF after DNS', () => {
  const blocked: [string, { A?: string[]; AAAA?: string[] }][] = [
    ['a private IPv4', { A: ['10.1.2.3'] }],
    ['loopback IPv4', { A: ['127.0.0.1'] }],
    ['the cloud metadata IPv4', { A: ['169.254.169.254'] }],
    ['carrier-grade NAT', { A: ['100.100.100.200'] }],
    ['a private IPv6', { AAAA: ['fd00::1'] }],
    ['loopback IPv6', { AAAA: ['::1'] }],
    ['link-local IPv6', { AAAA: ['fe80::1'] }],
    ['an IPv4-mapped loopback in AAAA', { AAAA: ['::ffff:127.0.0.1'] }],
    ['mixed public IPv4 and private IPv6', { A: [V4], AAAA: ['fd12:3456::1'] }],
    ['a public and a private IPv4', { A: [V4, '192.168.1.10'] }],
    ['an unparseable answer', { A: ['not-an-ip'] }],
    ['an IPv6 answer in an A record', { A: [V6] }],
  ];

  for (const [label, records] of blocked) {
    it(`refuses ${label} without connecting`, async () => {
      const net = network(() => htmlPage('never'), records);
      await rejectsWith(createSafeFetcher(net).fetch('https://shop.fr/', options()), 'address_blocked');
      assert.deepEqual(net.connections, []);
    });
  }

  it('fails closed when one lookup errors, even if the other answered', async () => {
    const net = network(() => htmlPage('never'), { A: [V4], AAAA: new Error('SERVFAIL') });
    await rejectsWith(createSafeFetcher(net).fetch('https://shop.fr/', options()), 'dns_failed');
    assert.deepEqual(net.connections, []);
  });

  it('refuses a name with no address', async () => {
    const net = network(() => htmlPage('never'), { A: [], AAAA: [] });
    await rejectsWith(createSafeFetcher(net).fetch('https://shop.fr/', options()), 'no_address');
  });
});

describe('safe-fetch — pinning and TLS', () => {
  it('refuses a socket whose remote address is not the pinned IP', async () => {
    const net = new FakeNetwork().host('shop.fr', { A: [V4] }).server(V4, { reply: () => htmlPage('x'), remoteAddress: '10.0.0.5' });
    await rejectsWith(createSafeFetcher(net).fetch('https://shop.fr/', options()), 'remote_address_mismatch');
    assert.deepEqual(net.tlsHostnames, []);
    assert.equal(net.openResources, 0);
  });

  it('compares strictly: another spelling of the same IPv6 is refused, never accepted', async () => {
    const net = new FakeNetwork()
      .host('shop.fr', { AAAA: [V6] })
      .server(V6, { reply: () => htmlPage('x'), remoteAddress: '2606:4700:0:0:0:0:6810:84e5' });
    await rejectsWith(createSafeFetcher(net).fetch('https://shop.fr/', options()), 'remote_address_mismatch');
  });

  it('refuses when the remote address is unknown', async () => {
    const net = new FakeNetwork().host('shop.fr', { A: [V4] }).server(V4, { reply: () => htmlPage('x'), remoteAddress: null });
    await rejectsWith(createSafeFetcher(net).fetch('https://shop.fr/', options()), 'remote_address_mismatch');
  });

  it('fails closed on a TLS failure, without echoing the runtime message', async () => {
    const net = new FakeNetwork()
      .host('shop.fr', { A: [V4] })
      .server(V4, { reply: () => htmlPage('x'), tlsError: new Error(`invalid peer certificate: NotValidForName ${V4}`) });
    const error = await rejectsWith(createSafeFetcher(net).fetch('https://shop.fr/', options()), 'tls_failed');
    assert.equal(error.message.includes(V4), false);
    assert.equal(error.message.includes('shop.fr'), false);
    assert.equal(net.requests.length, 0);
    assert.equal(net.openResources, 0);
  });
});

describe('safe-fetch — redirects', () => {
  const redirect = (location: string, status = 302) => httpResponse(status, { Location: location }, '');

  it('follows a relative redirect, re-resolving and re-validating the hop', async () => {
    const net = network((request) => (request.path === '/old' ? redirect('/new') : htmlPage('moved')));
    const response = await createSafeFetcher(net).fetch('https://shop.fr/old', options());
    assert.equal(response.text, 'moved');
    assert.equal(response.url.url, 'https://shop.fr/new');
    assert.equal(response.redirectCount, 1);
    assert.equal(net.lookups.filter((lookup) => lookup === 'A shop.fr').length, 2);
    assert.equal(net.openResources, 0);
  });

  it('re-validates a redirect to another host, and refuses one that resolves privately', async () => {
    const net = network(() => redirect('https://rebind.fr/admin')).host('rebind.fr', { A: ['127.0.0.1'] });
    await rejectsWith(createSafeFetcher(net).fetch('https://shop.fr/', options()), 'address_blocked');
    assert.deepEqual(net.connections, [`${V4} 443`]);
    assert.equal(net.openResources, 0);
  });

  it('refuses a downgrade to http', async () => {
    const net = network(() => redirect('http://shop.fr/'));
    await rejectsWith(createSafeFetcher(net).fetch('https://shop.fr/', options()), 'redirect_downgrade');
  });

  for (const [label, location] of [
    ['localhost', 'https://localhost/'],
    ['the metadata address', 'http://169.254.169.254/latest/meta-data'],
    ['an IP literal', 'https://10.0.0.1/'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a Location with whitespace', 'https://shop.fr/a b'],
  ] as const) {
    it(`refuses a redirect to ${label}`, async () => {
      const net = network(() => redirect(location));
      const error = await createSafeFetcher(net).fetch('https://shop.fr/', options()).catch((caught: unknown) => caught);
      assert.ok(error instanceof SafeFetchError);
      assert.ok(['redirect_invalid', 'redirect_downgrade'].includes(error.code), error.code);
      assert.equal(net.connections.length, 1);
    });
  }

  it('refuses a redirect without Location', async () => {
    const net = network(() => httpResponse(301, {}, ''));
    await rejectsWith(createSafeFetcher(net).fetch('https://shop.fr/', options()), 'redirect_invalid');
  });

  it('detects a redirect loop', async () => {
    const net = network((request) => redirect(request.path === '/a' ? '/b' : '/a'));
    await rejectsWith(createSafeFetcher(net).fetch('https://shop.fr/a', options()), 'redirect_loop');
    assert.equal(net.openResources, 0);
  });

  it('follows exactly three redirects', async () => {
    const net = network((request) => {
      const step = Number(request.path.slice(2));
      return step < 3 ? redirect(`/r${step + 1}`) : htmlPage('arrived');
    });
    const response = await createSafeFetcher(net).fetch('https://shop.fr/r0', options());
    assert.equal(response.redirectCount, 3);
    assert.equal(response.text, 'arrived');
  });

  it('refuses a fourth redirect', async () => {
    const net = network((request) => redirect(`/r${Number(request.path.slice(2)) + 1}`));
    await rejectsWith(createSafeFetcher(net).fetch('https://shop.fr/r0', options()), 'redirect_limit');
    assert.equal(net.requests.length, 4);
    assert.equal(net.openResources, 0);
  });

  it('runs beforeHop on every hop, and stops before connecting when it throws', async () => {
    const net = network((request) => (request.path === '/a' ? redirect('/b') : htmlPage('ok')));
    const hops: string[] = [];
    await createSafeFetcher(net).fetch('https://shop.fr/a', options({ beforeHop: async (hop) => void hops.push(hop.url) }));
    assert.deepEqual(hops, ['https://shop.fr/a', 'https://shop.fr/b']);

    const stopped = network(() => htmlPage('never'));
    await assert.rejects(
      createSafeFetcher(stopped).fetch('https://shop.fr/', options({ beforeHop: async () => { throw new Error('robots'); } })),
      /robots/
    );
    assert.deepEqual(stopped.connections, []);
  });
});

describe('safe-fetch — response limits', () => {
  it('refuses headers over 16 KiB', async () => {
    const net = network(() => htmlPage('x', { 'X-Big': 'a'.repeat(17_000) }));
    await rejectsWith(createSafeFetcher(net).fetch('https://shop.fr/', options()), 'headers_too_large');
    assert.equal(net.openResources, 0);
  });

  it('refuses a body over the limit, whatever the framing', async () => {
    const limit = { maxBodyBytes: 100 };
    const declared = network(() => htmlPage('a'.repeat(200)));
    await rejectsWith(createSafeFetcher(declared).fetch('https://shop.fr/', options(limit)), 'body_too_large');

    const chunked = network(() => httpResponse(200, { 'Content-Type': 'text/html', 'Transfer-Encoding': 'chunked' }, chunkedBody(['a'.repeat(60), 'b'.repeat(60)])));
    await rejectsWith(createSafeFetcher(chunked).fetch('https://shop.fr/', options(limit)), 'body_too_large');

    const unframed = network(() => httpResponse(200, { 'Content-Type': 'text/html' }, 'c'.repeat(150), { noLength: true }));
    await rejectsWith(createSafeFetcher(unframed).fetch('https://shop.fr/', options(limit)), 'body_too_large');
    assert.equal(unframed.openResources, 0);
  });

  it('never raises the body limit above 2 MiB', async () => {
    const net = network(() => httpResponse(200, { 'Content-Type': 'text/html', 'Content-Length': String(3 * 1024 * 1024) }, ''));
    await rejectsWith(createSafeFetcher(net).fetch('https://shop.fr/', options({ maxBodyBytes: 10 * 1024 * 1024 })), 'body_too_large');
  });

  for (const coding of ['gzip', 'br']) {
    it(`refuses Content-Encoding: ${coding}`, async () => {
      const net = network(() => htmlPage('x', { 'Content-Encoding': coding }));
      await rejectsWith(createSafeFetcher(net).fetch('https://shop.fr/', options()), 'content_encoding_not_allowed');
    });
  }

  it('accepts only text/html and text/plain', async () => {
    const json = network(() => httpResponse(200, { 'Content-Type': 'application/json' }, '{}'));
    await rejectsWith(createSafeFetcher(json).fetch('https://shop.fr/', options()), 'content_type_not_allowed');

    const missing = network(() => httpResponse(200, {}, 'x'));
    await rejectsWith(createSafeFetcher(missing).fetch('https://shop.fr/', options()), 'content_type_not_allowed');
    const allowed = network(() => httpResponse(200, {}, 'User-agent: *'));
    assert.equal((await createSafeFetcher(allowed).fetch('https://shop.fr/', options({ allowMissingContentType: true }))).text, 'User-agent: *');
  });

  it('refuses malformed responses', async () => {
    const badStatus = network(() => `HTTP/2 200 OK${CRLF}${CRLF}`);
    await rejectsWith(createSafeFetcher(badStatus).fetch('https://shop.fr/', options()), 'malformed_response');

    const smuggling = network(() => httpResponse(200, { 'Content-Type': 'text/html', 'Transfer-Encoding': 'chunked', 'Content-Length': '5' }, 'hello'));
    await rejectsWith(createSafeFetcher(smuggling).fetch('https://shop.fr/', options()), 'malformed_response');

    const truncated = network(() => httpResponse(200, { 'Content-Type': 'text/html', 'Content-Length': '500' }, 'short'));
    await rejectsWith(createSafeFetcher(truncated).fetch('https://shop.fr/', options()), 'truncated_response');
    assert.equal(truncated.openResources, 0);
  });

  it('reports an error status without reading the page', async () => {
    const net = network(() => httpResponse(404, { 'Content-Type': 'text/html' }, 'secret error page'));
    const error = await rejectsWith(createSafeFetcher(net).fetch('https://shop.fr/', options()), 'http_status');
    assert.equal(error.status, 404);
    assert.equal(error.message.includes('secret'), false);
  });
});

describe('safe-fetch — deadline and cancellation', () => {
  it('times out a server that never answers, and closes everything', async () => {
    const net = network(() => ({ hang: true }));
    await rejectsWith(createSafeFetcher(net).fetch('https://shop.fr/', options({ deadline: Date.now() + 80 })), 'timeout');
    assert.equal(net.openResources, 0);
  });

  it('refuses to start after the deadline', async () => {
    const net = network(() => htmlPage('x'));
    await rejectsWith(createSafeFetcher(net).fetch('https://shop.fr/', options({ deadline: Date.now() - 1 })), 'timeout');
    assert.deepEqual(net.lookups, []);
  });

  it('stops when the caller cancels', async () => {
    const controller = new AbortController();
    controller.abort();
    const net = network(() => htmlPage('x'));
    await rejectsWith(createSafeFetcher(net).fetch('https://shop.fr/', options({ signal: controller.signal })), 'aborted');
    assert.deepEqual(net.lookups, []);
  });

  it('closes a second host after a failure on the first address family too', async () => {
    const net = new FakeNetwork().host('shop.fr', { A: [V4, V4_B] }).server(V4, { reply: () => htmlPage('first') });
    assert.equal((await createSafeFetcher(net).fetch('https://shop.fr/', options())).text, 'first');
    assert.deepEqual(net.connections, [`${V4} 443`]);
    assert.equal(net.openResources, 0);
  });
});
