/**
 * A deliberately small HTTP/1.1 response reader, for safe-fetch only.
 *
 * WHY IT EXISTS. fetch() resolves the hostname itself, so the address we
 * validated is not necessarily the address it connects to (DNS rebinding), and
 * it cannot be pointed at a pinned IP while validating TLS against the original
 * name. safe-fetch therefore opens the socket itself, and something has to read
 * the bytes that come back. This is that something, and nothing more:
 *
 *   * one GET, `Connection: close` — no keep-alive, no pipelining;
 *   * status line and headers capped at 16 KiB, counted while reading;
 *   * body framed by Content-Length, chunked, or connection close, and capped
 *     WHILE READING — a declared length is never trusted as a limit;
 *   * any Content-Encoding other than identity is refused. We ask for identity,
 *     and a server that compresses anyway is not decompressed, so a small gzip
 *     can never expand into something huge;
 *   * ambiguous framing — Transfer-Encoding together with Content-Length,
 *     conflicting lengths, an unknown transfer coding — is refused, not guessed.
 *
 * PURE: it reads from any `ByteReader`, so every case is testable without a
 * socket and without a network.
 */

export const MAX_HEADER_BYTES = 16 * 1024;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

const MAX_HEADER_COUNT = 100;
const MAX_CHUNK_SIZE_LINE = 1024;
const MAX_TRAILER_LINES = 32;
const READ_SIZE = 16 * 1024;

// Built from char codes so the source file itself never carries a raw control
// byte, whatever tool writes it.
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const NUL = String.fromCharCode(0);
export const CRLF = CR + LF;

export const HTTP_PROTOCOL_ERRORS = [
  'headers_too_large',
  'body_too_large',
  'malformed_response',
  'truncated_response',
  'content_encoding_not_allowed',
] as const;
export type HttpProtocolErrorCode = (typeof HTTP_PROTOCOL_ERRORS)[number];

export class HttpProtocolError extends Error {
  readonly code: HttpProtocolErrorCode;

  constructor(code: HttpProtocolErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'HttpProtocolError';
    this.code = code;
  }
}

/** Anything that yields bytes: a TLS stream, or a fake in tests. */
export type ByteReader = { read(buffer: Uint8Array): Promise<number | null> };

export type HttpResponseHead = {
  httpVersion: '1.0' | '1.1';
  status: number;
  /** Lowercased names; every value kept, in order of appearance. */
  headers: ReadonlyMap<string, readonly string[]>;
};

export type BodyFraming =
  | { kind: 'none' }
  | { kind: 'length'; length: number }
  | { kind: 'chunked' }
  | { kind: 'until_close' };

// ---------------------------------------------------------------------------
// Byte cursor
// ---------------------------------------------------------------------------

/**
 * Buffered reads over a ByteReader, with CRLF line reads for the head and for
 * chunk-size lines. The buffer is compacted on every refill, so it never holds
 * more than one read plus an unfinished line.
 */
export class ByteCursor {
  private buffer: Uint8Array = new Uint8Array(0);
  private position = 0;
  private ended = false;

  constructor(private readonly source: ByteReader) {}

  private get available(): number {
    return this.buffer.length - this.position;
  }

  private async refill(): Promise<boolean> {
    if (this.ended) {
      return false;
    }
    const chunk = new Uint8Array(READ_SIZE);
    const count = await this.source.read(chunk);
    // Deno signals EOF with null. A zero-byte read cannot make progress, so it
    // is treated as EOF too rather than risking a spin.
    if (count === null || count <= 0) {
      this.ended = true;
      return false;
    }
    const rest = this.buffer.subarray(this.position);
    const next = new Uint8Array(rest.length + count);
    next.set(rest, 0);
    next.set(chunk.subarray(0, count), rest.length);
    this.buffer = next;
    this.position = 0;
    return true;
  }

  /** Up to `max` bytes; null only at end of stream. */
  async take(max: number): Promise<Uint8Array | null> {
    if (this.available === 0 && !(await this.refill())) {
      return null;
    }
    const count = Math.min(max, this.available);
    const out = this.buffer.slice(this.position, this.position + count);
    this.position += count;
    return out;
  }

  /** One CRLF-terminated line, without its CRLF, decoded as latin-1. */
  async line(maxLength: number, tooLong: HttpProtocolErrorCode): Promise<string> {
    let scanFrom = this.position;
    for (;;) {
      const at = indexOfCrlf(this.buffer, scanFrom);
      if (at >= 0) {
        if (at - this.position > maxLength) {
          throw new HttpProtocolError(tooLong, 'line too long');
        }
        const text = latin1(this.buffer.subarray(this.position, at));
        this.position = at + 2;
        return text;
      }
      if (this.available > maxLength + 1) {
        throw new HttpProtocolError(tooLong, 'line too long');
      }
      // Resume scanning one byte back, in case a CR ended the previous read.
      const resumeOffset = Math.max(0, this.buffer.length - 1 - this.position);
      if (!(await this.refill())) {
        throw new HttpProtocolError('truncated_response', 'stream ended inside a line');
      }
      scanFrom = this.position + resumeOffset;
    }
  }
}

