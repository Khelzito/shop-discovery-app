import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_URL_LENGTH, classifyIpAddress, evaluateUrl } from './url-policy.ts';
import type { UrlRejection } from './url-policy.ts';

/**
 * The SSRF matrix from the Prompt 16 audit.
 *
 * Every rejection is asserted by REASON, not just by `ok: false`: a URL
 * refused for the wrong reason is a policy that happens to work, and the next
 * refactor will break it without a failing test.
 */

function rejected(input: unknown, reason: UrlRejection, options = {}) {
  const result = evaluateUrl(input, options);
  assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(input)}`);
  if (!result.ok) {
    assert.equal(result.reason, reason, `${JSON.stringify(input)}: ${result.reason} (${result.detail})`);
  }
}

function accepted(input: string, options = {}) {
  const result = evaluateUrl(input, options);
  assert.ok(result.ok, `expected acceptance for ${JSON.stringify(input)}: ${JSON.stringify(result)}`);
  return result;
}

describe('accepts ordinary shop URLs', () => {
  it('keeps path and query, which a shop URL may need', () => {
    const result = accepted('https://maison-leon.fr/fr/collections?page=2');
    assert.equal(result.url, 'https://maison-leon.fr/fr/collections?page=2');
    assert.equal(result.hostname, 'maison-leon.fr');
    assert.equal(result.scheme, 'https');
  });

  it('accepts http as well as https', () => {
    assert.equal(accepted('http://shop.example.org/').scheme, 'http');
  });

  it('accepts a subdomain of a commerce platform', () => {
    assert.equal(accepted('https://maison-leon.myshopify.com').hostname, 'maison-leon.myshopify.com');
  });
});

describe('normalisation', () => {
  it('lowercases the host and drops the fragment', () => {
    assert.equal(accepted('https://MAISON-Leon.FR/Path#section').url, 'https://maison-leon.fr/Path');
  });

  it('drops a default port', () => {
    assert.equal(accepted('https://maison-leon.fr:443/').url, 'https://maison-leon.fr/');
    assert.equal(accepted('http://maison-leon.fr:80/').url, 'http://maison-leon.fr/');
  });

  it('converts an internationalised name to punycode', () => {
    const result = accepted('https://exämple-boutique.fr/');
    assert.equal(result.hostname, 'xn--exmple-boutique-1kb.fr');
    assert.ok(result.url.startsWith('https://xn--'));
  });

  it('strips a trailing dot, a classic denylist bypass', () => {
    assert.equal(accepted('https://maison-leon.fr./').hostname, 'maison-leon.fr');
  });

  it('trims whitespace a paste adds around the input', () => {
    assert.equal(accepted('  https://maison-leon.fr  ').hostname, 'maison-leon.fr');
  });

  it('keeps www distinct: claims match the EXACT host', () => {
    assert.equal(accepted('https://www.maison-leon.fr').hostname, 'www.maison-leon.fr');
  });

  it('exposes the origin', () => {
    assert.equal(accepted('https://maison-leon.fr/a').origin, 'https://maison-leon.fr');
  });
});

describe('schemeless input', () => {
  it('assumes https only when explicitly allowed', () => {
    assert.equal(accepted('maison-leon.fr', { allowSchemeless: true }).url, 'https://maison-leon.fr/');
    rejected('maison-leon.fr', 'unparseable');
  });

  it('does not let "host:port" pose as a scheme', () => {
    // new URL('localhost:8080') parses with protocol "localhost:".
    rejected('localhost:8080', 'port_not_allowed', { allowSchemeless: true });
    rejected('localhost:8080', 'scheme_not_allowed');
  });

  it('still refuses dangerous pseudo-schemes once prefixed', () => {
    assert.equal(evaluateUrl('javascript:alert(1)', { allowSchemeless: true }).ok, false);
    assert.equal(evaluateUrl('mailto:shop@maison-leon.fr', { allowSchemeless: true }).ok, false);
    assert.equal(evaluateUrl('data:text/html,<script>', { allowSchemeless: true }).ok, false);
  });
});

describe('input shape', () => {
  it('refuses non-strings and empty input', () => {
    rejected(undefined, 'invalid_input');
    rejected(42, 'invalid_input');
    rejected('   ', 'invalid_input');
  });

  it('refuses over-long input', () => {
    rejected(`https://maison-leon.fr/${'a'.repeat(MAX_URL_LENGTH)}`, 'too_long');
  });

  it('refuses characters the parser would silently rewrite', () => {
    // The parser turns "exa\tmple.com" into "example.com".
    rejected('https://exa\tmple.com/', 'invalid_characters');
    rejected('https://maison-leon.fr/\npath', 'invalid_characters');
    rejected('https://maison leon.fr/', 'invalid_characters');
    rejected('https://maison-leon.fr/' + String.fromCharCode(0), 'invalid_characters');
  });

  it('refuses unparseable input', () => {
    rejected('https://', 'unparseable');
    rejected('http://1.2.3.4.5/', 'unparseable');
    rejected('http://[fe80::1%25eth0]/', 'unparseable');
  });
});

