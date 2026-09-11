import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { emptySearchIntent } from '../../ai/contracts/search-intent';
import type { SearchIntent } from '../../ai/contracts/search-intent';
import type { Shop, ShopAudience } from '../../types/shop';
import { expandAudiences, planShopFilters } from './intent-filters';
import { rankShops, textOverlap, tokenize } from './rank';

/**
 * The demo catalogue, mirroring the rows actually seeded in Supabase.
 *
 * Copied deliberately rather than fetched: these tests must run offline, in
 * CI, and without a paid API call. The values were read from the live database
 * so an expectation here means the same thing on the device.
 */
type Fixture = {
  slug: string;
  country: string;
  audience: ShopAudience;
  categories: [string, boolean][];
  verified: boolean;
  tags?: string[];
  description?: string;
  daysAgo: number;
};

const CATALOGUE: Fixture[] = [
  { slug: 'maison-leon', country: 'FR', audience: 'unisex', categories: [['mode', true]], verified: true, tags: ['Streetwear', 'Made in France'], description: 'Vestiaire urbain coupé et assemblé à Roubaix.', daysAgo: 2 },
  { slug: 'lune-studio', country: 'FR', audience: 'women', categories: [['bijoux', true]], verified: true, tags: ['Minimaliste', 'Fait main'], description: 'Bijoux fins en or recyclé, atelier lyonnais.', daysAgo: 4 },
  { slug: 'sneaklab', country: 'FR', audience: 'unisex', categories: [['sneakers', true], ['mode', false]], verified: true, tags: ['Fait main', 'Premium'], description: 'Souliers et sneakers en cuir tanné végétal.', daysAgo: 6 },
  { slug: 'atelier-noma', country: 'FR', audience: 'all', categories: [['maison', true]], verified: true, tags: ['Minimaliste', 'Vintage'], description: 'Mobilier clair et objets de table.', daysAgo: 9 },
  { slug: 'celeste', country: 'FR', audience: 'women', categories: [['beaute', true]], verified: true, tags: ['Écoresponsable'], description: 'Soins et maquillage à formules courtes.', daysAgo: 12 },
  { slug: 'district', country: 'BE', audience: 'unisex', categories: [['mode', true]], verified: false, tags: ['Casual'], description: 'Sélection de marques européennes indépendantes.', daysAgo: 15 },
  { slug: 'studio-arho', country: 'DE', audience: 'all', categories: [['tech', true]], verified: false, tags: ['Premium'], description: 'Casques et enceintes conçus à Berlin.', daysAgo: 18 },
  { slug: 'nord-et-fils', country: 'FR', audience: 'unisex', categories: [['mode', true]], verified: false, tags: ['Casual'], description: 'Sacs de ville et petite bagagerie.', daysAgo: 21 },
  { slug: 'cadence', country: 'FR', audience: 'unisex', categories: [['sport', true], ['mode', false]], verified: false, tags: ['Minimaliste'], description: 'Vêtements de sport sobres.', daysAgo: 24 },
  { slug: 'verte-rue', country: 'FR', audience: 'unisex', categories: [['mode', true]], verified: false, tags: ['Écoresponsable', 'Made in France'], description: 'Basiques teints naturellement.', daysAgo: 27 },
];

const NOW = new Date('2026-09-03T12:00:00.000Z');

const CATEGORY_NAMES: Record<string, string> = {
  mode: 'Mode',
  sneakers: 'Sneakers',
  bijoux: 'Bijoux',
  beaute: 'Beauté',
  maison: 'Maison',
  tech: 'Tech',
  sport: 'Sport',
};

function shop(fixture: Fixture): Shop {
  const publishedAt = new Date(NOW.getTime() - fixture.daysAgo * 86_400_000).toISOString();
  const categories = fixture.categories.map(([slug, isPrimary]) => ({
    slug,
    name: CATEGORY_NAMES[slug] ?? slug,
    isPrimary,
  }));
  return {
    id: `id-${fixture.slug}`,
    slug: fixture.slug,
    name: fixture.slug,
    shortDescription: fixture.description ?? null,
    websiteUrl: `https://${fixture.slug}.example`,
    countryCode: fixture.country,
    city: null,
    priceLevel: 2,
    audience: fixture.audience,
    categories,
    primaryCategory: categories.find((c) => c.isPrimary) ?? categories[0] ?? null,
    tags: fixture.tags ?? [],
    images: { cover: null, gallery: [] },
    verified: fixture.verified,
    domainVerified: fixture.verified,
    publishedAt,
  };
}

