/**
 * URL policy for anything the server will later fetch on a user's behalf.
 *
 * PURE: no DNS, no network, no clock. It decides whether a URL is even worth
 * resolving, and returns the single canonical form every later step must use.
 *
 * ===========================================================================
 * THIS IS NOT SSRF PROTECTION ON ITS OWN
 * ===========================================================================
 *
 * A hostname that passes here can still resolve to 127.0.0.1, to a private
 * network, or to the cloud metadata endpoint. Anyone controlling a DNS zone
 * can make `innocent-shop.com` point anywhere. The policy only removes the
 * cases that are rejectable WITHOUT resolving.
 *
 * Phase B (safe-fetch) MUST, before every connection and every redirect hop:
 *
 *   1. run `evaluateUrl` again on the hop's absolute URL;
 *   2. resolve the hostname itself (A and AAAA);
 *   3. run `classifyIpAddress` on EVERY returned address and refuse if any is
 *      blocked — not only the first one;
 *   4. connect using the canonical `url` returned here, never the raw input;
 *   5. treat DNS rebinding as an open risk: fetch() re-resolves on its own, so
 *      a validated name can answer differently at connect time. Mitigations
 *      belong in safe-fetch, and the residual risk must stay documented.
 *
 * WHY VALIDATE THE PARSED URL AND NOT THE STRING. WHATWG URL parsing rewrites
 * a lot: `http://2130706433/`, `http://0x7f.1/` and `http://0177.0.0.1/` all
 * become `127.0.0.1`; `[::ffff:127.0.0.1]` becomes `[::ffff:7f00:1]`; a tab
 * inside a hostname is silently removed. fetch() uses the same parser, so the
 * only safe thing to check is what it will actually connect to — and the only
 * safe thing to hand it is the href produced here.
 */

/** Generous for real shop URLs, short enough to refuse abuse. */
export const MAX_URL_LENGTH = 2048;

/** Longest DNS name (RFC 1035), dots included. */
const MAX_HOSTNAME_LENGTH = 253;

export const URL_REJECTIONS = [
  'invalid_input',
  'too_long',
  /** Whitespace or control characters the parser would silently rewrite. */
  'invalid_characters',
  'unparseable',
  'scheme_not_allowed',
  'credentials_not_allowed',
  'port_not_allowed',
  'hostname_invalid',
  /** localhost, a reserved suffix, a bare single-label name, a metadata host. */
  'hostname_not_public',
  /** A public IP literal: not a shop website, and a classic SSRF vector. */
  'ip_literal_not_allowed',
  /** An IP literal inside a blocked range. */
  'blocked_address',
] as const;
export type UrlRejection = (typeof URL_REJECTIONS)[number];

export type AcceptedUrl = {
  ok: true;
  /** Canonical href: lowercased host, punycode, no default port, no fragment. */
  url: string;
  scheme: 'http' | 'https';
  /**
   * Exact host, punycode, no trailing dot. Claims match on THIS value (D2):
   * `www.shop.fr` and `shop.fr` are different hosts on purpose.
   */
  hostname: string;
  origin: string;
};

export type RejectedUrl = {
  ok: false;
  reason: UrlRejection;
  /** Safe detail for logs and tests — never contains the raw input. */
  detail: string | null;
};

export type UrlPolicyResult = AcceptedUrl | RejectedUrl;

export type UrlPolicyOptions = {
  /**
   * Prefix `https://` when the input has no `scheme://`. For what a merchant
   * types ("maison-leon.fr"). NEVER for a redirect Location, where guessing
   * would be a bypass.
   */
  allowSchemeless?: boolean;
};

/**
 * Suffixes that never belong to a public shop. `.example`, `.invalid` and
 * `.test` are reserved (RFC 2606 / 6761) and resolve nowhere public — and
 * `.test` is a common name for internal development DNS.
 */
const NON_PUBLIC_SUFFIXES = [
  'localhost',
  'local',
  'localdomain',
  'internal',
  'intranet',
  'lan',
  'home',
  'home.arpa',
  'corp',
  'svc',
  'cluster.local',
  'example',
  'invalid',
  'test',
  'onion',
] as const;