describe('scheme, credentials, port', () => {
  it('allows only http and https', () => {
    for (const input of ['ftp://maison-leon.fr/', 'file:///etc/passwd', 'gopher://maison-leon.fr/', 'ws://maison-leon.fr/', 'javascript:alert(1)', 'data:text/plain,hi']) {
      rejected(input, 'scheme_not_allowed');
    }
  });

  it('refuses embedded credentials, including the @-confusion form', () => {
    rejected('https://user:pass@maison-leon.fr/', 'credentials_not_allowed');
    rejected('https://user@maison-leon.fr/', 'credentials_not_allowed');
    // Looks like evil.com, connects to 127.0.0.1.
    rejected('https://maison-leon.fr@127.0.0.1/', 'credentials_not_allowed');
  });

  it('refuses any non-default port, including cross-scheme defaults', () => {
    rejected('https://maison-leon.fr:8443/', 'port_not_allowed');
    rejected('http://maison-leon.fr:8080/', 'port_not_allowed');
    rejected('http://maison-leon.fr:443/', 'port_not_allowed');
    rejected('https://maison-leon.fr:80/', 'port_not_allowed');
    rejected('http://maison-leon.fr:22/', 'port_not_allowed');
  });
});

describe('hostnames that are not public', () => {
  it('refuses localhost in every spelling', () => {
    rejected('http://localhost/', 'hostname_not_public');
    rejected('http://LOCALHOST/', 'hostname_not_public');
    rejected('http://localhost./', 'hostname_not_public');
    rejected('http://api.localhost/', 'hostname_not_public');
  });

  it('refuses reserved and internal suffixes', () => {
    for (const host of ['printer.local', 'db.internal', 'nas.lan', 'router.home.arpa', 'api.svc', 'x.cluster.local', 'shop.example', 'shop.invalid', 'dev.test', 'x.onion', 'box.localdomain', 'wiki.corp']) {
      rejected(`https://${host}/`, 'hostname_not_public');
    }
  });

  it('refuses single-label names, which resolve through internal search domains', () => {
    rejected('http://intranet/', 'hostname_not_public');
    rejected('http://metadata/', 'hostname_not_public');
  });

  it('refuses metadata hostnames', () => {
    rejected('http://metadata.google.internal/', 'hostname_not_public');
    rejected('http://metadata.goog/', 'hostname_not_public');
  });

  it('refuses labels no public web host uses', () => {
    rejected('https://under_score.com/', 'hostname_invalid');
    rejected('https://-leading.com/', 'hostname_invalid');
    rejected('https://trailing-.com/', 'hostname_invalid');
    rejected(`https://${'a'.repeat(64)}.com/`, 'hostname_invalid');
  });
});