const SHOPS = CATALOGUE.map(shop);

/**
 * Applies the plan the way the database would, so a test proves the whole
 * eligibility rule rather than only the ranking half.
 */
function eligible(intent: SearchIntent): Shop[] {
  const plan = planShopFilters(intent);
  return SHOPS.filter((candidate) => {
    if (plan.categorySlugs.length > 0) {
      if (!candidate.categories.some((c) => plan.categorySlugs.includes(c.slug))) {
        return false;
      }
    }
    if (plan.countryCodes.length > 0) {
      if (candidate.countryCode === null || !plan.countryCodes.includes(candidate.countryCode)) {
        return false;
      }
    }
    if (plan.audiences.length > 0) {
      if (candidate.audience !== null && !plan.audiences.includes(candidate.audience)) {
        return false;
      }
    }
    if (plan.verifiedOnly && !candidate.verified) {
      return false;
    }
    return true;
  });
}

function search(intent: SearchIntent): string[] {
  return rankShops(eligible(intent), intent, NOW).map((result) => result.shop.slug);
}

function intentOf(
  query: string,
  hard: Partial<SearchIntent['hard']> = {},
  soft: Partial<SearchIntent['soft']> = {}
): SearchIntent {
  const intent = emptySearchIntent(query, 'model');
  Object.assign(intent.hard, hard);
  Object.assign(intent.soft, soft);
  intent.semanticQuery = query;
  intent.confidence = 0.8;
  return intent;
}

// ---------------------------------------------------------------------------
// The queries that define this phase
// ---------------------------------------------------------------------------

describe('the demo queries retrieve the right shop', () => {
  const cases: [string, Partial<SearchIntent['hard']>, string][] = [
    ['sneakers françaises', { categorySlugs: ['sneakers'], countryCodes: ['FR'] }, 'sneaklab'],
    ['bijoux français', { categorySlugs: ['bijoux'], countryCodes: ['FR'] }, 'lune-studio'],
    ['tech allemande', { categorySlugs: ['tech'], countryCodes: ['DE'] }, 'studio-arho'],
    ['mode belge', { categorySlugs: ['mode'], countryCodes: ['BE'] }, 'district'],
    ['sport français', { categorySlugs: ['sport'], countryCodes: ['FR'] }, 'cadence'],
    ['maison française', { categorySlugs: ['maison'], countryCodes: ['FR'] }, 'atelier-noma'],
  ];

  for (const [query, hard, expected] of cases) {
    it(`"${query}" ranks ${expected} first`, () => {
      const results = search(intentOf(query, hard));
      assert.ok(results.length > 0, 'must return at least one shop');
      assert.equal(results[0], expected);
    });
  }

  it('"sneakers françaises" returns SneakLab and nothing else', () => {
    const results = search(intentOf('sneakers françaises', {
      categorySlugs: ['sneakers'],
      countryCodes: ['FR'],
    }));
    assert.deepEqual(results, ['sneaklab']);
  });
});

// ---------------------------------------------------------------------------
// Hard filters are eligibility, never a score
// ---------------------------------------------------------------------------

