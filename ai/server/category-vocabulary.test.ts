import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildCategoryResolver } from './category-vocabulary.ts';
import { DeterministicSearchIntentProvider } from './deterministic-intent.ts';
import { OpenAiSearchIntentProvider } from './openai-search-intent.ts';
import type { FetchLike } from './openai-search-intent.ts';
import { validateSearchIntent } from './validation.ts';

/**
 * The real taxonomy, read from the deployed database. Slug and display name
 * both matter here: the bug this file guards against was a model answering
 * with the label while the code only accepted the slug.
 */
const TAXONOMY = [
  { slug: 'mode', name: 'Mode' },
  { slug: 'sneakers', name: 'Sneakers' },
  { slug: 'bijoux', name: 'Bijoux' },
  { slug: 'beaute', name: 'Beauté' },
  { slug: 'maison', name: 'Maison' },
  { slug: 'tech', name: 'Tech' },
  { slug: 'sport', name: 'Sport' },
];

const SLUGS = TAXONOMY.map((c) => c.slug);
const resolver = buildCategoryResolver(TAXONOMY);

describe('category resolver', () => {
  it('passes an exact slug through untouched', () => {
    assert.deepEqual(resolver.resolve(['sneakers', 'bijoux']), ['sneakers', 'bijoux']);
  });

  it('resolves the display label, which is what broke live search', () => {
    assert.deepEqual(resolver.resolve(['Sneakers']), ['sneakers']);
    assert.deepEqual(resolver.resolve(['Bijoux']), ['bijoux']);
    assert.deepEqual(resolver.resolve(['Beauté']), ['beaute']);
  });

  it('resolves accents and casing', () => {
    assert.deepEqual(resolver.resolve(['BEAUTÉ', 'beauté', 'Beaute']), ['beaute']);
  });

  it('resolves natural synonyms onto the real slug', () => {
    assert.deepEqual(resolver.resolve(['baskets']), ['sneakers']);
    assert.deepEqual(resolver.resolve(['chaussures']), ['sneakers']);
    assert.deepEqual(resolver.resolve(['vetements']), ['mode']);
    assert.deepEqual(resolver.resolve(['deco']), ['maison']);
    assert.deepEqual(resolver.resolve(['casque']), ['tech']);
    assert.deepEqual(resolver.resolve(['jewellery']), ['bijoux']);
  });

  it('never returns a category the catalogue does not have', () => {
    assert.deepEqual(resolver.resolve(['quiet-luxury', 'streetwear', 'vintage', '']), []);
  });

  it('only knows aliases for slugs present in the taxonomy', () => {
    // A catalogue without `sneakers` must not resolve "baskets" to anything.
    const partial = buildCategoryResolver([{ slug: 'mode', name: 'Mode' }]);
    assert.deepEqual(partial.resolve(['baskets']), []);
    assert.deepEqual(partial.resolve(['Mode']), ['mode']);
  });

  it('deduplicates', () => {
    assert.deepEqual(resolver.resolve(['sneakers', 'Sneakers', 'baskets']), ['sneakers']);
  });

  it('detects a product noun stated in the query', () => {
    assert.deepEqual(resolver.detect('sneakers françaises'), ['sneakers']);
    assert.deepEqual(resolver.detect('des bijoux fins'), ['bijoux']);
    assert.deepEqual(resolver.detect('tech allemande'), ['tech']);
    assert.deepEqual(resolver.detect('une marque belge de vêtements'), ['mode']);
  });

  it('does not detect a category inside a longer word', () => {
    assert.deepEqual(resolver.detect('modelisme et modenature'), []);
  });

  it('detects nothing in a purely subjective query', () => {
    assert.deepEqual(resolver.detect('quiet luxury chic et minimaliste'), []);
    assert.deepEqual(resolver.detect('quelque chose de sympa'), []);
  });

  it('is order-stable when several categories appear', () => {
    const first = resolver.detect('des bijoux et des sneakers');
    assert.deepEqual(first, resolver.detect('des sneakers et des bijoux'));
  });
});

// ---------------------------------------------------------------------------
// The regression itself, through the provider
// ---------------------------------------------------------------------------

function providerReturning(hard: Record<string, unknown>): OpenAiSearchIntentProvider {
  const body = JSON.stringify({
    status: 'completed',
    output_text: JSON.stringify({
      language: 'fr',
      semanticQuery: 'q',
      hard: {
        categorySlugs: [],
        audiences: [],
        countryCodes: [],
        shippingCountryCodes: [],
        priceMin: null,
        priceMax: null,
        currency: null,
        verifiedOnly: false,
        ...hard,
      },
      soft: {
        styles: [],
        productTypes: [],
        values: [],
        brandPositioning: null,
        popularity: 'any',
      },
      confidence: 0.9,
    }),
  });

  const fetchImpl: FetchLike = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: () => Promise.resolve(body),
    });

  return new OpenAiSearchIntentProvider({
    apiKey: 'test-key',
    model: 'test-model',
    allowedCategorySlugs: SLUGS,
    categoryTaxonomy: TAXONOMY,
    fetchImpl,
  });
}

