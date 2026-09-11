import {
  assertIdentityEncoding,
  buildGetRequest,
  contentTypeOf,
  decodeText,
  framingOf,
  HttpProtocolError,
  MAX_BODY_BYTES,
  MAX_HEADER_BYTES,
  readBody,
  readResponseHead,
} from './http1.ts';
import type { ByteReader } from './http1.ts';
import { classifyIpAddress, evaluateUrl } from './url-policy.ts';
import type { AcceptedUrl } from './url-policy.ts';

/**
 * safe-fetch — the only way the Shop Analyzer reaches a merchant's site.
 *
 * Every hop, the first request and each redirect alike, runs the whole chain:
 *
 *   evaluateUrl → HTTPS only → resolve A and AAAA ourselves → classify EVERY
 *   address (one blocked or unparseable address refuses the host) → connect
 *   to one validated IP (IPv4 first, IPv6 as fallback) → check the socket's
 *   remote address IS that IP → TLS with the ORIGINAL hostname, normal
 *   certificate validation → one GET → bounded response.
 *
 * WHY NOT fetch(). fetch() resolves the name again on its own, so the address
 * checked is not the address connected to: DNS rebinding wins that race. Here
 * the address is chosen once, pinned, and verified on the socket. Phases B.0 to
 * B.1b proved on the hosted runtime that pinning works over IPv4 and IPv6 and
 * that TLS still rejects wrong-host, self-signed and expired certificates.
 *
 * WHAT NEVER HAPPENS HERE: no fetch(), no connectTls, no certificate option of
 * any kind, no plain HTTP, no automatic redirect, no decompression, no body
 * returned to anyone but the extractor.
 *
 * Errors carry a closed code and a detail that never contains a URL, a
 * hostname or an address, so they are safe to log.
 */

export const SAFE_FETCH_LIMITS = {
  /** Whole operation, every hop included. */
  timeoutMs: 10_000,
  maxRedirects: 3,
  maxHeaderBytes: MAX_HEADER_BYTES,
  maxBodyBytes: MAX_BODY_BYTES,
  port: 443,
} as const;

export const SAFE_FETCH_ERROR_CODES = [
  'url_rejected',
  'scheme_not_allowed',
  'dns_failed',
  'no_address',
  'address_blocked',
  'connect_failed',
  'remote_address_mismatch',
  'tls_failed',
  'timeout',
  'aborted',
  'write_failed',
  'headers_too_large',
  'body_too_large',
  'malformed_response',
  'truncated_response',
  'content_encoding_not_allowed',
  'content_type_not_allowed',
  'http_status',
  'redirect_invalid',
  'redirect_downgrade',
  'redirect_loop',
  'redirect_limit',
] as const;
export type SafeFetchErrorCode = (typeof SAFE_FETCH_ERROR_CODES)[number];

export class SafeFetchError extends Error {
  readonly code: SafeFetchErrorCode;
  /** The HTTP status for `http_status`; null for everything else. */
  readonly status: number | null;

  constructor(code: SafeFetchErrorCode, detail: string, options: { status?: number } = {}) {
    super(`${code}: ${detail}`);
    this.name = 'SafeFetchError';
    this.code = code;
    this.status = options.status ?? null;
  }
}

// ---------------------------------------------------------------------------
// Transport — injected, so the whole policy is testable without a network
// ---------------------------------------------------------------------------

export type TlsStream = ByteReader & {
  write(data: Uint8Array): Promise<number>;
  close(): void;
};

export type TcpSocket = {
  /** The peer address as the runtime reports it, or null when unknown. */
  readonly remoteAddress: string | null;
  /**
   * TLS over this socket, validated against `hostname` with the runtime's
   * normal certificate checks. Resolves only after a completed handshake.
   */
  upgradeToTls(hostname: string): Promise<TlsStream>;
  close(): void;
};

