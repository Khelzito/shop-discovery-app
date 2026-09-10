import type {
  EmbeddingBatchResult,
  EmbeddingInput,
  EmbeddingResult,
} from '../contracts/embedding.ts';
import type { AiCallTelemetry, AiResult, ModelMetadata } from '../contracts/model.ts';
import {
  AiBadRequestError,
  AiProviderError,
  AiRateLimitError,
  AiTimeoutError,
  AiValidationError,
} from './errors.ts';
import type { FetchLike, HttpResponseLike } from './openai-search-intent.ts';
import type { AiRequestOptions, EmbeddingProvider } from './providers.ts';

/**
 * OpenAI adapter — the first concrete EmbeddingProvider.
 *
 * The second and last file in the codebase that knows OpenAI exists, and it
 * knows nothing else: everything upstream depends on `EmbeddingProvider`, so a
 * second vendor is a sibling file and a config value.
 *
 * Runs inside a Supabase Edge Function or a server-side script. The API key
 * comes from a server secret and never leaves this process — not returned, not
 * logged, and unreachable from the Expo bundle, which cannot resolve
 * `ai/server` at all.
 *
 * WHY THIS ADAPTER VALIDATES SO MUCH. A malformed intent is caught downstream
 * by a validator and the search degrades visibly. A malformed VECTOR does not
 * fail: it is stored, indexed, and quietly ranks every future search wrongly
 * with nothing to show for it. A wrong dimension, a reordered batch or a NaN
 * are all silent corruptions, so each is checked here rather than trusted.
 */

const CONTRACT_VERSION = 'embedding/1';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1/embeddings';

/** Decided in Prompt 15: the only dimension pgvector can index on `vector`. */
export const EMBEDDING_DIMENSIONS = 1536;

export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

/**
 * 10s rather than the 6s used for intent parsing.
 *
 * Embedding is not always interactive — the backfill runs offline — and a
 * batch of 96 texts legitimately takes longer than one short completion. The
 * search path protects itself by degrading to the factual arm, not by a
 * tighter deadline.
 */
export const DEFAULT_EMBEDDING_TIMEOUT_MS = 10_000;

/**
 * Inputs per request. The API accepts far more; this is a latency and
 * blast-radius choice, not a limit. One failed request re-embeds 96 texts, not
 * a whole catalogue.
 */
export const MAX_BATCH_INPUTS = 96;

/** Longest text sent. Beyond this the provider would reject the whole batch. */
export const MAX_INPUT_CHARS = 8_000;

