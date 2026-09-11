import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertIdentityEncoding,
  buildGetRequest,
  contentTypeOf,
  decodeText,
  framingOf,
  HttpProtocolError,
  MAX_HEADER_BYTES,
  readBody,
  readResponseHead,
} from './http1.ts';
import type { ByteReader, HttpProtocolErrorCode } from './http1.ts';

const CRLF = String.fromCharCode(13, 10);
const lines = (...parts: string[]) => parts.join(CRLF);

function readerOf(raw: string | Uint8Array, chunk = 5): ByteReader {
  const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw;
  let offset = 0;
  return {
    read: async (buffer) => {
      if (offset >= bytes.length) return null;
      const count = Math.min(chunk, buffer.length, bytes.length - offset);
      buffer.set(bytes.subarray(offset, offset + count));
      offset += count;
      return count;
    },
  };
}

async function parse(raw: string, maxBody?: number, chunk?: number) {
  const { head, cursor } = await readResponseHead(readerOf(raw, chunk));
  const body = await readBody(cursor, framingOf(head), maxBody);
  return { head, text: new TextDecoder().decode(body) };
}

async function rejectsWith(promise: Promise<unknown>, code: HttpProtocolErrorCode) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof HttpProtocolError, String(error));
    assert.equal(error.code, code, error.message);
    return true;
  });
}

describe('http1 head', () => {
  it('reads the status line and every header, lowercased', async () => {
    const { head } = await parse(lines('HTTP/1.1 200 OK', 'Content-Type: text/html', 'Set-Cookie: a=1', 'set-cookie: b=2', 'Content-Length: 0', '', ''));
    assert.equal(head.status, 200);
    assert.equal(head.httpVersion, '1.1');
    assert.deepEqual(head.headers.get('set-cookie'), ['a=1', 'b=2']);
  });

  it('refuses a header section over 16 KiB, counted while reading', async () => {
    const big = 'a'.repeat(MAX_HEADER_BYTES);
    await rejectsWith(readResponseHead(readerOf(lines('HTTP/1.1 200 OK', `X-Big: ${big}`, '', ''), 1024)), 'headers_too_large');
  });

  it('refuses more than 100 headers', async () => {
    const many = Array.from({ length: 101 }, (_, i) => `X-${i}: v`);
    await rejectsWith(readResponseHead(readerOf(lines('HTTP/1.1 200 OK', ...many, '', ''))), 'headers_too_large');
  });

  it('refuses a malformed status line, a folded header and a header without a colon', async () => {
    await rejectsWith(readResponseHead(readerOf(lines('HTTP/2 200 OK', '', ''))), 'malformed_response');
    await rejectsWith(readResponseHead(readerOf(lines('HTTP/1.1 200 OK', 'X-A: 1', ' folded', '', ''))), 'malformed_response');
    await rejectsWith(readResponseHead(readerOf(lines('HTTP/1.1 200 OK', 'no colon here', '', ''))), 'malformed_response');
  });

  it('refuses a stream that ends inside the head', async () => {
    await rejectsWith(readResponseHead(readerOf('HTTP/1.1 200 OK' + CRLF + 'Content-Ty')), 'truncated_response');
    await rejectsWith(readResponseHead(readerOf('')), 'truncated_response');
  });
});

describe('http1 body framing', () => {
  it('reads a Content-Length body across tiny reads', async () => {
    const { text } = await parse(lines('HTTP/1.1 200 OK', 'Content-Length: 11', '', 'hello world'), undefined, 2);
    assert.equal(text, 'hello world');
  });

  it('reads a chunked body with extensions and trailers', async () => {
    const raw = lines('HTTP/1.1 200 OK', 'Transfer-Encoding: chunked', '', '5;ext=1', 'hello', '6', ' world', '0', 'X-Trailer: t', '', '');
    const { text } = await parse(raw, undefined, 3);
    assert.equal(text, 'hello world');
  });

  it('reads until close when there is no framing header', async () => {
    const { text } = await parse(lines('HTTP/1.1 200 OK', '', 'until the end'));
    assert.equal(text, 'until the end');
  });

  it('refuses ambiguous framing', async () => {
    const head = (headers: string[], version = '1.1') => lines(`HTTP/${version} 200 OK`, ...headers, '', '');
    await rejectsWith(parse(head(['Transfer-Encoding: chunked', 'Content-Length: 5'])), 'malformed_response');
    await rejectsWith(parse(head(['Content-Length: 5', 'Content-Length: 6'])), 'malformed_response');
    await rejectsWith(parse(head(['Content-Length: -1'])), 'malformed_response');
    await rejectsWith(parse(head(['Transfer-Encoding: gzip, chunked'])), 'malformed_response');
    await rejectsWith(parse(head(['Transfer-Encoding: chunked'], '1.0')), 'malformed_response');
  });

  it('refuses an interim response, and reads no body for 204', async () => {
    await rejectsWith(parse(lines('HTTP/1.1 100 Continue', '', '')), 'malformed_response');
    const { text } = await parse(lines('HTTP/1.1 204 No Content', 'Content-Length: 99', '', ''));
    assert.equal(text, '');
  });

  it('refuses a truncated body and a broken chunk', async () => {
    await rejectsWith(parse(lines('HTTP/1.1 200 OK', 'Content-Length: 50', '', 'short')), 'truncated_response');
    await rejectsWith(parse(lines('HTTP/1.1 200 OK', 'Transfer-Encoding: chunked', '', 'zz', 'x', '0', '', '')), 'malformed_response');
    await rejectsWith(parse(lines('HTTP/1.1 200 OK', 'Transfer-Encoding: chunked', '', '3', 'abcdef', '0', '', '')), 'malformed_response');
    await rejectsWith(parse(lines('HTTP/1.1 200 OK', 'Transfer-Encoding: chunked', '', '5', 'abc')), 'truncated_response');
  });
});