export interface SiteTransport {
  /** An empty array means no record of that type. Anything else must throw. */
  resolve(hostname: string, recordType: 'A' | 'AAAA'): Promise<string[]>;
  connect(ip: string, port: number): Promise<TcpSocket>;
}

export type Clock = { now(): number };

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export type SafeFetchOptions = {
  /** Lowercased media types accepted for a 2xx body. */
  acceptedMediaTypes: readonly string[];
  /** robots.txt is often served without a Content-Type; a page never is. */
  allowMissingContentType?: boolean;
  /** Value of the Accept header. */
  accept: string;
  /** Lowered for robots.txt; never raised above the global cap. */
  maxBodyBytes?: number;
  /**
   * Absolute deadline (epoch ms). Shared by every hop, and by several fetches
   * when the caller passes the same value.
   */
  deadline: number;
  signal?: AbortSignal;
  /**
   * Runs before each hop connects, with the hop's validated URL. Throwing
   * stops the fetch with that error — this is where robots.txt is enforced.
   */
  beforeHop?: (url: AcceptedUrl) => Promise<void>;
};

export type SafeFetchResponse = {
  /** The final URL, after redirects, each of which was validated. */
  url: AcceptedUrl;
  redirectCount: number;
  status: number;
  mediaType: string | null;
  text: string;
  byteLength: number;
};

