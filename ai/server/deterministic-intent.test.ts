import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DeterministicSearchIntentProvider } from './deterministic-intent.ts';
import type { IntentVocabulary } from './deterministic-intent.ts';
import { validateSearchIntent } from './validation.ts';

const VOCABULARY: IntentVocabulary = {
  categories: [
    { slug: 'mode', terms: ['mode', 'vetements'] },
    { slug: 'sneakers', terms: ['sneakers', 'baskets'] },
    { slug: 'bijoux', terms: ['bijoux'] },
  ],
  countries: [
    { code: 'FR', terms: ['france', 'francaise', 'francais'] },
    { code: 'BE', terms: ['belgique', 'belge'] },
  ],
};

const provider = new DeterministicSearchIntentProvider(VOCABULARY);

async function parse(query: string, extra: { shippingCountryCode?: string } = {}) {
  const result = await provider.parseSearchIntent({ query, ...extra });
  return result.data;
}

describe('DeterministicSearchIntentProvider', () => {
  it('always produces output that passes contract validation', async () => {
    for (const query of [
      'sneakers',
      'petite marque francaise minimaliste moins de 100 euros',
      '',
      'a'.repeat(400),
    ]) {
      const intent = await parse(query);
      assert.equal(
        validateSearchIntent(intent).ok,
        true,
        `intent for "${query.slice(0, 20)}" should validate`
      );
    }
  });

  it('recognises a category', async () => {
    const intent = await parse('je cherche des baskets');
    assert.deepEqual(intent.hard.categorySlugs, ['sneakers']);
  });

  it('recognises a country', async () => {
    const intent = await parse('une marque francaise');
    assert.deepEqual(intent.hard.countryCodes, ['FR']);
  });

  it('reads a price ceiling', async () => {
    const intent = await parse('des bijoux moins de 150 euros');
    assert.equal(intent.hard.priceMax, 150);
    assert.equal(intent.hard.priceMin, null);
    assert.equal(intent.hard.currency, 'EUR');
  });

  it('reads a price floor', async () => {
    const intent = await parse('des bijoux a partir de 80 euros');
    assert.equal(intent.hard.priceMin, 80);
    assert.equal(intent.hard.priceMax, null);
  });

  it('reads a price range', async () => {
    const intent = await parse('entre 50 et 120 euros');
    assert.equal(intent.hard.priceMin, 50);
    assert.equal(intent.hard.priceMax, 120);
  });

  it('leaves an ambiguous budget alone rather than inventing a filter', async () => {
    const intent = await parse('autour de 100 euros');
    assert.equal(intent.hard.priceMin, null);
    assert.equal(intent.hard.priceMax, null);
  });

  it('treats lesser-known as a soft preference, never a filter', async () => {
    const intent = await parse('une marque peu connue');
    assert.equal(intent.soft.popularity, 'prefer_lesser_known');
    assert.equal(intent.hard.categorySlugs.length, 0);
  });

  it('takes the shipping country from the request, not from the text', async () => {
    const intent = await parse('sneakers', { shippingCountryCode: 'be' });
    assert.deepEqual(intent.hard.shippingCountryCodes, ['BE']);
  });

  it('keeps the full query as the semantic text', async () => {
    const query = 'petite marque francaise minimaliste moins de 100 euros';
    const intent = await parse(query);
    assert.equal(intent.semanticQuery, query);
    assert.equal(intent.originalQuery, query);
  });

  it('does not match a term inside a longer word', async () => {
    const intent = await parse('modelisme et modenature');
    assert.deepEqual(intent.hard.categorySlugs, []);
  });

  it('reports low confidence when nothing is recognised', async () => {
    const intent = await parse('quelque chose de sympa');
    assert.ok(intent.confidence <= 0.2);
    assert.equal(intent.source, 'deterministic');
  });

  it('reports the provider in its telemetry without any query text', async () => {
    const result = await provider.parseSearchIntent({ query: 'sneakers' });
    assert.equal(result.telemetry.provider, 'deterministic');
    assert.equal(result.telemetry.operation, 'search_intent');
    assert.equal(result.telemetry.outcome, 'success');
    assert.equal(JSON.stringify(result.telemetry).includes('sneakers'), false);
  });
});
