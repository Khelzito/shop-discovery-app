import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AiError } from './errors.ts';
import {
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  MAX_BATCH_INPUTS,
  MAX_INPUT_CHARS,
  OpenAiEmbeddingProvider,
  normalize,
} from './openai-embedding.ts';
import type { FetchLike, HttpResponseLike } from './openai-search-intent.ts';

/**
 * Every request is served by an injected fake. Nothing here reaches the
 * network, and no test can spend a cent of provider quota — an embedding suite
 * that called the real API would be both slow and a bill.
 */

type Capture = { url: string; headers: Record<string, string>; body: unknown };

function respond(status: number, payload: unknown): HttpResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: () => Promise.resolve(typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

/** A deterministic vector of the right size, distinguishable per seed. */
function vector(seed: number, dimensions = EMBEDDING_DIMENSIONS): number[] {
  return Array.from({ length: dimensions }, (_, i) => Math.sin(seed + i) * 0.01);
}

function okPayload(count: number, dimensions = EMBEDDING_DIMENSIONS): unknown {
  return {
    object: 'list',
    model: 'text-embedding-3-small',
    data: Array.from({ length: count }, (_, index) => ({
      object: 'embedding',
      index,
      embedding: vector(index + 1, dimensions),
    })),
    usage: { prompt_tokens: 12 * count, total_tokens: 12 * count },
  };
}

function providerWith(
  handler: (capture: Capture) => HttpResponseLike | Promise<HttpResponseLike>,
  captures: Capture[] = []
): OpenAiEmbeddingProvider {
  const fetchImpl: FetchLike = (url, init) => {
    const capture: Capture = {
      url,
      headers: init.headers,
      body: JSON.parse(init.body) as unknown,
    };
    captures.push(capture);
    return Promise.resolve(handler(capture));
  };
  return new OpenAiEmbeddingProvider({ apiKey: 'sk-test-not-a-real-key', fetchImpl });
}

const TEXT = { modality: 'text', text: 'Nom: Maison Léon\nPays: FR' } as const;

async function rejection(promise: Promise<unknown>): Promise<AiError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AiError, `expected an AiError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected the call to reject');
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

describe('the request sent to the provider', () => {
  it('asks for the agreed model and dimension explicitly', async () => {
    const captures: Capture[] = [];
    await providerWith(() => respond(200, okPayload(1)), captures).embed(TEXT);

    const body = captures[0]?.body as Record<string, unknown>;
    assert.equal(body.model, DEFAULT_EMBEDDING_MODEL);
    assert.equal(body.dimensions, EMBEDDING_DIMENSIONS);
    assert.equal(body.encoding_format, 'float');
    assert.deepEqual(body.input, [TEXT.text]);
  });

  it('sends the key as a bearer token and nowhere else', async () => {
    const captures: Capture[] = [];
    await providerWith(() => respond(200, okPayload(1)), captures).embed(TEXT);

    assert.equal(captures[0]?.headers.Authorization, 'Bearer sk-test-not-a-real-key');
    assert.equal(JSON.stringify(captures[0]?.body).includes('sk-test'), false);
    assert.equal(captures[0]?.url.includes('sk-test'), false);
  });

  it('refuses to construct without a key', () => {
    assert.throws(() => new OpenAiEmbeddingProvider({ apiKey: '   ' }), AiError);
  });
});

// ---------------------------------------------------------------------------
// Success
// ---------------------------------------------------------------------------

describe('a successful embedding', () => {
  it('reports the dimension it actually received rather than assuming one', async () => {
    const result = await providerWith(() => respond(200, okPayload(1))).embed(TEXT);

    assert.equal(result.data.dimensions, EMBEDDING_DIMENSIONS);
    assert.equal(result.data.vector.length, EMBEDDING_DIMENSIONS);
    assert.equal(result.model.model, DEFAULT_EMBEDDING_MODEL);
    assert.equal(result.model.contractVersion, 'embedding/1');
    assert.equal(result.telemetry.operation, 'embedding');
    assert.equal(result.telemetry.outcome, 'success');
    assert.equal(result.telemetry.inputTokens, 12);
  });

  it('leaves sourceHash to the caller', async () => {
    const result = await providerWith(() => respond(200, okPayload(1))).embed(TEXT);
    assert.equal(result.data.sourceHash, null);
  });

  it('returns L2-normalised vectors', async () => {
    const result = await providerWith(() => respond(200, okPayload(1))).embed(TEXT);
    const norm = Math.sqrt(result.data.vector.reduce((sum, v) => sum + v * v, 0));
    assert.ok(Math.abs(norm - 1) < 1e-9, `norm was ${norm}`);
  });

  it('keeps batch order: results[i] belongs to inputs[i]', async () => {
    const batch = await providerWith(() => respond(200, okPayload(3))).embedBatch([
      { modality: 'text', text: 'un' },
      { modality: 'text', text: 'deux' },
      { modality: 'text', text: 'trois' },
    ]);

    assert.equal(batch.data.results.length, 3);
    // Each seeded vector is distinct, so a reorder would be visible.
    const firsts = batch.data.results.map((r) => r.vector[0]);
    assert.equal(new Set(firsts).size, 3);
  });

  it('reorders a response that arrives out of order', async () => {
    // The API documents `index`; array position is not the contract.
    const shuffled = {
      object: 'list',
      model: 'text-embedding-3-small',
      data: [
        { object: 'embedding', index: 2, embedding: vector(300) },
        { object: 'embedding', index: 0, embedding: vector(100) },
        { object: 'embedding', index: 1, embedding: vector(200) },
      ],
    };
    const batch = await providerWith(() => respond(200, shuffled)).embedBatch([
      { modality: 'text', text: 'un' },
      { modality: 'text', text: 'deux' },
      { modality: 'text', text: 'trois' },
    ]);

    assert.deepEqual(batch.data.results[0]?.vector, normalize(vector(100)));
    assert.deepEqual(batch.data.results[1]?.vector, normalize(vector(200)));
    assert.deepEqual(batch.data.results[2]?.vector, normalize(vector(300)));
  });
});

// ---------------------------------------------------------------------------
// Input guards
// ---------------------------------------------------------------------------

describe('input validation', () => {
  it('rejects an empty batch', async () => {
    const error = await rejection(providerWith(() => respond(200, okPayload(0))).embedBatch([]));
    assert.equal(error.code, 'ai_bad_request');
  });

  it('rejects a batch beyond the cap', async () => {
    const inputs = Array.from({ length: MAX_BATCH_INPUTS + 1 }, (_, i) => ({
      modality: 'text' as const,
      text: `texte ${i}`,
    }));
    const error = await rejection(providerWith(() => respond(200, okPayload(1))).embedBatch(inputs));
    assert.equal(error.code, 'ai_bad_request');
  });

  it('rejects an empty text rather than embedding nothing', async () => {
    const error = await rejection(
      providerWith(() => respond(200, okPayload(1))).embed({ modality: 'text', text: '   ' })
    );
    assert.equal(error.code, 'ai_bad_request');
  });

  it('rejects an oversized text', async () => {
    const error = await rejection(
      providerWith(() => respond(200, okPayload(1))).embed({
        modality: 'text',
        text: 'a'.repeat(MAX_INPUT_CHARS + 1),
      })
    );
    assert.equal(error.code, 'ai_bad_request');
  });

  it('rejects the image modality this endpoint cannot serve', async () => {
    const error = await rejection(
      providerWith(() => respond(200, okPayload(1))).embed({
        modality: 'image',
        imageUrl: 'https://example.com/a.png',
      })
    );
    assert.equal(error.code, 'ai_bad_request');
  });
});

// ---------------------------------------------------------------------------
// Response validation — silent corruption is the risk
// ---------------------------------------------------------------------------

describe('response validation', () => {
  it('rejects a wrong dimension instead of storing it', async () => {
    const error = await rejection(
      providerWith(() => respond(200, okPayload(1, 768))).embed(TEXT)
    );
    assert.equal(error.code, 'ai_validation_failed');
  });

  it('rejects a vector containing a non-finite value', async () => {
    // JSON has no NaN, so a provider bug arrives as null or a string.
    const poisoned = okPayload(1) as { data: { embedding: unknown[] }[] };
    poisoned.data[0]!.embedding[5] = null;
    const error = await rejection(providerWith(() => respond(200, poisoned)).embed(TEXT));
    assert.equal(error.code, 'ai_validation_failed');
  });

  it('rejects a count that does not match the inputs', async () => {
    const error = await rejection(
      providerWith(() => respond(200, okPayload(2))).embedBatch([{ modality: 'text', text: 'un' }])
    );
    assert.equal(error.code, 'ai_validation_failed');
  });

  it('rejects a duplicated index', async () => {
    const duplicated = {
      data: [
        { index: 0, embedding: vector(1) },
        { index: 0, embedding: vector(2) },
      ],
    };
    const error = await rejection(
      providerWith(() => respond(200, duplicated)).embedBatch([
        { modality: 'text', text: 'un' },
        { modality: 'text', text: 'deux' },
      ])
    );
    assert.equal(error.code, 'ai_validation_failed');
  });

  it('rejects an out-of-range index', async () => {
    const bad = { data: [{ index: 7, embedding: vector(1) }] };
    const error = await rejection(providerWith(() => respond(200, bad)).embed(TEXT));
    assert.equal(error.code, 'ai_validation_failed');
  });

  it('rejects a missing data list', async () => {
    const error = await rejection(providerWith(() => respond(200, { object: 'list' })).embed(TEXT));
    assert.equal(error.code, 'ai_validation_failed');
  });

  it('rejects a body that is not JSON', async () => {
    const error = await rejection(providerWith(() => respond(200, '<html>502</html>')).embed(TEXT));
    assert.equal(error.code, 'ai_validation_failed');
  });
});

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

describe('provider failures', () => {
  it('maps 429 to a rate-limit error', async () => {
    const error = await rejection(providerWith(() => respond(429, { error: {} })).embed(TEXT));
    assert.equal(error.code, 'ai_rate_limited');
    assert.equal(error.retryable, true);
  });

  it('maps any other non-2xx to a provider error', async () => {
    const error = await rejection(providerWith(() => respond(500, { error: {} })).embed(TEXT));
    assert.equal(error.code, 'ai_provider_error');
  });

  it('never propagates the provider message to the caller', async () => {
    const leaky = { error: { message: 'org org-secret quota for sk-live-abc exceeded' } };
    const error = await rejection(providerWith(() => respond(400, leaky)).embed(TEXT));
    assert.equal(error.message.includes('sk-live-abc'), false);
    assert.equal(error.message.includes('org-secret'), false);
  });

  it('maps an abort to a timeout error', async () => {
    const provider = new OpenAiEmbeddingProvider({
      apiKey: 'sk-test',
      timeoutMs: 5,
      fetchImpl: () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => {
            const abort = new Error('aborted');
            abort.name = 'AbortError';
            reject(abort);
          }, 10);
        }),
    });

    const error = await rejection(provider.embed(TEXT));
    assert.equal(error.code, 'ai_timeout');
    assert.equal(error.retryable, true);
  });

  it('maps a transport failure to a provider error', async () => {
    const provider = new OpenAiEmbeddingProvider({
      apiKey: 'sk-test',
      fetchImpl: () => Promise.reject(new Error('ECONNRESET')),
    });
    const error = await rejection(provider.embed(TEXT));
    assert.equal(error.code, 'ai_provider_error');
  });

  it('honours a caller signal that is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new OpenAiEmbeddingProvider({
      apiKey: 'sk-test',
      fetchImpl: (_url, init) =>
        init.signal?.aborted
          ? Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          : Promise.resolve(respond(200, okPayload(1))),
    });

    const error = await rejection(provider.embed(TEXT, { signal: controller.signal }));
    assert.equal(error.code, 'ai_timeout');
  });
});

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------

describe('normalize', () => {
  it('produces a unit vector', () => {
    const unit = normalize([3, 4]);
    assert.deepEqual(unit, [0.6, 0.8]);
  });

  it('leaves an already-normalised vector alone', () => {
    assert.deepEqual(normalize([1, 0, 0]), [1, 0, 0]);
  });

  it('returns a zero vector untouched rather than dividing by zero', () => {
    assert.deepEqual(normalize([0, 0, 0]), [0, 0, 0]);
  });
});
