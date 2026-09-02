import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { HelpSource } from '../contracts/help.ts';
import type { ModelMetadata } from '../contracts/model.ts';
import {
  validateEmbeddingResult,
  validateHelpAnswer,
  validateRerankResult,
  validateSearchIntent,
  validateShopAnalysis,
} from './validation.ts';

const MODEL: ModelMetadata = {
  provider: 'test',
  model: 'test-model',
  modelVersion: null,
  contractVersion: 'test/1',
};

function validIntent(): Record<string, unknown> {
  return {
    originalQuery: 'petite marque francaise minimaliste',
    language: 'fr',
    semanticQuery: 'petite marque minimaliste',
    hard: {
      categorySlugs: ['mode'],
      audiences: ['men'],
      countryCodes: ['FR'],
      shippingCountryCodes: ['FR'],
      priceMin: null,
      priceMax: 150,
      currency: 'EUR',
      verifiedOnly: false,
    },
    soft: {
      styles: ['minimaliste'],
      productTypes: [],
      values: [],
      brandPositioning: 'premium',
      popularity: 'prefer_lesser_known',
    },
    confidence: 0.8,
    source: 'model',
  };
}

function validAnalysis(): Record<string, unknown> {
  return {
    summary: 'Vestiaire urbain produit en petites series.',
    suggestedCategories: [{ slug: 'mode', confidence: 0.9 }],
    suggestedTags: [{ slug: 'minimaliste', confidence: 0.7 }],
    detectedStyles: ['minimaliste'],
    detectedAudience: ['men'],
    detectedProducts: ['t-shirts'],
    detectedValues: ['made in france'],
    pricePositioning: 'premium',
    keywords: ['streetwear'],
    visualIdentity: null,
    confidence: 0.75,
    fieldConfidence: { summary: 0.9 },
  };
}

describe('validateSearchIntent', () => {
  it('accepts a well-formed intent', () => {
    const result = validateSearchIntent(validIntent());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.hard.priceMax, 150);
      assert.equal(result.value.soft.popularity, 'prefer_lesser_known');
    }
  });

  it('rejects a non-object', () => {
    for (const input of [null, undefined, 'text', 42, []]) {
      assert.equal(validateSearchIntent(input).ok, false);
    }
  });

  it('rejects a confidence outside [0, 1]', () => {
    for (const confidence of [-0.1, 1.5, 7, Number.NaN]) {
      const result = validateSearchIntent({ ...validIntent(), confidence });
      assert.equal(result.ok, false, `confidence ${confidence} should be rejected`);
    }
  });

  it('rejects an inverted price range', () => {
    const intent = validIntent();
    intent.hard = { ...(intent.hard as object), priceMin: 200, priceMax: 100 };
    const result = validateSearchIntent(intent);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.issues.some((issue) => issue.includes('priceMax must be >= priceMin')));
    }
  });

  it('rejects a negative price', () => {
    const intent = validIntent();
    intent.hard = { ...(intent.hard as object), priceMax: -10 };
    assert.equal(validateSearchIntent(intent).ok, false);
  });

  it('rejects a price given as a string', () => {
    const intent = validIntent();
    intent.hard = { ...(intent.hard as object), priceMax: 'cheap' };
    assert.equal(validateSearchIntent(intent).ok, false);
  });

  it('rejects an unknown audience', () => {
    const intent = validIntent();
    intent.hard = { ...(intent.hard as object), audiences: ['teenagers'] };
    assert.equal(validateSearchIntent(intent).ok, false);
  });

  it('rejects a malformed country code', () => {
    const intent = validIntent();
    intent.hard = { ...(intent.hard as object), countryCodes: ['France'] };
    assert.equal(validateSearchIntent(intent).ok, false);
  });

  it('uppercases country codes so they satisfy the database domain', () => {
    const intent = validIntent();
    intent.hard = { ...(intent.hard as object), countryCodes: ['fr', 'be'] };
    const result = validateSearchIntent(intent);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.value.hard.countryCodes, ['FR', 'BE']);
    }
  });

  it('reports every problem at once rather than stopping at the first', () => {
    const result = validateSearchIntent({ ...validIntent(), confidence: 5, source: 'guessing' });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.issues.length >= 2);
    }
  });
});