describe('hard filters exclude rather than demote', () => {
  it('a country mismatch removes the shop entirely', () => {
    const results = search(intentOf('mode belge', { categorySlugs: ['mode'], countryCodes: ['BE'] }));
    assert.deepEqual(results, ['district']);
    assert.equal(results.includes('maison-leon'), false, 'a French shop must not appear');
  });

  it('an unknown category yields nothing rather than a loose match', () => {
    assert.deepEqual(search(intentOf('quiet luxury', { categorySlugs: ['quiet-luxury'] })), []);
  });

  it('an impossible combination yields nothing rather than a fabricated match', () => {
    assert.deepEqual(
      search(intentOf('tech française', { categorySlugs: ['tech'], countryCodes: ['FR'] })),
      []
    );
  });

  it('verifiedOnly keeps only shops with an approved verification', () => {
    const results = search(intentOf('mode vérifiée', {
      categorySlugs: ['mode'],
      verifiedOnly: true,
    }));
    assert.deepEqual(results, ['maison-leon', 'sneaklab']);
    assert.equal(results.includes('district'), false);
  });

  it('no hard filter returns the whole published catalogue', () => {
    assert.equal(search(intentOf('quelque chose de sympa')).length, SHOPS.length);
  });

  it('a shop failing a filter can never outrank a compliant one', () => {
    // district is unverified; even with a perfect text match it stays out.
    const results = search(
      intentOf('district mode belge vérifiée', { categorySlugs: ['mode'], verifiedOnly: true })
    );
    assert.equal(results.includes('district'), false);
  });
});

// ---------------------------------------------------------------------------
// Audience
// ---------------------------------------------------------------------------

describe('audience', () => {
  it('widens to unisex and all rather than excluding them', () => {
    assert.deepEqual(expandAudiences(['men']).sort(), ['all', 'men', 'unisex']);
    assert.deepEqual(expandAudiences([]), []);
  });

  it('a menswear query keeps unisex shops and drops womenswear ones', () => {
    const results = search(intentOf('mode homme', {
      categorySlugs: ['mode'],
      audiences: ['men'],
    }));
    assert.ok(results.includes('maison-leon'), 'unisex must survive');
    assert.equal(results.includes('celeste'), false, 'womenswear must not appear');
  });

  it('a womenswear query keeps womenswear and unisex', () => {
    const results = search(intentOf('bijoux femme', {
      categorySlugs: ['bijoux'],
      audiences: ['women'],
    }));
    assert.deepEqual(results, ['lune-studio']);
  });

  it('an exact audience outranks a merely compatible one', () => {
    const womenIntent = intentOf('beauté femme', { audiences: ['women'] });
    const ranked = rankShops(eligible(womenIntent), womenIntent, NOW);
    const celeste = ranked.find((r) => r.shop.slug === 'celeste');
    const unisex = ranked.find((r) => r.shop.slug === 'nord-et-fils');
    assert.ok(celeste && unisex);
    assert.ok(celeste.reasons.includes('audience:women'));
    assert.ok(unisex.reasons.includes('audience:compatible'));
  });
});

// ---------------------------------------------------------------------------
// Price: the trap this phase must not fall into
// ---------------------------------------------------------------------------

describe('price', () => {
  it('never converts a euro amount into a price_level', () => {
    const plan = planShopFilters(intentOf('moins de 150 euros', { priceMax: 150, currency: 'EUR' }));
    assert.equal(plan.priceMax, 150);
    // A price_level field would mean euros had been mapped onto a 1-4 band.
    assert.equal('priceLevel' in plan, false);
  });

  it('a budget query still returns shops, because no shop declares a range', () => {
    const results = search(intentOf('bijoux moins de 150 euros', {
      categorySlugs: ['bijoux'],
      priceMax: 150,
    }));
    assert.deepEqual(results, ['lune-studio'], 'an unpriced shop must not be excluded');
  });
});

// ---------------------------------------------------------------------------
// Deferred constraints are recorded, not silently dropped
// ---------------------------------------------------------------------------