export type SafeFetcher = {
  fetch(url: string, options: SafeFetchOptions): Promise<SafeFetchResponse>;
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function createSafeFetcher(
  transport: SiteTransport,
  clock: Clock = { now: () => Date.now() }
): SafeFetcher {
  return {
    async fetch(input, options) {
      let current = acceptInitial(input);
      const visited = new Set<string>([current.url]);
      let redirectCount = 0;

      for (;;) {
        assertAlive(options, clock);
        if (options.beforeHop) {
          await options.beforeHop(current);
        }

        const hop = await fetchHop(transport, clock, current, options);
        if (hop.kind === 'response') {
          return { ...hop.response, url: current, redirectCount };
        }

        if (redirectCount >= SAFE_FETCH_LIMITS.maxRedirects) {
          throw new SafeFetchError('redirect_limit', `more than ${SAFE_FETCH_LIMITS.maxRedirects} redirects`);
        }
        const next = acceptRedirect(current, hop.location);
        if (visited.has(next.url)) {
          throw new SafeFetchError('redirect_loop', 'redirect returns to a visited URL');
        }
        visited.add(next.url);
        redirectCount += 1;
        current = next;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

function acceptInitial(input: string): AcceptedUrl {
  const policy = evaluateUrl(input);
  if (!policy.ok) {
    throw new SafeFetchError('url_rejected', policy.reason);
  }
  if (policy.scheme !== 'https') {
    throw new SafeFetchError('scheme_not_allowed', 'https only');
  }
  return policy;
}

function acceptRedirect(from: AcceptedUrl, location: string): AcceptedUrl {
  // The URL parser silently drops tabs and newlines; a Location that relies on
  // that does not mean what it looks like.
  if (/\s/.test(location)) {
    throw new SafeFetchError('redirect_invalid', 'whitespace in Location');
  }
  let absolute: string;
  try {
    absolute = new URL(location, from.url).href;
  } catch {
    throw new SafeFetchError('redirect_invalid', 'unparseable Location');
  }
  const policy = evaluateUrl(absolute);
  if (!policy.ok) {
    throw new SafeFetchError('redirect_invalid', policy.reason);
  }
  if (policy.scheme !== 'https') {
    throw new SafeFetchError('redirect_downgrade', 'redirect away from https');
  }
  return policy;
}

// ---------------------------------------------------------------------------
// One hop
// ---------------------------------------------------------------------------

type HopOutcome =
  | { kind: 'redirect'; location: string }
  | { kind: 'response'; response: Omit<SafeFetchResponse, 'url' | 'redirectCount'> };

async function fetchHop(
  transport: SiteTransport,
  clock: Clock,
  url: AcceptedUrl,
  options: SafeFetchOptions
): Promise<HopOutcome> {
  const addresses = await resolvePublicAddresses(transport, url.hostname, options, clock);
  const socket = await connectPinned(transport, addresses, options, clock);

  let stream: TlsStream;
  try {
    stream = await withinDeadline(socket.upgradeToTls(url.hostname), options, clock, closeQuietly);
  } catch (error) {
    closeQuietly(socket);
    if (error instanceof SafeFetchError) {
      throw error;
    }
    // The runtime's message can name the address or the certificate subject.
    // Only the class of failure leaves this function.
    throw new SafeFetchError('tls_failed', 'handshake failed');
  }

  try {
    return await exchange(stream, url, options, clock);
  } finally {
    closeQuietly(stream);
    closeQuietly(socket);
  }
}

async function resolvePublicAddresses(
  transport: SiteTransport,
  hostname: string,
  options: SafeFetchOptions,
  clock: Clock
): Promise<{ v4: string[]; v6: string[] }> {
  const lookup = async (recordType: 'A' | 'AAAA'): Promise<string[]> => {
    try {
      const answers = await withinDeadline(transport.resolve(hostname, recordType), options, clock);
      if (!Array.isArray(answers)) {
        throw new Error('not a list');
      }
      return answers;
    } catch (error) {
      if (error instanceof SafeFetchError) {
        throw error;
      }
      throw new SafeFetchError('dns_failed', `${recordType} lookup failed`);
    }
  };

  const [v4, v6] = await Promise.all([lookup('A'), lookup('AAAA')]);

  if (v4.length + v6.length === 0) {
    throw new SafeFetchError('no_address', 'no A or AAAA record');
  }

  // Every address, not only the one we would use: a name that resolves to a
  // public and a private address is one DNS change away from the private one.
  const check = (answers: readonly unknown[], version: 4 | 6) => {
    for (const address of answers) {
      const classification = typeof address === 'string' ? classifyIpAddress(address) : null;
      if (classification === null || classification.version !== version) {
        throw new SafeFetchError('address_blocked', 'unparseable address');
      }
      if (classification.blocked) {
        throw new SafeFetchError('address_blocked', classification.range ?? 'blocked range');
      }
    }
  };
  check(v4, 4);
  check(v6, 6);

  return { v4, v6 };
}

async function connectPinned(
  transport: SiteTransport,
  addresses: { v4: string[]; v6: string[] },
  options: SafeFetchOptions,
  clock: Clock
): Promise<TcpSocket> {
  // One attempt per family: enough to survive a broken family, bounded so a
  // host listing many records cannot stretch the deadline.
  const candidates = [addresses.v4[0], addresses.v6[0]].filter(
    (ip): ip is string => ip !== undefined
  );

  for (const ip of candidates) {
    let socket: TcpSocket;
    try {
      socket = await withinDeadline(transport.connect(ip, SAFE_FETCH_LIMITS.port), options, clock, closeQuietly);
    } catch (error) {
      if (error instanceof SafeFetchError) {
        // Timed out or cancelled: there is no budget left for another family.
        throw error;
      }
      continue;
    }

    // Strict string equality with the address we resolved and validated. A
    // runtime that formatted the same address differently would be refused
    // here — a false rejection, never a bypass. Phases B.1 and B.1b observed
    // Deno reporting exactly the resolved string, over IPv4 and IPv6.
    if (socket.remoteAddress !== ip) {
      closeQuietly(socket);
      throw new SafeFetchError('remote_address_mismatch', 'socket is not connected to the validated address');
    }
    return socket;
  }

  throw new SafeFetchError('connect_failed', 'no validated address accepted a connection');
}

async function exchange(
  stream: TlsStream,
  url: AcceptedUrl,
  options: SafeFetchOptions,
  clock: Clock
): Promise<HopOutcome> {
  let request: Uint8Array;
  try {
    request = buildGetRequest(url, options.accept);
  } catch {
    throw new SafeFetchError('url_rejected', 'request cannot be encoded safely');
  }

  try {
    let offset = 0;
    while (offset < request.length) {
      const written = await withinDeadline(stream.write(request.subarray(offset)), options, clock);
      if (!Number.isInteger(written) || written <= 0) {
        throw new Error('write made no progress');
      }
      offset += written;
    }
  } catch (error) {
    if (error instanceof SafeFetchError) {
      throw error;
    }
    throw new SafeFetchError('write_failed', 'request not sent');
  }

  const reader: ByteReader = {
    read: (buffer) => withinDeadline(stream.read(buffer), options, clock),
  };

  try {
    const { head, cursor } = await readResponseHead(reader, SAFE_FETCH_LIMITS.maxHeaderBytes);

    if (head.status < 200) {
      framingOf(head); // throws: an interim response is refused
    }

    if (REDIRECT_STATUSES.has(head.status)) {
      const locations = head.headers.get('location') ?? [];
      if (locations.length !== 1 || locations[0]!.length === 0) {
        throw new SafeFetchError('redirect_invalid', 'missing or repeated Location');
      }
      return { kind: 'redirect', location: locations[0]! };
    }

    if (head.status < 200 || head.status > 299) {
      // The status only. An error page's body is never read.
      throw new SafeFetchError('http_status', `status ${head.status}`, { status: head.status });
    }

    assertIdentityEncoding(head);
    const type = contentTypeOf(head);
    const typeAccepted =
      type.mediaType === null
        ? options.allowMissingContentType === true
        : options.acceptedMediaTypes.includes(type.mediaType);
    if (!typeAccepted) {
      throw new SafeFetchError('content_type_not_allowed', 'media type not accepted');
    }

    const limit = Math.min(options.maxBodyBytes ?? SAFE_FETCH_LIMITS.maxBodyBytes, SAFE_FETCH_LIMITS.maxBodyBytes);
    const body = await readBody(cursor, framingOf(head), limit);

    return {
      kind: 'response',
      response: {
        status: head.status,
        mediaType: type.mediaType,
        text: decodeText(body, type.charset),
        byteLength: body.length,
      },
    };
  } catch (error) {
    if (error instanceof SafeFetchError) {
      throw error;
    }
    if (error instanceof HttpProtocolError) {
      throw new SafeFetchError(error.code, 'response refused');
    }
    // A reset mid-read, or anything else the stream throws.
    throw new SafeFetchError('truncated_response', 'response unreadable');
  }
}

// ---------------------------------------------------------------------------
// Deadline and cleanup
// ---------------------------------------------------------------------------

function assertAlive(options: SafeFetchOptions, clock: Clock): void {
  if (options.signal?.aborted) {
    throw new SafeFetchError('aborted', 'cancelled by caller');
  }
  if (options.deadline - clock.now() <= 0) {
    throw new SafeFetchError('timeout', 'deadline reached');
  }
}

/**
 * Races one step against the shared deadline and the caller's signal.
 *
 * A step that settles after losing the race is not forgotten: `onLate`
 * receives its value, so a socket that connects after the deadline is closed
 * instead of leaking.
 */
function withinDeadline<T>(
  promise: Promise<T>,
  options: SafeFetchOptions,
  clock: Clock,
  onLate?: (value: T) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (action: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      options.signal?.removeEventListener('abort', onAbort);
      action();
    };
    const onAbort = () => finish(() => reject(new SafeFetchError('aborted', 'cancelled by caller')));

    promise.then(
      (value) => {
        if (settled) {
          onLate?.(value);
          return;
        }
        finish(() => resolve(value));
      },
      (error: unknown) => finish(() => reject(error))
    );

    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(
      () => finish(() => reject(new SafeFetchError('timeout', 'deadline reached'))),
      Math.max(0, options.deadline - clock.now())
    );
  });
}

function closeQuietly(resource: { close(): void }): void {
  try {
    resource.close();
  } catch {
    // Already closed, or consumed by a TLS upgrade: nothing left to release.
  }
}
