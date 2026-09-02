import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DeterministicSearchIntentProvider } from './deterministic-intent.ts';
import type { IntentVocabulary } from './deterministic-intent.ts';
import { resolveCategoryIds, toSearchRow } from './persistence.ts';
import { SearchIntelligenceService } from './services.ts';
import { MAX_SEARCH_QUERY_LENGTH, validateSearchIntentRequest } from './validation.ts';

/**
 * The search spine, end to end, minus HTTP.
 *
 * The Edge Function is transport only, so everything below the request
 * boundary — validation, parsing, and the row that reaches `searches` — is
 * exercised here under Node. What is NOT covered is the Deno layer itself:
 * that needs a deploy.
 *
 * The vocabulary mirrors what the function builds from the `categories` table,
 * using the slugs and names seeded by the Prompt 9 reference-data migration.
 */
const SEEDED_CATEGORIES = [
  { id: '11111111-1111-4111-8111-111111111111', slug: 'mode', name: 'Mode' },
  { id: '22222222-2222-4222-8222-222222222222', slug: 'sneakers', name: 'Sneakers' },
  { id: '33333333-3333-4333-8333-333333333333', slug: 'bijoux', name: 'Bijoux' },
  { id: '44444444-4444-4444-8444-444444444444', slug: 'beaute', name: 'Beauté' },
  { id: '55555555-5555-4555-8555-555555555555', slug: 'maison', name: 'Maison' },
  { id: '66666666-6666-4666-8666-666666666666', slug: 'tech', name: 'Tech' },
  { id: '77777777-7777-4777-8777-777777777777', slug: 'sport', name: 'Sport' },
];

const VOCABULARY: IntentVocabulary = {
  categories: SEEDED_CATEGORIES.map((c) => ({ slug: c.slug, terms: [c.slug, c.name] })),
  countries: [
    { code: 'FR', terms: ['france', 'francaise', 'francais', 'francaises'] },
    { code: 'BE', terms: ['belgique', 'belge', 'belges'] },
  ],
};

const service = new SearchIntelligenceService(new DeterministicSearchIntentProvider(VOCABULARY));

describe('validateSearchIntentRequest', () => {
  it('accepts a minimal valid request', () => {
    const result = validateSearchIntentRequest({ query: 'sneakers' });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.query, 'sneakers');
    }
  });

  it('trims the query', () => {
    const result = validateSearchIntentRequest({ query: '   bijoux   ' });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.query, 'bijoux');
    }
  });

  it('rejects an empty or whitespace-only query', () => {
    assert.equal(validateSearchIntentRequest({ query: '' }).ok, false);
    assert.equal(validateSearchIntentRequest({ query: '    ' }).ok, false);
  });

  it('rejects a non-string query', () => {
    for (const query of [42, null, undefined, {}, ['sneakers'], true]) {
      assert.equal(validateSearchIntentRequest({ query }).ok, false);
    }
  });

  it('rejects a query over the database limit', () => {
    const oversized = 'a'.repeat(MAX_SEARCH_QUERY_LENGTH + 1);
    assert.equal(validateSearchIntentRequest({ query: oversized }).ok, false);
    assert.equal(validateSearchIntentRequest({ query: 'a'.repeat(MAX_SEARCH_QUERY_LENGTH) }).ok, true);
  });

  it('rejects a non-object body', () => {
    for (const body of [null, 'sneakers', 42, []]) {
      assert.equal(validateSearchIntentRequest(body).ok, false);
    }
  });

  it('rejects malformed optional fields rather than ignoring them', () => {
    assert.equal(validateSearchIntentRequest({ query: 'x', locale: 'french' }).ok, false);
    assert.equal(validateSearchIntentRequest({ query: 'x', shippingCountryCode: 'FRA' }).ok, false);
  });

  it('normalises a valid shipping country', () => {
    const result = validateSearchIntentRequest({ query: 'x', shippingCountryCode: 'be' });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.shippingCountryCode, 'BE');
    }
  });

  it('ignores a user id smuggled in the body', () => {
    const result = validateSearchIntentRequest({ query: 'x', user_id: 'someone-else' });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal('user_id' in result.value, false);
    }
  });
});