/** Metadata hosts reachable by name, listed so the reason is explicit. */
const METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'instance-data',
]);

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// Whitespace or C0/DEL anywhere. The parser strips tabs and newlines inside a
// URL, so "exa\tmple.com" silently becomes "example.com": an input that does
// not mean what it looks like is refused rather than reinterpreted.
const FORBIDDEN_CHARACTERS = /[\s\u0000-\u001F\u007F]/;

export function evaluateUrl(input: unknown, options: UrlPolicyOptions = {}): UrlPolicyResult {
  if (typeof input !== 'string') {
    return reject('invalid_input', 'not a string');
  }

  // Outer whitespace is what a paste adds; inner whitespace is ambiguity.
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return reject('invalid_input', 'empty');
  }
  if (trimmed.length > MAX_URL_LENGTH) {
    return reject('too_long', `${trimmed.length} > ${MAX_URL_LENGTH}`);
  }
  if (FORBIDDEN_CHARACTERS.test(trimmed)) {
    return reject('invalid_characters', null);
  }

  // Only `scheme://` counts as a scheme. "localhost:8080" and
  // "javascript:alert(1)" parse as schemes of their own, so detecting a colon
  // would let them through the prefixing step unchanged.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  const candidate = !hasScheme && options.allowSchemeless === true ? `https://${trimmed}` : trimmed;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return reject('unparseable', null);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return reject('scheme_not_allowed', parsed.protocol);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return reject('credentials_not_allowed', null);
  }
  // The parser already empties a port equal to the scheme default, so any
  // remaining port is non-default — including http on 443.
  if (parsed.port !== '') {
    return reject('port_not_allowed', parsed.port);
  }

  // `example.com.` is the same name as `example.com`, and a trailing dot is a
  // classic way past string denylists. Normalised, not refused.
  let hostname = parsed.hostname.toLowerCase();
  if (hostname.endsWith('.') && !hostname.startsWith('[')) {
    hostname = hostname.slice(0, -1);
  }
  if (hostname.length === 0) {
    return reject('hostname_invalid', 'empty');
  }

  const ipCheck = checkIpLiteral(hostname);
  if (ipCheck !== null) {
    return ipCheck;
  }

  const hostnameCheck = checkHostname(hostname);
  if (hostnameCheck !== null) {
    return hostnameCheck;
  }

  parsed.hostname = hostname;
  parsed.hash = '';

  return {
    ok: true,
    url: parsed.href,
    scheme: parsed.protocol === 'https:' ? 'https' : 'http',
    hostname,
    origin: parsed.origin,
  };
}

function checkIpLiteral(hostname: string): RejectedUrl | null {
  const isV6 = hostname.startsWith('[') && hostname.endsWith(']');
  const isV4 = !isV6 && parseIpv4(hostname) !== null;
  if (!isV4 && !isV6) {
    return null;
  }
  const classification = classifyIpAddress(isV6 ? hostname.slice(1, -1) : hostname);
  if (classification === null) {
    return reject('hostname_invalid', 'malformed ip literal');
  }
  return classification.blocked
    ? reject('blocked_address', classification.range)
    : reject('ip_literal_not_allowed', null);
}

function checkHostname(hostname: string): RejectedUrl | null {
  if (hostname.length > MAX_HOSTNAME_LENGTH) {
    return reject('hostname_invalid', 'too long');
  }

  const labels = hostname.split('.');
  if (labels.some((label) => !LABEL.test(label))) {
    // Also catches empty labels ("a..b") and underscores, which the URL
    // parser accepts but no public web host uses.
    return reject('hostname_invalid', 'label');
  }

  if (METADATA_HOSTNAMES.has(hostname)) {
    return reject('hostname_not_public', 'metadata host');
  }
  if (labels.length < 2) {
    // Bare names resolve through search domains, i.e. internal DNS.
    return reject('hostname_not_public', 'single label');
  }
  for (const suffix of NON_PUBLIC_SUFFIXES) {
    if (hostname === suffix || hostname.endsWith(`.${suffix}`)) {
      return reject('hostname_not_public', `.${suffix}`);
    }
  }
  const tld = labels[labels.length - 1]!;
  if (/^[0-9]+$/.test(tld)) {
    // Unreachable after WHATWG parsing, kept because the parser is not ours.
    return reject('hostname_invalid', 'numeric tld');
  }
  return null;
}