describe('live regression: the category must survive to the intent', () => {
  it('a label instead of a slug is resolved, not discarded', async () => {
    const provider = providerReturning({ categorySlugs: ['Sneakers'], countryCodes: ['FR'] });
    const result = await provider.parseSearchIntent({ query: 'sneakers françaises' });

    assert.deepEqual(result.data.hard.categorySlugs, ['sneakers']);
    assert.deepEqual(result.data.hard.countryCodes, ['FR']);
  });

  it('a synonym is resolved onto the real slug', async () => {
    const provider = providerReturning({ categorySlugs: ['baskets'], countryCodes: ['FR'] });
    const result = await provider.parseSearchIntent({ query: 'baskets françaises' });
    assert.deepEqual(result.data.hard.categorySlugs, ['sneakers']);
  });

  it('an omitted category is rescued from the query itself', async () => {
    const provider = providerReturning({ categorySlugs: [], countryCodes: ['FR'] });
    const result = await provider.parseSearchIntent({ query: 'sneakers françaises' });

    assert.deepEqual(
      result.data.hard.categorySlugs,
      ['sneakers'],
      'a product noun the user stated must not be lost when the model omits it'
    );
  });

  it('the rescue cannot invent a category from subjective wording', async () => {
    const provider = providerReturning({ categorySlugs: [] });
    const result = await provider.parseSearchIntent({
      query: 'des marques avec un style quiet luxury',
    });
    assert.deepEqual(result.data.hard.categorySlugs, []);
  });

  it('a hallucinated slug is still refused', async () => {
    const provider = providerReturning({ categorySlugs: ['quiet-luxury', 'luxe'] });
    const result = await provider.parseSearchIntent({ query: 'quiet luxury' });
    assert.deepEqual(result.data.hard.categorySlugs, []);
  });

  it('every rescued intent still passes contract validation', async () => {
    const provider = providerReturning({ categorySlugs: ['Sneakers'], countryCodes: ['FR'] });
    const result = await provider.parseSearchIntent({ query: 'sneakers françaises' });
    assert.equal(validateSearchIntent(result.data).ok, true);
  });
});

// ---------------------------------------------------------------------------
// The six live queries, end to end through both tiers
// ---------------------------------------------------------------------------

const LIVE_QUERIES: { query: string; category: string; country: string }[] = [
  { query: 'sneakers françaises', category: 'sneakers', country: 'FR' },
  { query: 'bijoux français', category: 'bijoux', country: 'FR' },
  { query: 'tech allemande', category: 'tech', country: 'DE' },
  { query: 'mode belge', category: 'mode', country: 'BE' },
  { query: 'sport français', category: 'sport', country: 'FR' },
  { query: 'maison française', category: 'maison', country: 'FR' },
];

/** The vocabulary the Edge Function builds, using the shared resolver. */
const DETERMINISTIC = new DeterministicSearchIntentProvider({
  categories: TAXONOMY.map((category) => ({
    slug: category.slug,
    terms: resolver.termsFor(category.slug),
  })),
  countries: [
    { code: 'FR', terms: ['france', 'francaise', 'francais', 'francaises'] },
    { code: 'BE', terms: ['belgique', 'belge', 'belges'] },
    { code: 'DE', terms: ['allemagne', 'allemande', 'allemand'] },
  ],
});

describe('the six live queries keep category and country', () => {
  for (const { query, category, country } of LIVE_QUERIES) {
    it(`model tier: "${query}" -> ${category} + ${country}`, async () => {
      // The model answers with labels, the shape that broke production.
      const label = TAXONOMY.find((c) => c.slug === category)!.name;
      const provider = providerReturning({
        categorySlugs: [label],
        countryCodes: [country],
      });
      const result = await provider.parseSearchIntent({ query });

      assert.deepEqual(result.data.hard.categorySlugs, [category]);
      assert.deepEqual(result.data.hard.countryCodes, [country]);
    });

    it(`model tier, category omitted: "${query}" -> ${category} recovered`, async () => {
      const provider = providerReturning({ categorySlugs: [], countryCodes: [country] });
      const result = await provider.parseSearchIntent({ query });

      assert.ok(
        result.data.hard.categorySlugs.includes(category),
        `${query} must still resolve ${category}`
      );
      assert.deepEqual(result.data.hard.countryCodes, [country]);
    });

    it(`deterministic tier: "${query}" -> ${category} + ${country}`, async () => {
      const result = await DETERMINISTIC.parseSearchIntent({ query });
      assert.ok(
        result.data.hard.categorySlugs.includes(category),
        `${query} must resolve ${category} without a model`
      );
      assert.deepEqual(result.data.hard.countryCodes, [country]);
    });
  }

  it('the deterministic tier also understands synonyms now', async () => {
    const result = await DETERMINISTIC.parseSearchIntent({ query: 'baskets françaises' });
    assert.ok(result.data.hard.categorySlugs.includes('sneakers'));
    assert.deepEqual(result.data.hard.countryCodes, ['FR']);
  });
});