describe('http1 body limits', () => {
  it('refuses a declared length over the limit before reading it', async () => {
    await rejectsWith(parse(lines('HTTP/1.1 200 OK', 'Content-Length: 101', '', 'x'), 100), 'body_too_large');
  });

  it('refuses a chunked body that grows over the limit', async () => {
    const raw = lines('HTTP/1.1 200 OK', 'Transfer-Encoding: chunked', '', '32', 'a'.repeat(50), '32', 'b'.repeat(50), '32', 'c'.repeat(50), '0', '', '');
    await rejectsWith(parse(raw, 100), 'body_too_large');
  });

  it('refuses an unframed body that grows over the limit', async () => {
    await rejectsWith(parse(lines('HTTP/1.1 200 OK', '', 'z'.repeat(150)), 100), 'body_too_large');
  });
});

describe('http1 encoding and type', () => {
  const headOf = async (...headers: string[]) => (await readResponseHead(readerOf(lines('HTTP/1.1 200 OK', ...headers, '', '')))).head;

  it('accepts identity or no coding, refuses gzip and br', async () => {
    assertIdentityEncoding(await headOf());
    assertIdentityEncoding(await headOf('Content-Encoding: identity'));
    for (const coding of ['gzip', 'br', 'deflate', 'identity, gzip']) {
      const head = await headOf(`Content-Encoding: ${coding}`);
      assert.throws(() => assertIdentityEncoding(head), (error: unknown) => error instanceof HttpProtocolError && error.code === 'content_encoding_not_allowed');
    }
  });

  it('parses the media type and charset, and refuses conflicting types', async () => {
    assert.deepEqual(contentTypeOf(await headOf('Content-Type: Text/HTML; Charset="ISO-8859-1"')), { mediaType: 'text/html', charset: 'iso-8859-1' });
    assert.deepEqual(contentTypeOf(await headOf()), { mediaType: null, charset: null });
    const conflicting = await headOf('Content-Type: text/html', 'Content-Type: application/json');
    assert.throws(() => contentTypeOf(conflicting), HttpProtocolError);
  });

  it('decodes a declared charset and falls back to UTF-8 for an unknown one', () => {
    assert.equal(decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), 'windows-1252'), 'café');
    assert.equal(decodeText(new TextEncoder().encode('café'), 'not-a-charset'), 'café');
  });
});

describe('http1 request', () => {
  it('sends exactly one GET with identity encoding and Connection: close', () => {
    const request = new TextDecoder().decode(buildGetRequest({ url: 'https://shop.fr/a/b?x=1', hostname: 'shop.fr' }, 'text/html'));
    assert.equal(
      request,
      lines(
        'GET /a/b?x=1 HTTP/1.1',
        'Host: shop.fr',
        'User-Agent: ShopDiscoveryBot/1.0',
        'Accept: text/html',
        'Accept-Language: fr-FR,fr;q=0.9,en;q=0.6',
        'Accept-Encoding: identity',
        'Connection: close',
        '',
        ''
      )
    );
  });

  it('percent-encodes the target and refuses anything that could inject a header', () => {
    const request = new TextDecoder().decode(buildGetRequest({ url: 'https://shop.fr/a b', hostname: 'shop.fr' }, 'text/html'));
    assert.ok(request.startsWith('GET /a%20b HTTP/1.1'));
    assert.throws(() => buildGetRequest({ url: 'https://shop.fr/', hostname: `shop.fr${CRLF}X-Evil: 1` }, 'text/html'));
    assert.throws(() => buildGetRequest({ url: 'https://shop.fr/', hostname: 'shop.fr' }, `text/html${CRLF}X-Evil: 1`));
  });
});