describe('IPv4 literals', () => {
  it('refuses every loopback spelling the parser canonicalises', () => {
    for (const input of ['http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://017700000001/', 'http://0177.0.0.1/', 'http://127.1/', 'http://127.0.0.1./']) {
      rejected(input, 'blocked_address');
    }
  });

  it('refuses the cloud metadata endpoint in any form', () => {
    rejected('http://169.254.169.254/latest/meta-data/', 'blocked_address');
    rejected('http://2852039166/', 'blocked_address');
    rejected('http://0xa9.0xfe.0xa9.0xfe/', 'blocked_address');
  });

  it('refuses private, CGNAT, unspecified and reserved ranges', () => {
    for (const ip of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '100.100.100.200', '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.2.10', '198.18.0.1']) {
      rejected(`http://${ip}/`, 'blocked_address');
    }
    rejected('http://0/', 'blocked_address');
  });

  it('refuses a PUBLIC ip literal too — not a shop website', () => {
    rejected('http://8.8.8.8/', 'ip_literal_not_allowed');
    rejected('http://172.32.0.1/', 'ip_literal_not_allowed');
  });
});

describe('IPv6 literals', () => {
  it('refuses loopback, unspecified, link-local, unique-local, multicast', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', 'fec0::1']) {
      rejected(`http://[${ip}]/`, 'blocked_address');
    }
  });

  it('refuses IPv4-mapped loopback and metadata, written either way', () => {
    rejected('http://[::ffff:127.0.0.1]/', 'blocked_address');
    rejected('http://[::ffff:7f00:1]/', 'blocked_address');
    rejected('http://[0:0:0:0:0:ffff:169.254.169.254]/', 'blocked_address');
  });

  it('refuses tunnelling and documentation prefixes', () => {
    rejected('http://[2001:db8::1]/', 'blocked_address');
    rejected('http://[2001:0:4136:e378::1]/', 'blocked_address');
    rejected('http://[64:ff9b::7f00:1]/', 'blocked_address');
    rejected('http://[2002:7f00:1::]/', 'blocked_address');
  });

  it('refuses a public IPv6 literal as a literal', () => {
    rejected('http://[2606:4700:4700::1111]/', 'ip_literal_not_allowed');
  });
});

describe('classifyIpAddress — the check Phase B runs on DNS answers', () => {
  it('blocks what DNS could legitimately return for a hostile name', () => {
    const cases: [string, string][] = [
      ['127.0.0.1', 'loopback'],
      ['169.254.169.254', 'link_local'],
      ['10.1.2.3', 'private'],
      ['::1', 'loopback'],
      ['::ffff:10.0.0.1', 'ipv4_mapped:private'],
      ['::ffff:a9fe:a9fe', 'ipv4_mapped:link_local'],
      ['fd00::1', 'unique_local'],
    ];
    for (const [address, range] of cases) {
      const result = classifyIpAddress(address);
      assert.ok(result, address);
      assert.equal(result.blocked, true, address);
      assert.equal(result.range, range, address);
    }
  });

  it('passes public addresses', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      assert.equal(classifyIpAddress(address)?.blocked, false, address);
    }
  });

  it('checks CIDR edges exactly', () => {
    assert.equal(classifyIpAddress('172.15.255.255')?.blocked, false);
    assert.equal(classifyIpAddress('172.16.0.0')?.blocked, true);
    assert.equal(classifyIpAddress('172.31.255.255')?.blocked, true);
    assert.equal(classifyIpAddress('172.32.0.0')?.blocked, false);
    assert.equal(classifyIpAddress('100.63.255.255')?.blocked, false);
    assert.equal(classifyIpAddress('100.128.0.0')?.blocked, false);
  });

  it('returns null rather than "public" for anything malformed', () => {
    // A caller must never read "could not parse" as "safe".
    for (const bad of ['', 'localhost', '127.1', '0177.0.0.1', '1.2.3.256', '::1::2', 'fe80::1%eth0', '12345::', 'g::1']) {
      assert.equal(classifyIpAddress(bad), null, JSON.stringify(bad));
    }
  });
});