describe('search spine, end to end', () => {
  it('"sneakers françaises" -> category and country', async () => {
    const { intent } = await service.parse({ query: 'sneakers françaises' });
    assert.deepEqual(intent.hard.categorySlugs, ['sneakers']);
    assert.deepEqual(intent.hard.countryCodes, ['FR']);
    assert.equal(intent.source, 'deterministic');
  });

  it('"mode homme" -> category, and no audience it cannot justify', async () => {
    const { intent } = await service.parse({ query: 'mode homme' });
    assert.deepEqual(intent.hard.categorySlugs, ['mode']);
    assert.deepEqual(intent.hard.audiences, []);
  });

  it('"bijoux" -> category', async () => {
    const { intent } = await service.parse({ query: 'bijoux' });
    assert.deepEqual(intent.hard.categorySlugs, ['bijoux']);
  });

  it('"tech" -> category', async () => {
    const { intent } = await service.parse({ query: 'tech' });
    assert.deepEqual(intent.hard.categorySlugs, ['tech']);
  });

  it('matches a category by its display name as well as its slug', async () => {
    const { intent } = await service.parse({ query: 'beauté' });
    assert.deepEqual(intent.hard.categorySlugs, ['beaute']);
  });

  /**
   * The important one. A nuanced query must not be over-interpreted: "assez
   * chic", "pas trop habillé" and "autour de 100 €" are judgements, and
   * turning any of them into a hard filter would hide shops over an opinion.
   * They belong in semanticQuery for a model tier to weigh later.
   */
  it('leaves a nuanced query almost entirely to the semantic layer', async () => {
    const query = 'je veux des vêtements assez chics mais pas trop habillés autour de 100 €';
    const { intent } = await service.parse({ query });

    assert.equal(intent.hard.priceMin, null, 'must not invent a price floor');
    assert.equal(intent.hard.priceMax, null, 'must not invent a price ceiling');
    assert.deepEqual(intent.hard.categorySlugs, [], 'must not guess a category');
    assert.equal(intent.hard.verifiedOnly, false);
    assert.equal(intent.soft.brandPositioning, null, 'must not grade "chic" itself');

    assert.equal(intent.semanticQuery, query, 'the nuance is preserved for the semantic layer');
    assert.ok(intent.confidence <= 0.2, 'and it reports low confidence');
  });

  it('still reads an unambiguous budget as a hard filter', async () => {
    const { intent } = await service.parse({ query: 'bijoux moins de 150 euros' });
    assert.equal(intent.hard.priceMax, 150);
    assert.equal(intent.hard.currency, 'EUR');
  });
});

describe('searches row', () => {
  it('resolves slugs to real category ids', () => {
    const ids = resolveCategoryIds(['sneakers', 'bijoux'], SEEDED_CATEGORIES);
    assert.deepEqual(ids, [SEEDED_CATEGORIES[1]!.id, SEEDED_CATEGORIES[2]!.id]);
  });

  it('drops an unknown slug instead of inventing a uuid', () => {
    assert.deepEqual(resolveCategoryIds(['not-a-category'], SEEDED_CATEGORIES), []);
    assert.deepEqual(resolveCategoryIds(['mode', 'ghost'], SEEDED_CATEGORIES), [
      SEEDED_CATEGORIES[0]!.id,
    ]);
  });

  it('never repeats an id', () => {
    assert.equal(resolveCategoryIds(['mode', 'mode'], SEEDED_CATEGORIES).length, 1);
  });

  it('builds a row the deployed table will accept', async () => {
    const { intent } = await service.parse({ query: 'sneakers françaises moins de 150 euros' });
    const row = toSearchRow(intent, {
      userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      categoryIds: resolveCategoryIds(intent.hard.categorySlugs, SEEDED_CATEGORIES),
      resultsCount: null,
    });

    assert.ok(row.query_text.length <= 500, 'query_text fits the CHECK constraint');
    assert.equal(row.search_mode, 'classic', 'deterministic maps to the classic mode');
    assert.deepEqual(row.country_codes, ['FR']);
    assert.equal(row.price_max, 150);
    assert.deepEqual(row.category_ids, [SEEDED_CATEGORIES[1]!.id]);
    assert.equal(row.user_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  it('sends null rather than an empty array when nothing was resolved', async () => {
    const { intent } = await service.parse({ query: 'quelque chose' });
    const row = toSearchRow(intent, { userId: 'u', categoryIds: [], resultsCount: null });
    assert.equal(row.category_ids, null);
    assert.equal(row.country_codes, null);
  });
});