function indexOfCrlf(buffer: Uint8Array, from: number): number {
  for (let i = Math.max(0, from); i + 1 < buffer.length; i += 1) {
    if (buffer[i] === 13 && buffer[i + 1] === 10) {
      return i;
    }
  }
  return -1;
}

function latin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 4096) {
    out += String.fromCharCode(...bytes.subarray(i, i + 4096));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Head
// ---------------------------------------------------------------------------

const STATUS_LINE = /^HTTP\/1\.([01]) ([1-5][0-9]{2})(?: .*)?$/;
const HEADER_LINE = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*?)[ \t]*$/;

/**
 * Reads the status line and headers, counting every byte against the cap.
 *
 * Returns the cursor positioned at the first body byte, so the body reader
 * continues exactly where the head ended.
 */
export async function readResponseHead(
  source: ByteReader,
  maxHeaderBytes: number = MAX_HEADER_BYTES
): Promise<{ head: HttpResponseHead; cursor: ByteCursor }> {
  const cursor = new ByteCursor(source);
  let budget = maxHeaderBytes;

  const statusLine = await cursor.line(Math.max(0, budget - 2), 'headers_too_large');
  budget -= statusLine.length + 2;
  const status = STATUS_LINE.exec(statusLine);
  if (!status) {
    throw new HttpProtocolError('malformed_response', 'status line');
  }

  const headers = new Map<string, string[]>();
  let count = 0;
  for (;;) {
    if (budget < 2) {
      throw new HttpProtocolError('headers_too_large', 'header section');
    }
    const line = await cursor.line(budget - 2, 'headers_too_large');
    budget -= line.length + 2;
    if (line === '') {
      break;
    }
    count += 1;
    if (count > MAX_HEADER_COUNT) {
      throw new HttpProtocolError('headers_too_large', 'too many headers');
    }
    // Obsolete line folding is a smuggling vector; RFC 9112 lets us refuse it.
    if (line.startsWith(' ') || line.startsWith('\t')) {
      throw new HttpProtocolError('malformed_response', 'folded header');
    }
    const header = HEADER_LINE.exec(line);
    if (!header) {
      throw new HttpProtocolError('malformed_response', 'header line');
    }
    const value = header[2]!;
    if (value.includes(CR) || value.includes(LF) || value.includes(NUL)) {
      throw new HttpProtocolError('malformed_response', 'control character in header');
    }
    const name = header[1]!.toLowerCase();
    const existing = headers.get(name);
    if (existing) {
      existing.push(value);
    } else {
      headers.set(name, [value]);
    }
  }

  return {
    head: {
      httpVersion: status[1] === '0' ? '1.0' : '1.1',
      status: Number(status[2]),
      headers,
    },
    cursor,
  };
}

/** Comma-separated list values across repeated headers, lowercased. */
function listValues(values: readonly string[] | undefined): string[] {
  return (values ?? [])
    .flatMap((value) => value.split(','))
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
}

export function headerValue(head: HttpResponseHead, name: string): string | null {
  const values = head.headers.get(name);
  return values && values.length > 0 ? values[0]! : null;
}

// ---------------------------------------------------------------------------
// Framing and encoding
// ---------------------------------------------------------------------------

export function framingOf(head: HttpResponseHead): BodyFraming {
  // We never send Expect, so an interim response is not something to wait out.
  if (head.status < 200) {
    throw new HttpProtocolError('malformed_response', 'interim response');
  }
  if (head.status === 204 || head.status === 304) {
    return { kind: 'none' };
  }

  const transferEncoding = head.headers.get('transfer-encoding');
  const contentLength = head.headers.get('content-length');

  if (transferEncoding !== undefined) {
    if (contentLength !== undefined) {
      throw new HttpProtocolError('malformed_response', 'Transfer-Encoding with Content-Length');
    }
    const codings = listValues(transferEncoding);
    if (codings.length !== 1 || codings[0] !== 'chunked') {
      throw new HttpProtocolError('malformed_response', 'unsupported transfer coding');
    }
    if (head.httpVersion === '1.0') {
      throw new HttpProtocolError('malformed_response', 'chunked on HTTP/1.0');
    }
    return { kind: 'chunked' };
  }

  if (contentLength !== undefined) {
    const lengths = new Set(listValues(contentLength));
    const [only] = [...lengths];
    if (lengths.size !== 1 || only === undefined || !/^[0-9]{1,15}$/.test(only)) {
      throw new HttpProtocolError('malformed_response', 'invalid Content-Length');
    }
    return { kind: 'length', length: Number(only) };
  }

  return { kind: 'until_close' };
}

/** Refuses any coding we did not ask for. `identity` is the only one accepted. */
export function assertIdentityEncoding(head: HttpResponseHead): void {
  const codings = listValues(head.headers.get('content-encoding'));
  if (codings.some((coding) => coding !== 'identity')) {
    throw new HttpProtocolError('content_encoding_not_allowed', 'non-identity content coding');
  }
}

export type ContentType = { mediaType: string | null; charset: string | null };