function reject(reason: UrlRejection, detail: string | null): RejectedUrl {
  return { ok: false, reason, detail };
}

// ---------------------------------------------------------------------------
// IP classification — also the check Phase B runs on every resolved address
// ---------------------------------------------------------------------------

export type IpClassification = {
  version: 4 | 6;
  blocked: boolean;
  /** Name of the blocking range, or null for a public address. */
  range: string | null;
};

type V4Range = { base: number; bits: number; name: string };

function v4(cidr: string, name: string): V4Range {
  const [address, bits] = cidr.split('/');
  return { base: parseIpv4(address!)!, bits: Number(bits), name };
}

const BLOCKED_V4: readonly V4Range[] = [
  v4('0.0.0.0/8', 'unspecified'),
  v4('10.0.0.0/8', 'private'),
  // Includes Alibaba Cloud's metadata service at 100.100.100.200.
  v4('100.64.0.0/10', 'carrier_grade_nat'),
  v4('127.0.0.0/8', 'loopback'),
  // Includes 169.254.169.254, the AWS/GCP/Azure metadata endpoint.
  v4('169.254.0.0/16', 'link_local'),
  v4('172.16.0.0/12', 'private'),
  v4('192.0.0.0/24', 'ietf_protocol'),
  v4('192.0.2.0/24', 'documentation'),
  v4('192.88.99.0/24', 'relay_6to4'),
  v4('192.168.0.0/16', 'private'),
  v4('198.18.0.0/15', 'benchmarking'),
  v4('198.51.100.0/24', 'documentation'),
  v4('203.0.113.0/24', 'documentation'),
  v4('224.0.0.0/4', 'multicast'),
  // Includes 255.255.255.255.
  v4('240.0.0.0/4', 'reserved'),
];

/**
 * Classifies one textual IP address, v4 or v6, without brackets.
 *
 * Returns null for anything that is not a well-formed address, so a caller
 * can never mistake "unparseable" for "public".
 */
export function classifyIpAddress(address: string): IpClassification | null {
  const v4Value = parseIpv4(address);
  if (v4Value !== null) {
    return classifyV4(v4Value);
  }
  const bytes = parseIpv6(address);
  if (bytes === null) {
    return null;
  }
  return classifyV6(bytes);
}

function classifyV4(value: number): IpClassification {
  for (const range of BLOCKED_V4) {
    const mask = range.bits === 0 ? 0 : (0xffffffff << (32 - range.bits)) >>> 0;
    if (((value & mask) >>> 0) === ((range.base & mask) >>> 0)) {
      return { version: 4, blocked: true, range: range.name };
    }
  }
  return { version: 4, blocked: false, range: null };
}

