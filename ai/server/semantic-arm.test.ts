import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { emptySearchIntent } from '../contracts/search-intent.ts';
import type { SearchIntent } from '../contracts/search-intent.ts';
import {
  AiBadRequestError,
  AiProviderError,
  AiRateLimitError,
  AiTimeoutError,
  AiUnavailableError,
  AiValidationError,
} from './errors.ts';
import {
  classifyEmbeddingFailure,
  decideSemanticArm,
  expandAudiences,
  hasSoftSignals,
  nullIfEmpty,
  parseSemanticMatches,
  sanitizeLogMessage,
} from './semantic-arm.ts';

function intent(
  query: string,
  parts: { hard?: Partial<SearchIntent['hard']>; soft?: Partial<SearchIntent['soft']>; semanticQuery?: string } = {}
): SearchIntent {
  const base = emptySearchIntent(query, 'model');
  return {
    ...base,
    semanticQuery: parts.semanticQuery ?? query,
    hard: { ...base.hard, ...parts.hard },
    soft: { ...base.soft, ...parts.soft },
  };
}

describe('decideSemanticArm', () => {
  it('skips a query fully expressed by its category filter', () => {
    // "sneakers françaises": the catalogue answers this exactly.
    const decision = decideSemanticArm(
      intent('sneakers françaises', {
        hard: { categorySlugs: ['sneakers'], countryCodes: ['FR'] },
      })
    );
    assert.deepEqual(decision, { run: false, reason: 'fully_factual' });
  });

  it('runs when a category is paired with a judgement', () => {
    const decision = decideSemanticArm(
      intent('des sneakers minimalistes', {
        hard: { categorySlugs: ['sneakers'] },
        soft: { styles: ['minimaliste'] },
      })
    );
    assert.deepEqual(decision, { run: true });
  });

  it('runs for a country-only query, which says nothing about what is wanted', () => {
    const decision = decideSemanticArm(
      intent('une marque française', { hard: { countryCodes: ['FR'] } })
    );
    assert.deepEqual(decision, { run: true });
  });

  it('runs for the four acceptance queries that need meaning', () => {
    const queries: SearchIntent[] = [
      intent('une marque minimaliste pour homme', {
        hard: { audiences: ['men'] },
        soft: { styles: ['minimaliste'] },
      }),
      intent('une marque française avec un style minimaliste', {
        hard: { countryCodes: ['FR'] },
        soft: { styles: ['minimaliste'] },
      }),
      intent('je veux trouver un cadeau original'),
      intent('des bijoux élégants mais pas trop classiques', {
        hard: { categorySlugs: ['bijoux'] },
        soft: { styles: ['élégant'] },
      }),
    ];

    for (const candidate of queries) {
      assert.deepEqual(
        decideSemanticArm(candidate),
        { run: true },
        `expected to run for "${candidate.originalQuery}"`
      );
    }
  });

  it('runs for a vague query with no structure at all', () => {
    assert.deepEqual(decideSemanticArm(intent('je veux trouver un cadeau original')), { run: true });
  });

  it('skips when the semantic query was stripped to nothing', () => {
    const decision = decideSemanticArm(
      intent('FR', { semanticQuery: '  ', hard: { countryCodes: ['FR'] } })
    );
    assert.deepEqual(decision, { run: false, reason: 'empty_semantic_query' });
  });

  it('treats a popularity preference as a soft signal', () => {
    const decision = decideSemanticArm(
      intent('des sneakers peu connues', {
        hard: { categorySlugs: ['sneakers'] },
        soft: { popularity: 'prefer_lesser_known' },
      })
    );
    assert.deepEqual(decision, { run: true });
  });
});

/**
 * `embedding_failed` is the right answer to the client and was the wrong thing
 * to write in the log. These tests pin the six categories apart, because an
 * outage that logs one indistinguishable line cannot be acted on.
 */
