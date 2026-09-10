import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeFailure, readPostgrestResponse, sanitize } from './postgrest.ts';

/**
 * The first suite is the regression: a successful write with an empty body was
 * reported as a failure, for ten rows that had already been committed.
 */

const JSON_TYPE = 'application/json; charset=utf-8';

describe('a successful write with no body', () => {
  it('accepts 201 with an empty body — the exact case that failed', () => {
    // `Prefer: return=minimal` answers 201 Created and sends nothing.
    assert.deepEqual(
      readPostgrestResponse({ status: 201, contentType: null, body: '' }),
      { ok: true, data: null }
    );
  });

  it('accepts 204', () => {
    assert.deepEqual(
      readPostgrestResponse({ status: 204, contentType: null, body: '' }),
      { ok: true, data: null }
    );
  });

  it('accepts 200 with an empty body', () => {
    assert.deepEqual(
      readPostgrestResponse({ status: 200, contentType: JSON_TYPE, body: '' }),
      { ok: true, data: null }
    );
  });

  it('accepts a body of nothing but whitespace', () => {
    assert.deepEqual(
      readPostgrestResponse({ status: 201, contentType: JSON_TYPE, body: '  \n ' }),
      { ok: true, data: null }
    );
  });

  it('never reports a 2xx as a failure, whatever the body', () => {
    for (const body of ['', '   ', '[]', '{"a":1}', 'not json at all']) {
      const result = readPostgrestResponse({ status: 201, contentType: JSON_TYPE, body });
      if (body === 'not json at all') {
        // Claimed JSON, was not: worth surfacing rather than swallowing.
        assert.equal(result.ok, false);
      } else {
        assert.equal(result.ok, true, `body ${JSON.stringify(body)} should succeed`);
      }
    }
  });
});

describe('a successful read', () => {
  it('parses a JSON array', () => {
    const result = readPostgrestResponse({
      status: 200,
      contentType: JSON_TYPE,
      body: '[{"shop_id":"a","source_hash":"h"}]',
    });
    assert.deepEqual(result, { ok: true, data: [{ shop_id: 'a', source_hash: 'h' }] });
  });

  it('ignores a non-JSON success body rather than guessing', () => {
    assert.deepEqual(
      readPostgrestResponse({ status: 200, contentType: 'text/csv', body: 'a,b\n1,2' }),
      { ok: true, data: null }
    );
  });
});

describe('failures', () => {
  it('extracts the PostgREST code and message', () => {
    const result = readPostgrestResponse({
      status: 403,
      contentType: JSON_TYPE,
      body: JSON.stringify({
        code: '42501',
        message: 'permission denied for table shops',
        hint: 'GRANT SELECT ON public.shops TO service_role',
      }),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 403);
    assert.equal(result.code, '42501');
    assert.ok(result.message.includes('permission denied for table shops'));
    assert.ok(result.message.includes('GRANT SELECT'));
  });

  it('survives an error body that is not JSON', () => {
    const result = readPostgrestResponse({
      status: 502,
      contentType: 'text/html',
      body: '<html>bad gateway</html>',
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 502);
    assert.equal(result.code, null);
    assert.equal(result.message, 'HTTP 502');
  });

  it('survives an empty error body', () => {
    const result = readPostgrestResponse({ status: 500, contentType: null, body: '' });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.message, 'HTTP 500');
  });

  it('reports malformed JSON on a 2xx instead of throwing', () => {
    const result = readPostgrestResponse({ status: 200, contentType: JSON_TYPE, body: '{oops' });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'invalid_json');
  });
});

describe('sanitize', () => {
  it('collapses an embedding rather than printing 1536 floats', () => {
    const vector = `[${Array.from({ length: 1536 }, (_, i) => (i / 1000).toFixed(4)).join(',')}]`;
    const cleaned = sanitize(`duplicate key value: ${vector}`);
    assert.ok(cleaned.includes('[vector]'), cleaned.slice(0, 80));
    assert.equal(cleaned.includes('0.0001'), false);
    assert.ok(cleaned.length < 200);
  });

  it('truncates a very long message', () => {
    assert.ok(sanitize('x'.repeat(5000)).length <= 301);
  });

  it('leaves an ordinary message readable', () => {
    assert.equal(sanitize('  permission   denied  '), 'permission denied');
  });
});

describe('describeFailure', () => {
  it('names status and code without inventing either', () => {
    assert.equal(
      describeFailure('embeddings', { ok: false, status: 403, code: '42501', message: 'nope' }),
      'embeddings: HTTP 403 code=42501 — nope'
    );
    assert.equal(
      describeFailure('embeddings', { ok: false, status: 500, code: null, message: 'HTTP 500' }),
      'embeddings: HTTP 500 — HTTP 500'
    );
  });
});