function classifyV6(bytes: Uint8Array): IpClassification {
  const blocked = (range: string): IpClassification => ({ version: 6, blocked: true, range });
  const zeroUpTo = (end: number) => bytes.slice(0, end).every((b) => b === 0);
  const embeddedV4 = (offset: number) =>
    ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;

  // Addresses that carry an IPv4 address inside them are judged by it: a
  // mapped 127.0.0.1 is loopback whatever it is wrapped in.
  const judgeEmbedded = (offset: number, wrapper: string): IpClassification => {
    const inner = classifyV4(embeddedV4(offset));
    return inner.blocked ? blocked(`${wrapper}:${inner.range}`) : { version: 6, blocked: false, range: null };
  };

  if (zeroUpTo(16)) return blocked('unspecified');
  if (zeroUpTo(15) && bytes[15] === 1) return blocked('loopback');
  // ::ffff:a.b.c.d
  if (zeroUpTo(10) && bytes[10] === 0xff && bytes[11] === 0xff) return judgeEmbedded(12, 'ipv4_mapped');
  // ::a.b.c.d (deprecated IPv4-compatible)
  if (zeroUpTo(12)) return judgeEmbedded(12, 'ipv4_compatible');

  const first = bytes[0]!;
  const second = bytes[1]!;

  // 64:ff9b::/96 well-known NAT64 prefix.
  if (first === 0x00 && second === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes.slice(4, 12).every((b) => b === 0)) {
    return judgeEmbedded(12, 'nat64');
  }
  // 64:ff9b:1::/48 local-use NAT64.
  if (first === 0x00 && second === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes[4] === 0x00 && bytes[5] === 0x01) {
    return blocked('nat64_local');
  }
  // 100::/64 discard.
  if (first === 0x01 && second === 0x00 && bytes.slice(2, 8).every((b) => b === 0)) return blocked('discard');
  // 2001::/32 Teredo — tunnels to arbitrary IPv4.
  if (first === 0x20 && second === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return blocked('teredo');
  // 2001:db8::/32 documentation.
  if (first === 0x20 && second === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return blocked('documentation');
  // 2002::/16 6to4 — judged by the embedded address.
  if (first === 0x20 && second === 0x02) return judgeEmbedded(2, 'relay_6to4');
  // fc00::/7 unique local.
  if ((first & 0xfe) === 0xfc) return blocked('unique_local');
  // fe80::/10 link local.
  if (first === 0xfe && (second & 0xc0) === 0x80) return blocked('link_local');
  // fec0::/10 deprecated site local.
  if (first === 0xfe && (second & 0xc0) === 0xc0) return blocked('site_local');
  // ff00::/8 multicast.
  if (first === 0xff) return blocked('multicast');

  return { version: 6, blocked: false, range: null };
}

/**
 * Strict dotted-quad only: four decimal octets, no leading zeros.
 *
 * Deliberately stricter than the URL parser. Hostnames reach this already
 * canonicalised by WHATWG; addresses from DNS arrive dotted. Anything else
 * ("0177.0.0.1", "127.1") is refused as not-an-address rather than guessed.
 */
function parseIpv4(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4) {
    return null;
  }
  let result = 0;
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (octet > 255) {
      return null;
    }
    result = (result * 256) + octet;
  }
  return result >>> 0;
}

/** Full RFC 4291 text form, with `::` and a trailing dotted IPv4. No zone ids. */
function parseIpv6(value: string): Uint8Array | null {
  if (value.length === 0 || value.includes('%')) {
    return null;
  }

  let text = value.toLowerCase();
  let tail: number[] = [];

  const lastColon = text.lastIndexOf(':');
  const lastGroup = text.slice(lastColon + 1);
  if (lastGroup.includes('.')) {
    const embedded = parseIpv4(lastGroup);
    if (embedded === null) {
      return null;
    }
    tail = [(embedded >>> 16) & 0xffff, embedded & 0xffff];
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }

  const doubleColons = text.split('::').length - 1;
  if (doubleColons > 1) {
    return null;
  }

  const readGroups = (segment: string): number[] | null => {
    if (segment === '') {
      return [];
    }
    const groups: number[] = [];
    for (const group of segment.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) {
        return null;
      }
      groups.push(parseInt(group, 16));
    }
    return groups;
  };

  let groups: number[];
  if (doubleColons === 1) {
    const [head, rest] = text.split('::');
    const headGroups = readGroups(head!);
    const restGroups = readGroups(rest!);
    if (headGroups === null || restGroups === null) {
      return null;
    }
    const missing = 8 - headGroups.length - restGroups.length;
    if (missing < 1) {
      return null;
    }
    groups = [...headGroups, ...new Array<number>(missing).fill(0), ...restGroups];
  } else {
    const all = readGroups(text);
    if (all === null || all.length !== 8) {
      return null;
    }
    groups = all;
  }

  if (tail.length === 2) {
    groups[6] = tail[0]!;
    groups[7] = tail[1]!;
  }

  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = (group >> 8) & 0xff;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}