describe('deferred constraints', () => {
  it('records shipping as deferred, since no shop declares destinations', () => {
    const plan = planShopFilters(intentOf('livré en Belgique', { shippingCountryCodes: ['BE'] }));
    assert.ok(plan.deferred.includes('shipping_country'));
  });

  it('records a popularity preference as deferred, having no exposure data', () => {
    const plan = planShopFilters(intentOf('peu connue', {}, { popularity: 'prefer_lesser_known' }));
    assert.ok(plan.deferred.includes('popularity'));
  });

  it('records independence as deferred rather than forcing a hard filter', () => {
    const plan = planShopFilters(intentOf('petite marque', {}, { values: ['independant'] }));
    assert.ok(plan.deferred.includes('independent'));
  });

  it('defers nothing for a plain query', () => {
    assert.deepEqual(planShopFilters(intentOf('bijoux', { categorySlugs: ['bijoux'] })).deferred, []);
  });

  it('normalises and deduplicates what it does apply', () => {
    const plan = planShopFilters(
      intentOf('x', { countryCodes: ['fr', 'FR', 'be'], categorySlugs: ['mode', 'mode'] })
    );
    assert.deepEqual(plan.countryCodes, ['FR', 'BE']);
    assert.deepEqual(plan.categorySlugs, ['mode']);
  });
});

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

describe('ranking', () => {
  it('is deterministic for identical input', () => {
    const intent = intentOf('mode française', { categorySlugs: ['mode'], countryCodes: ['FR'] });
    assert.deepEqual(search(intent), search(intent));
  });

  it('puts a primary category above a secondary one', () => {
    const intent = intentOf('mode', { categorySlugs: ['mode'] });
    const ranked = rankShops(eligible(intent), intent, NOW);
    const primary = ranked.findIndex((r) => r.shop.slug === 'maison-leon');
    const secondary = ranked.findIndex((r) => r.shop.slug === 'sneaklab');
    assert.ok(primary >= 0 && secondary >= 0);
    assert.ok(primary < secondary, 'a primary-category shop should rank above a secondary one');
  });

  it('explains why a shop ranked, for development only', () => {
    const intent = intentOf('sneakers françaises', {
      categorySlugs: ['sneakers'],
      countryCodes: ['FR'],
    });
    const [top] = rankShops(eligible(intent), intent, NOW);
    assert.ok(top);
    assert.ok(top.reasons.some((r) => r.startsWith('category:')));
    assert.ok(top.reasons.includes('country:FR'));
    assert.ok(top.reasons.includes('verified'));
    assert.ok(top.score > 0);
  });

  it('handles an empty candidate set', () => {
    assert.deepEqual(rankShops([], intentOf('anything'), NOW), []);
  });
});

// ---------------------------------------------------------------------------
// Text heuristic — a bridge, explicitly not semantic search
// ---------------------------------------------------------------------------

describe('text overlap heuristic', () => {
  it('drops stopwords and short tokens', () => {
    assert.deepEqual(tokenize('je cherche une marque de bijoux'), ['bijoux']);
    assert.deepEqual(tokenize('a de la'), []);
  });

  it('is accent and case insensitive', () => {
    assert.deepEqual(tokenize('BIJOUX Écoresponsable'), ['bijoux', 'ecoresponsable']);
  });

  it('matches a word that really appears in a shop', () => {
    const lune = SHOPS.find((s) => s.slug === 'lune-studio')!;
    assert.ok(textOverlap(tokenize('bijoux minimaliste'), lune) > 0);
  });

  it('cannot relate a synonym, which is exactly the current limitation', () => {
    const sneaklab = SHOPS.find((s) => s.slug === 'sneaklab')!;
    // "baskets" means sneakers, and this heuristic has no way to know that.
    assert.equal(textOverlap(tokenize('baskets'), sneaklab), 0);
  });

  it('scores nothing for an empty query', () => {
    assert.equal(textOverlap([], SHOPS[0]!), 0);
  });
});

// ---------------------------------------------------------------------------
// Degraded intents still drive retrieval
// ---------------------------------------------------------------------------

describe('degraded intent', () => {
  it('a deterministic intent still retrieves and ranks', () => {
    const intent = emptySearchIntent('sneakers françaises', 'deterministic');
    intent.hard.categorySlugs = ['sneakers'];
    intent.hard.countryCodes = ['FR'];
    assert.deepEqual(search(intent), ['sneaklab']);
  });

  it('an empty intent returns the catalogue rather than nothing', () => {
    const intent = emptySearchIntent('???', 'deterministic');
    assert.equal(search(intent).length, SHOPS.length);
  });
});