describe('classifyEmbeddingFailure', () => {
  it('separates a refused request from an unreachable provider', () => {
    // The distinction the old log could not make: both were AiProviderError.
    const refused = classifyEmbeddingFailure(
      new AiProviderError('OpenAI returned status 401.', { provider: 'openai', status: 401 })
    );
    assert.equal(refused.category, 'provider_http_error');
    assert.equal(refused.status, 401);

    const unreachable = classifyEmbeddingFailure(
      new AiProviderError('OpenAI could not be reached.', { provider: 'openai' })
    );
    assert.equal(unreachable.category, 'network_error');
    assert.equal(unreachable.status, null);
  });

  it('maps each error class to its category', () => {
    const cases: [unknown, string][] = [
      [new AiUnavailableError('no provider'), 'missing_secret'],
      [new AiTimeoutError('too slow'), 'network_error'],
      [new AiRateLimitError('slow down'), 'provider_http_error'],
      [new AiBadRequestError('empty input'), 'invalid_provider_response'],
      [new AiValidationError('bad shape', ['data: not an array']), 'invalid_provider_response'],
    ];
    for (const [error, category] of cases) {
      assert.equal(classifyEmbeddingFailure(error).category, category, String(category));
    }
  });

  it('gives a width mismatch its own category', () => {
    // The model or the configured dimension moved; the column would reject it
    // too, so it must not read as a generic bad response.
    const error = new AiValidationError('OpenAI returned unusable embeddings.', [
      'data[0].embedding: 768 dimensions, expected 1536',
    ]);
    const failure = classifyEmbeddingFailure(error);
    assert.equal(failure.category, 'dimension_mismatch');
    assert.equal(failure.code, 'ai_validation_failed');
  });

  it('defaults a rate limit to 429 when no status was recorded', () => {
    assert.equal(classifyEmbeddingFailure(new AiRateLimitError('slow')).status, 429);
  });

  it('survives something that is not an Error at all', () => {
    for (const thrown of [null, undefined, 'boom', 42]) {
      const failure = classifyEmbeddingFailure(thrown);
      assert.equal(failure.category, 'unknown_error');
    }
  });

  it('never lets a credential reach the log', () => {
    const leaky = new AiProviderError(
      'refused for key sk-proj-LEAKED and token eyJhbGciOiJIUzI1NiJ9abcdefghij',
      { status: 401 }
    );
    const failure = classifyEmbeddingFailure(leaky);
    assert.equal(failure.message.includes('sk-proj-LEAKED'), false);
    assert.equal(failure.message.includes('eyJhbGciOiJIUzI1NiJ9'), false);
    assert.ok(failure.message.includes('<redacted>'));
  });

  it('never lets a vector reach the log', () => {
    const vector = `[${Array.from({ length: 1536 }, (_, i) => (i / 1000).toFixed(4)).join(',')}]`;
    const failure = classifyEmbeddingFailure(new AiProviderError(`rejected ${vector}`));
    assert.ok(failure.message.includes('[vector]'));
    assert.ok(failure.message.length <= 201);
  });
});

describe('sanitizeLogMessage', () => {
  it('leaves an ordinary message readable', () => {
    assert.equal(sanitizeLogMessage('  OpenAI returned   status 500. '), 'OpenAI returned status 500.');
  });

  it('bounds the length', () => {
    assert.ok(sanitizeLogMessage('x'.repeat(5000)).length <= 201);
  });
});

describe('parseSemanticMatches', () => {
  it('reads a well-formed RPC result', () => {
    assert.deepEqual(
      parseSemanticMatches([
        { shop_id: 'a', similarity: 0.82 },
        { shop_id: 'b', similarity: 0.41 },
      ]),
      [
        { shopId: 'a', similarity: 0.82 },
        { shopId: 'b', similarity: 0.41 },
      ]
    );
  });

  it('drops a row with a non-finite similarity instead of ranking with it', () => {
    // One NaN would flow into the score arithmetic and scramble the page.
    assert.deepEqual(
      parseSemanticMatches([
        { shop_id: 'a', similarity: 0.5 },
        { shop_id: 'b', similarity: Number.NaN },
        { shop_id: 'c', similarity: Number.POSITIVE_INFINITY },
      ]),
      [{ shopId: 'a', similarity: 0.5 }]
    );
  });

  it('drops rows that are the wrong shape', () => {
    assert.deepEqual(
      parseSemanticMatches([
        null,
        'nope',
        {},
        { shop_id: 42, similarity: 0.5 },
        { shop_id: '', similarity: 0.5 },
        { shop_id: 'ok', similarity: '0.5' },
        { shop_id: 'good', similarity: 0.9 },
      ]),
      [{ shopId: 'good', similarity: 0.9 }]
    );
  });

  it('returns nothing for a non-array, so a failed call degrades quietly', () => {
    assert.deepEqual(parseSemanticMatches(null), []);
    assert.deepEqual(parseSemanticMatches(undefined), []);
    assert.deepEqual(parseSemanticMatches({ error: 'boom' }), []);
  });
});

describe('RPC arguments', () => {
  it('widens audiences exactly as the factual arm does', () => {
    // Kept identical to data/search/intent-filters.ts by these two tests.
    assert.deepEqual(expandAudiences(['men']).sort(), ['all', 'men', 'unisex']);
    assert.deepEqual(expandAudiences([]), []);
  });

  it('sends null rather than an empty array for an absent constraint', () => {
    assert.equal(nullIfEmpty([]), null);
    assert.equal(nullIfEmpty(['', '   ']), null);
    assert.deepEqual(nullIfEmpty(['FR', 'FR', ' BE ']), ['FR', ' BE ']);
  });
});

describe('hasSoftSignals', () => {
  it('is false for an intent expressing nothing subjective', () => {
    assert.equal(hasSoftSignals(emptySearchIntent('sneakers', 'model')), false);
  });

  it('is true for each soft field independently', () => {
    const fields: Partial<SearchIntent['soft']>[] = [
      { styles: ['minimaliste'] },
      { productTypes: ['baskets'] },
      { values: ['écoresponsable'] },
      { brandPositioning: 'premium' },
      { popularity: 'prefer_established' },
    ];
    for (const soft of fields) {
      assert.equal(hasSoftSignals(intent('x', { soft })), true, JSON.stringify(soft));
    }
  });
});
