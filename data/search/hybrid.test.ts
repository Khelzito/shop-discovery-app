import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { emptySearchIntent } from '../../ai/contracts/search-intent';
import type { SearchIntent } from '../../ai/contracts/search-intent';
import type { Shop, ShopAudience } from '../../types/shop';
import { planShopFilters } from './intent-filters';
import { mergeCandidates, satisfiesPlan, similarityIndex } from './merge';
import { RANKING_WEIGHTS, SEMANTIC_SIMILARITY_FLOOR, rankShops, semanticBonus } from './rank';

/**
 * Hybrid retrieval: the merge gate and the semantic ranking term.
 *
 * These cover the parts that decide whether semantic search can widen the
 * result set without corrupting it. The vector itself is never computed here:
 * similarities are supplied as data, so the suite runs offline and costs
 * nothing, exactly like the rest of the search tests.
 *
 * The scenario that matters most is `a high similarity cannot defeat a country
 * constraint` — it is the property that separates "AI understands" from "AI
 * decides what you are allowed to see".
 */

type Fixture = {
  slug: string;
  country: string | null;
  audience: ShopAudience | null;
  categories: [string, boolean][];
  verified: boolean;
  daysAgo: number;
};

const NOW = new Date('2026-09-03T12:00:00.000Z');

const CATALOGUE: Fixture[] = [
  { slug: 'maison-leon', country: 'FR', audience: 'unisex', categories: [['mode', true]], verified: true, daysAgo: 2 },
  { slug: 'cadence', country: 'FR', audience: 'unisex', categories: [['sport', true], ['mode', false]], verified: false, daysAgo: 24 },
  { slug: 'studio-arho', country: 'DE', audience: 'all', categories: [['tech', true]], verified: false, daysAgo: 18 },
  { slug: 'district', country: 'BE', audience: 'unisex', categories: [['mode', true]], verified: false, daysAgo: 15 },
  { slug: 'sans-pays', country: null, audience: null, categories: [['mode', true]], verified: false, daysAgo: 30 },
];

function shop(fixture: Fixture): Shop {
  const categories = fixture.categories.map(([slug, isPrimary]) => ({
    slug,
    name: slug,
    isPrimary,
  }));
  return {
    id: `id-${fixture.slug}`,
    slug: fixture.slug,
    name: fixture.slug,
    shortDescription: null,
    websiteUrl: `https://${fixture.slug}.example`,
    countryCode: fixture.country,
    city: null,
    priceLevel: 2,
    audience: fixture.audience,
    categories,
    primaryCategory: categories.find((c) => c.isPrimary) ?? categories[0] ?? null,
    tags: [],
    images: { cover: null, gallery: [] },
    verified: fixture.verified,
    domainVerified: fixture.verified,
    publishedAt: new Date(NOW.getTime() - fixture.daysAgo * 86_400_000).toISOString(),
  };
}

const SHOPS = new Map(CATALOGUE.map((fixture) => [fixture.slug, shop(fixture)]));

function get(slug: string): Shop {
  const found = SHOPS.get(slug);
  assert.ok(found, `fixture ${slug} is missing`);
  return found;
}