export type OpenAiEmbeddingOptions = {
  apiKey: string;
  /** Defaults to text-embedding-3-small. */
  model?: string;
  /**
   * Requested dimension, sent explicitly rather than relying on the model's
   * default. If a future model version changed its native size, an implicit
   * default would silently produce vectors the column rejects.
   */
  dimensions?: number;
  timeoutMs?: number;
  baseUrl?: string;
  /** Injected in tests. Defaults to the runtime's global fetch. */
  fetchImpl?: FetchLike;
};

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'openai';

  constructor(private readonly options: OpenAiEmbeddingOptions) {
    if (options.apiKey.trim().length === 0) {
      throw new AiBadRequestError('An OpenAI API key is required to embed.');
    }
  }

  private get model(): string {
    return this.options.model?.trim() || DEFAULT_EMBEDDING_MODEL;
  }

  private get dimensions(): number {
    return this.options.dimensions ?? EMBEDDING_DIMENSIONS;
  }

  async embed(input: EmbeddingInput, options?: AiRequestOptions): Promise<AiResult<EmbeddingResult>> {
    const batch = await this.embedBatch([input], options);
    const first = batch.data.results[0];
    if (!first) {
      // Unreachable through embedBatch, which already enforces the count.
      // Kept because "unreachable" is a claim, and a silent undefined here
      // would be stored as a broken vector.
      throw new AiValidationError(
        'OpenAI returned no embedding for a single input.',
        ['data: empty'],
        { provider: this.id }
      );
    }
    return { data: first, model: batch.model, telemetry: batch.telemetry };
  }

  async embedBatch(
    inputs: readonly EmbeddingInput[],
    options?: AiRequestOptions
  ): Promise<AiResult<EmbeddingBatchResult>> {
    const texts = inputs.map((input, index) => this.toText(input, index));

    if (texts.length === 0) {
      throw new AiBadRequestError('Nothing to embed.');
    }
    if (texts.length > MAX_BATCH_INPUTS) {
      throw new AiBadRequestError(
        `Too many inputs in one batch: ${texts.length} > ${MAX_BATCH_INPUTS}.`
      );
    }

    const startedAt = Date.now();
    const response = await this.post(texts, options);
    const body = await response.text();

    if (!response.ok) {
      // The provider's message can echo the input and name internals, so only
      // the class of failure and its status cross this boundary. The status is
      // carried structurally rather than only in the text: a caller diagnosing
      // an outage needs 401 (wrong or unscoped key) told apart from 404 (model
      // unavailable) and 500 (their problem), and parsing that back out of a
      // sentence is not a contract.
      if (response.status === 429) {
        throw new AiRateLimitError('OpenAI rate limit reached.', {
          provider: this.id,
          status: response.status,
        });
      }
      throw new AiProviderError(`OpenAI returned status ${response.status}.`, {
        provider: this.id,
        status: response.status,
      });
    }

    const envelope = asRecord(parseJson(body, this.id));
    const vectors = this.readVectors(envelope, texts.length);

    const model: ModelMetadata = {
      provider: this.id,
      model: this.model,
      modelVersion: typeof envelope.model === 'string' ? envelope.model : null,
      contractVersion: CONTRACT_VERSION,
    };

    const usage = asRecord(envelope.usage);
    const telemetry: AiCallTelemetry = {
      operation: 'embedding',
      provider: this.id,
      model: this.model,
      latencyMs: Date.now() - startedAt,
      outcome: 'success',
      ...(typeof usage.prompt_tokens === 'number' ? { inputTokens: usage.prompt_tokens } : {}),
    };

    return {
      data: {
        results: vectors.map((vector) => ({
          vector,
          dimensions: vector.length,
          model,
          // The caller owns the hash: it knows which text and which version
          // produced this, and the provider deliberately does not.
          sourceHash: null,
        })),
        model,
      },
      model,
      telemetry,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Text only. The union allows images; this vendor endpoint does not. */
  private toText(input: EmbeddingInput, index: number): string {
    if (input.modality !== 'text') {
      throw new AiBadRequestError(
        `Input ${index} is an image. This provider embeds text only.`
      );
    }
    const text = input.text.trim();
    if (text.length === 0) {
      // An empty string produces a vector, and that vector is meaningless —
      // it would sit at a fixed point every empty shop converges on.
      throw new AiBadRequestError(`Input ${index} is empty.`);
    }
    if (text.length > MAX_INPUT_CHARS) {
      throw new AiBadRequestError(
        `Input ${index} is ${text.length} characters, over the ${MAX_INPUT_CHARS} limit.`
      );
    }
    return text;
  }

  private async post(
    texts: readonly string[],
    options?: AiRequestOptions
  ): Promise<HttpResponseLike> {
    const doFetch = this.options.fetchImpl ?? globalFetch();
    const timeoutMs = options?.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_EMBEDDING_TIMEOUT_MS;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const caller = options?.signal;
    if (caller) {
      if (caller.aborted) {
        controller.abort();
      } else {
        caller.addEventListener('abort', () => controller.abort(), { once: true });
      }
    }

    try {
      return await doFetch(this.options.baseUrl ?? DEFAULT_BASE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          input: [...texts],
          dimensions: this.dimensions,
          encoding_format: 'float',
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbort(error)) {
        throw new AiTimeoutError(`OpenAI did not answer within ${timeoutMs}ms.`, {
          provider: this.id,
          cause: error,
        });
      }
      throw new AiProviderError('OpenAI could not be reached.', {
        provider: this.id,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Turns the response into vectors, refusing anything it cannot fully verify.
   *
   * Ordering is the subtle one. The API documents `index` on each item, and
   * results[i] must correspond to inputs[i] per our contract. Trusting array
   * order would misattribute every vector in a batch if the provider ever
   * reordered them — a corruption with no symptom other than bad search.
   */
  private readVectors(envelope: Record<string, unknown>, expected: number): number[][] {
    const issues: string[] = [];
    const items = Array.isArray(envelope.data) ? envelope.data : null;

    if (items === null) {
      throw new AiValidationError('OpenAI returned no embedding list.', ['data: not an array'], {
        provider: this.id,
      });
    }
    if (items.length !== expected) {
      throw new AiValidationError(
        'OpenAI returned a different number of embeddings than inputs.',
        [`data: expected ${expected} items, received ${items.length}`],
        { provider: this.id }
      );
    }

    const byIndex = new Array<number[] | undefined>(expected);

    items.forEach((item, position) => {
      const record = asRecord(item);
      const index = typeof record.index === 'number' ? record.index : position;

      if (!Number.isInteger(index) || index < 0 || index >= expected) {
        issues.push(`data[${position}].index: ${String(record.index)} is out of range`);
        return;
      }
      if (byIndex[index] !== undefined) {
        issues.push(`data[${position}].index: ${index} appears twice`);
        return;
      }
      if (!Array.isArray(record.embedding)) {
        issues.push(`data[${position}].embedding: not an array`);
        return;
      }
      if (record.embedding.length !== this.dimensions) {
        issues.push(
          `data[${position}].embedding: ${record.embedding.length} dimensions, expected ${this.dimensions}`
        );
        return;
      }
      if (!record.embedding.every((value) => typeof value === 'number' && Number.isFinite(value))) {
        // A NaN survives storage and poisons every distance it takes part in.
        issues.push(`data[${position}].embedding: contains a non-finite value`);
        return;
      }

      byIndex[index] = normalize(record.embedding as number[]);
    });

    if (issues.length > 0) {
      throw new AiValidationError('OpenAI returned unusable embeddings.', issues, {
        provider: this.id,
      });
    }

    return byIndex.map((vector, index) => {
      if (vector === undefined) {
        throw new AiValidationError(
          'OpenAI skipped an input.',
          [`data: no embedding carried index ${index}`],
          { provider: this.id }
        );
      }
      return vector;
    });
  }
}

/**
 * L2-normalises, so the migration's claim that stored vectors are normalised
 * is true by construction rather than by trusting the provider.
 *
 * text-embedding-3 already returns unit vectors at their native size, so this
 * is a no-op within float error today. It stops being one the moment a
 * shortened dimension is requested, which the API explicitly does NOT
 * normalise — and cosine would then disagree with inner product.
 */
export function normalize(vector: readonly number[]): number[] {
  let sumOfSquares = 0;
  for (const value of vector) {
    sumOfSquares += value * value;
  }
  const norm = Math.sqrt(sumOfSquares);
  // A zero vector has no direction; scaling it would divide by zero. It cannot
  // come from a non-empty input, and is returned untouched rather than turned
  // into NaNs if it ever does.
  if (norm === 0 || !Number.isFinite(norm)) {
    return [...vector];
  }
  return vector.map((value) => value / norm);
}

function parseJson(body: string, provider: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new AiValidationError('OpenAI returned a body that is not JSON.', ['body: invalid JSON'], {
      provider,
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: string }).name === 'AbortError';
}

function globalFetch(): FetchLike {
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  if (typeof candidate !== 'function') {
    throw new AiProviderError('No fetch implementation is available.', { provider: 'openai' });
  }
  return candidate as FetchLike;
}