export function contentTypeOf(head: HttpResponseHead): ContentType {
  const values = head.headers.get('content-type') ?? [];
  const distinct = new Set(values.map((value) => value.trim().toLowerCase()));
  if (distinct.size > 1) {
    throw new HttpProtocolError('malformed_response', 'conflicting Content-Type');
  }
  const [raw] = [...distinct];
  if (raw === undefined || raw.length === 0) {
    return { mediaType: null, charset: null };
  }
  const [mediaType, ...parameters] = raw.split(';');
  let charset: string | null = null;
  for (const parameter of parameters) {
    const match = /^\s*charset\s*=\s*"?([a-z0-9._:-]{1,40})"?\s*$/.exec(parameter);
    if (match) {
      charset = match[1]!;
    }
  }
  return { mediaType: mediaType!.trim() || null, charset };
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

/** Reads a body under its framing, refusing more than `maxBytes` as it goes. */
export async function readBody(
  cursor: ByteCursor,
  framing: BodyFraming,
  maxBytes: number = MAX_BODY_BYTES
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;

  const collect = (part: Uint8Array) => {
    total += part.length;
    if (total > maxBytes) {
      throw new HttpProtocolError('body_too_large', `more than ${maxBytes} bytes`);
    }
    parts.push(part);
  };

  switch (framing.kind) {
    case 'none':
      break;

    case 'length': {
      // Refused up front when declared too large; still counted while reading,
      // because the declaration is only a claim.
      if (framing.length > maxBytes) {
        throw new HttpProtocolError('body_too_large', 'declared length over the limit');
      }
      let remaining = framing.length;
      while (remaining > 0) {
        const part = await cursor.take(remaining);
        if (part === null) {
          throw new HttpProtocolError('truncated_response', 'body shorter than Content-Length');
        }
        remaining -= part.length;
        collect(part);
      }
      break;
    }

    case 'chunked': {
      for (;;) {
        const sizeLine = await cursor.line(MAX_CHUNK_SIZE_LINE, 'malformed_response');
        // Chunk extensions after ';' carry nothing we use.
        const sizeText = sizeLine.split(';')[0]!.trim();
        if (!/^[0-9a-fA-F]{1,8}$/.test(sizeText)) {
          throw new HttpProtocolError('malformed_response', 'chunk size');
        }
        const size = Number.parseInt(sizeText, 16);
        if (size === 0) {
          // Trailers: read and discard until the empty line.
          for (let line = 0; ; line += 1) {
            if (line >= MAX_TRAILER_LINES) {
              throw new HttpProtocolError('malformed_response', 'too many trailers');
            }
            const trailer = await cursor.line(MAX_CHUNK_SIZE_LINE, 'malformed_response');
            if (trailer === '') {
              break;
            }
          }
          break;
        }
        if (total + size > maxBytes) {
          throw new HttpProtocolError('body_too_large', `more than ${maxBytes} bytes`);
        }
        let remaining = size;
        while (remaining > 0) {
          const part = await cursor.take(remaining);
          if (part === null) {
            throw new HttpProtocolError('truncated_response', 'stream ended inside a chunk');
          }
          remaining -= part.length;
          collect(part);
        }
        const terminator = await cursor.line(0, 'malformed_response');
        if (terminator !== '') {
          throw new HttpProtocolError('malformed_response', 'chunk not followed by CRLF');
        }
      }
      break;
    }

    case 'until_close': {
      for (;;) {
        const part = await cursor.take(READ_SIZE);
        if (part === null) {
          break;
        }
        collect(part);
      }
      break;
    }
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  return body;
}

/** Decodes with the declared charset, falling back to UTF-8 for unknown labels. */
export function decodeText(bytes: Uint8Array, charset: string | null): string {
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export const SHOP_DISCOVERY_USER_AGENT = 'ShopDiscoveryBot/1.0';

/**
 * The only request this client ever sends. The target and Host come from a URL
 * that already passed the url policy; both are re-checked here so that no
 * header or request line can ever carry whitespace or a control character.
 */
export function buildGetRequest(target: { url: string; hostname: string }, accept: string): Uint8Array {
  const parsed = new URL(target.url);
  const path = `${parsed.pathname}${parsed.search}`;
  if (!/^\/[!-~]*$/.test(path)) {
    throw new Error('request target contains forbidden characters');
  }
  if (!/^[a-z0-9.-]{1,253}$/.test(target.hostname)) {
    throw new Error('host contains forbidden characters');
  }
  if (!/^[!-~ ]{1,200}$/.test(accept)) {
    throw new Error('accept contains forbidden characters');
  }
  const lines = [
    `GET ${path} HTTP/1.1`,
    `Host: ${target.hostname}`,
    `User-Agent: ${SHOP_DISCOVERY_USER_AGENT}`,
    `Accept: ${accept}`,
    'Accept-Language: fr-FR,fr;q=0.9,en;q=0.6',
    'Accept-Encoding: identity',
    'Connection: close',
    '',
    '',
  ];
  return new TextEncoder().encode(lines.join(CRLF));
}