function intentOf(query: string, hard: Partial<SearchIntent['hard']> = {}): SearchIntent {
  const base = emptySearchIntent(query, 'model');
  return { ...base, hard: { ...base.hard, ...hard } };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe('satisfiesPlan', () => {
  it('rejects a shop from the wrong country', () => {
    const plan = planShopFilters(intentOf('marque française', { countryCodes: ['FR'] }));
    assert.equal(satisfiesPlan(get('maison-leon'), plan), true);
    assert.equal(satisfiesPlan(get('studio-arho'), plan), false);
  });

  it('rejects a shop with no declared country when a country is required', () => {
    // Mirrors SQL: `country_code in ('FR')` never matches null.
    const plan = planShopFilters(intentOf('marque française', { countryCodes: ['FR'] }));
    assert.equal(satisfiesPlan(get('sans-pays'), plan), false);
  });

  it('keeps a shop with no declared audience', () => {
    // Mirrors SQL: `audience.in.(…), audience.is.null`.
    const plan = planShopFilters(intentOf('mode homme', { audiences: ['men'] }));
    assert.equal(satisfiesPlan(get('sans-pays'), plan), true);
  });

  it('requires an overlapping category, not every category', () => {
    const plan = planShopFilters(intentOf('sport', { categorySlugs: ['sport'] }));
    assert.equal(satisfiesPlan(get('cadence'), plan), true);
    assert.equal(satisfiesPlan(get('maison-leon'), plan), false);
  });

  it('enforces verifiedOnly', () => {
    const plan = planShopFilters(intentOf('boutiques vérifiées', { verifiedOnly: true }));
    assert.equal(satisfiesPlan(get('maison-leon'), plan), true);
    assert.equal(satisfiesPlan(get('district'), plan), false);
  });

  it('asks nothing of anyone when the plan is empty', () => {
    const plan = planShopFilters(emptySearchIntent('cadeau original', 'model'));
    for (const candidate of SHOPS.values()) {
      assert.equal(satisfiesPlan(candidate, plan), true);
    }
  });
});

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

describe('mergeCandidates', () => {
  const emptyPlan = planShopFilters(emptySearchIntent('quelque chose', 'model'));

  it('returns a shop found by both arms exactly once, carrying both origins', () => {
    const both = get('maison-leon');
    const merged = mergeCandidates({
      factual: [both],
      semantic: [both],
      similarities: [{ shopId: both.id, similarity: 0.71 }],
      plan: emptyPlan,
    });

    assert.equal(merged.candidates.length, 1);
    assert.deepEqual(merged.candidates[0]?.origins, ['factual', 'semantic']);
    assert.equal(merged.candidates[0]?.similarity, 0.71);
  });

  it('adds a semantically-found shop the factual arm missed', () => {
    const merged = mergeCandidates({
      factual: [get('maison-leon')],
      semantic: [get('cadence')],
      similarities: [{ shopId: get('cadence').id, similarity: 0.62 }],
      plan: emptyPlan,
    });

    assert.deepEqual(
      merged.candidates.map((candidate) => candidate.shop.slug),
      ['maison-leon', 'cadence']
    );
    assert.deepEqual(merged.candidates[1]?.origins, ['semantic']);
  });

  it('a high similarity cannot defeat a country constraint', () => {
    // The property this whole module exists for: the semantic arm proposes a
    // near-perfect German match for a query that explicitly asked for France.
    const plan = planShopFilters(intentOf('marque française', { countryCodes: ['FR'] }));
    const merged = mergeCandidates({
      factual: [get('maison-leon')],
      semantic: [get('studio-arho')],
      similarities: [{ shopId: get('studio-arho').id, similarity: 0.99 }],
      plan,
    });

    assert.deepEqual(
      merged.candidates.map((candidate) => candidate.shop.slug),
      ['maison-leon']
    );
    assert.deepEqual(merged.rejected, [get('studio-arho').id]);
  });

  it('never gates a shop the factual arm already returned', () => {
    // Belt and braces: the factual arm is authoritative, so even a candidate
    // the client-side gate cannot fully verify stays in.
    const plan = planShopFilters(intentOf('marque française', { countryCodes: ['FR'] }));
    const merged = mergeCandidates({
      factual: [get('studio-arho')],
      semantic: [],
      similarities: [],
      plan,
    });

    assert.equal(merged.candidates.length, 1);
    assert.deepEqual(merged.rejected, []);
  });

  it('orders semantic-only candidates by similarity, then id', () => {
    const merged = mergeCandidates({
      factual: [],
      semantic: [get('district'), get('cadence'), get('maison-leon')],
      similarities: [
        { shopId: get('district').id, similarity: 0.4 },
        { shopId: get('cadence').id, similarity: 0.9 },
        { shopId: get('maison-leon').id, similarity: 0.65 },
      ],
      plan: emptyPlan,
    });

    assert.deepEqual(
      merged.candidates.map((candidate) => candidate.shop.slug),
      ['cadence', 'maison-leon', 'district']
    );
  });

  it('keeps the highest similarity when the server lists a shop twice', () => {
    const merged = mergeCandidates({
      factual: [],
      semantic: [get('cadence')],
      similarities: [
        { shopId: get('cadence').id, similarity: 0.3 },
        { shopId: get('cadence').id, similarity: 0.8 },
      ],
      plan: emptyPlan,
    });

    assert.equal(merged.candidates[0]?.similarity, 0.8);
  });

  it('degrades to the factual result when the semantic arm returns nothing', () => {
    // Provider down, no vector stored, or pgvector matched nothing.
    const merged = mergeCandidates({
      factual: [get('maison-leon'), get('cadence')],
      semantic: [],
      similarities: [],
      plan: emptyPlan,
    });

    assert.deepEqual(
      merged.candidates.map((candidate) => candidate.shop.slug),
      ['maison-leon', 'cadence']
    );
    assert.deepEqual(
      merged.candidates.map((candidate) => candidate.similarity),
      [null, null]
    );
  });

  it('leaves a shop with no embedding unscored rather than excluded', () => {
    const merged = mergeCandidates({
      factual: [get('maison-leon'), get('cadence')],
      semantic: [],
      similarities: [{ shopId: get('maison-leon').id, similarity: 0.7 }],
      plan: emptyPlan,
    });

    const index = similarityIndex(merged.candidates);
    assert.equal(index.get(get('maison-leon').id), 0.7);
    assert.equal(index.has(get('cadence').id), false);
    assert.equal(merged.candidates.length, 2);
  });
});

// ---------------------------------------------------------------------------
// The ranking term
// ---------------------------------------------------------------------------

describe('semantic ranking', () => {
  it('changes nothing when no similarity map is supplied', () => {
    const intent = intentOf('mode', { categorySlugs: ['mode'] });
    const shops = [get('maison-leon'), get('cadence'), get('district')];

    const before = rankShops(shops, intent, NOW);
    const after = rankShops(shops, intent, NOW, new Map());

    assert.deepEqual(
      before.map((r) => [r.shop.slug, r.score]),
      after.map((r) => [r.shop.slug, r.score])
    );
    assert.equal(
      before.every((r) => !r.reasons.some((reason) => reason.startsWith('semantic:'))),
      true
    );
  });

  it('awards nothing at or below the floor', () => {
    assert.equal(semanticBonus(get('cadence'), new Map([[get('cadence').id, 0]])), 0);
    assert.equal(
      semanticBonus(get('cadence'), new Map([[get('cadence').id, SEMANTIC_SIMILARITY_FLOOR]])),
      0
    );
  });

  it('awards the full weight at a perfect match', () => {
    assert.equal(
      semanticBonus(get('cadence'), new Map([[get('cadence').id, 1]])),
      RANKING_WEIGHTS.semanticSimilarity
    );
  });

  it('is monotonic between the floor and one', () => {
    const id = get('cadence').id;
    const points = [0.2, 0.4, 0.6, 0.8, 1].map((similarity) =>
      semanticBonus(get('cadence'), new Map([[id, similarity]]))
    );
    for (let i = 1; i < points.length; i += 1) {
      assert.ok(points[i]! > points[i - 1]!, `expected ${points[i]} > ${points[i - 1]}`);
    }
  });

  it('cannot outrank an exact category match', () => {
    // A shop that IS in the category must beat one that is merely about it.
    const intent = intentOf('sport', { categorySlugs: ['sport'] });
    const ranked = rankShops(
      [get('cadence'), get('maison-leon')],
      intent,
      NOW,
      new Map([[get('maison-leon').id, 1]])
    );

    assert.equal(ranked[0]?.shop.slug, 'cadence');
  });

  it('surfaces a shop that only the semantic arm liked', () => {
    // No factual signal at all: an empty intent, so ranking has nothing but
    // similarity and freshness to work with.
    const intent = emptySearchIntent('une marque minimaliste pour homme', 'model');
    const ranked = rankShops(
      [get('district'), get('cadence')],
      intent,
      NOW,
      new Map([[get('cadence').id, 0.82]])
    );

    assert.equal(ranked[0]?.shop.slug, 'cadence');
    assert.ok(ranked[0]?.reasons.some((reason) => reason.startsWith('semantic:')));
  });

  it('ignores a similarity that is not a finite number', () => {
    const id = get('cadence').id;
    assert.equal(semanticBonus(get('cadence'), new Map([[id, Number.NaN]])), 0);
    assert.equal(semanticBonus(get('cadence'), new Map([[id, Number.POSITIVE_INFINITY]])), 0);
  });
});