describe('validateShopAnalysis', () => {
  it('accepts a well-formed analysis', () => {
    const result = validateShopAnalysis(validAnalysis());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.suggestedCategories[0]?.slug, 'mode');
    }
  });

  it('rejects a non-object', () => {
    assert.equal(validateShopAnalysis('not an analysis').ok, false);
  });

  it('rejects an out-of-range confidence', () => {
    assert.equal(validateShopAnalysis({ ...validAnalysis(), confidence: 1.2 }).ok, false);
  });

  it('rejects an unknown price positioning', () => {
    assert.equal(
      validateShopAnalysis({ ...validAnalysis(), pricePositioning: 'cheap-ish' }).ok,
      false
    );
  });

  it('rejects a suggested category that is not a slug', () => {
    const analysis = validAnalysis();
    analysis.suggestedCategories = [{ slug: 'Mode Homme', confidence: 0.5 }];
    assert.equal(validateShopAnalysis(analysis).ok, false);
  });

  it('rejects a suggestion whose confidence is out of range', () => {
    const analysis = validAnalysis();
    analysis.suggestedCategories = [{ slug: 'mode', confidence: 12 }];
    assert.equal(validateShopAnalysis(analysis).ok, false);
  });

  it('rejects a confidence reported for an unknown field', () => {
    const analysis = validAnalysis();
    analysis.fieldConfidence = { revenue: 0.5 };
    assert.equal(validateShopAnalysis(analysis).ok, false);
  });

  it('treats a missing array as empty rather than failing', () => {
    const analysis = validAnalysis();
    delete analysis.keywords;
    const result = validateShopAnalysis(analysis);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.value.keywords, []);
    }
  });
});

describe('validateEmbeddingResult', () => {
  it('accepts a vector of any dimension', () => {
    for (const size of [3, 768, 1536, 3072]) {
      const vector = new Array(size).fill(0.1);
      const result = validateEmbeddingResult({ vector, dimensions: size, sourceHash: null }, MODEL);
      assert.equal(result.ok, true, `dimension ${size} should be accepted`);
      if (result.ok) {
        assert.equal(result.value.dimensions, size);
      }
    }
  });

  it('rejects a declared dimension that disagrees with the vector', () => {
    const result = validateEmbeddingResult(
      { vector: [0.1, 0.2, 0.3], dimensions: 1536, sourceHash: null },
      MODEL
    );
    assert.equal(result.ok, false);
  });

  it('rejects an empty vector', () => {
    assert.equal(validateEmbeddingResult({ vector: [], dimensions: 0 }, MODEL).ok, false);
  });

  it('rejects non-finite components', () => {
    const result = validateEmbeddingResult(
      { vector: [0.1, Number.NaN, 0.3], dimensions: 3 },
      MODEL
    );
    assert.equal(result.ok, false);
  });
});

describe('validateRerankResult', () => {
  const candidates = ['shop-a', 'shop-b'];

  it('accepts results limited to the submitted candidates', () => {
    const result = validateRerankResult(
      { results: [{ shopId: 'shop-b', score: 0.9, previousRank: 1 }] },
      candidates,
      MODEL
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.results[0]?.rank, 0);
      assert.equal(result.value.results[0]?.previousRank, 1);
    }
  });

  it('rejects a shop the reranker invented', () => {
    const result = validateRerankResult(
      { results: [{ shopId: 'shop-z', score: 0.9, previousRank: 0 }] },
      candidates,
      MODEL
    );
    assert.equal(result.ok, false);
  });

  it('rejects a duplicated shop', () => {
    const result = validateRerankResult(
      {
        results: [
          { shopId: 'shop-a', score: 0.9, previousRank: 0 },
          { shopId: 'shop-a', score: 0.8, previousRank: 1 },
        ],
      },
      candidates,
      MODEL
    );
    assert.equal(result.ok, false);
  });
});

describe('validateHelpAnswer', () => {
  const sources: HelpSource[] = [
    {
      articleId: 'article-1',
      articleSlug: 'verification',
      title: 'Verification',
      chunkIndex: 0,
      score: 0.9,
      excerpt: 'La verification confirme des informations cles.',
    },
  ];

  it('accepts an answer grounded in a retrieved source', () => {
    const result = validateHelpAnswer(
      {
        answered: true,
        answer: 'La verification confirme des informations cles.',
        confidence: 0.8,
        refusalReason: null,
        sourceArticleIds: ['article-1'],
      },
      sources,
      MODEL
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.sources.length, 1);
    }
  });

  it('rejects an answer with no source, which is how policies get invented', () => {
    const result = validateHelpAnswer(
      {
        answered: true,
        answer: 'Shop Discovery rembourse sous 30 jours.',
        confidence: 0.9,
        refusalReason: null,
        sourceArticleIds: [],
      },
      sources,
      MODEL
    );
    assert.equal(result.ok, false);
  });

  it('rejects a citation of a source that was not retrieved', () => {
    const result = validateHelpAnswer(
      {
        answered: true,
        answer: 'Quelque chose.',
        confidence: 0.5,
        refusalReason: null,
        sourceArticleIds: ['article-99'],
      },
      sources,
      MODEL
    );
    assert.equal(result.ok, false);
  });

  it('accepts a refusal that states a reason', () => {
    const result = validateHelpAnswer(
      {
        answered: false,
        answer: '',
        confidence: 0,
        refusalReason: 'no_supporting_source',
        sourceArticleIds: [],
      },
      sources,
      MODEL
    );
    assert.equal(result.ok, true);
  });

  it('rejects a refusal that still carries an answer', () => {
    const result = validateHelpAnswer(
      {
        answered: false,
        answer: 'En fait, voici la reponse.',
        confidence: 0,
        refusalReason: 'out_of_scope',
        sourceArticleIds: [],
      },
      sources,
      MODEL
    );
    assert.equal(result.ok, false);
  });
});
