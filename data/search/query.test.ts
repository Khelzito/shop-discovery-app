import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { emptySearchIntent } from '../../ai/contracts/search-intent';
import type { SearchIntent } from '../../ai/contracts/search-intent';
import { toShops } from '../shops/mapper';
import type { ShopRow } from '../shops/mapper';
import { planShopFilters } from './intent-filters';
import { buildShopSearchQuery, type ShopSearchQuery } from './query';
import { rankShops } from './rank';

/**
 * The integration these tests exist for.
 *
 * `search.test.ts` decides eligibility in JavaScript: it asserts what the
 * database OUGHT to return for a plan. That is a useful test of the plan and
 * of ranking, and it passed all along while production was broken, because it
 * never looks at the query actually sent.
 *
 * The bug lived entirely in the gap it leaves. A category filter on a nested
 * relation was expressed as `shop_categories!inner(is_primary, categories(...))`
 * — inner on the junction table only. PostgREST prunes the deepest relation a
 * filter names, so non-matching links came back as `{ categories: null }`, the
 * junction row still existed, the inner join was satisfied, and every French
 * shop was returned for "sneakers françaises".
 *
 * So these tests run the real pipeline —
 *
 *   intent -> planShopFilters -> buildShopSearchQuery -> PostgREST -> mapper
 *   -> rankShops -> the slugs Explore renders
 *
 * — against a stand-in that reproduces PostgREST embedding semantics rather
 * than assuming them. The semantics encoded below were read off the live
 * database against the real seeded catalogue, including the exact
 * `{ is_primary: true, categories: null }` rows the broken query returned.
 */

// ---------------------------------------------------------------------------
// Fixtures, in PostgREST row shape rather than mapped Shop shape
// ---------------------------------------------------------------------------

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

type Fixture = {
  slug: string;
  country: string;
  audience: string;
  /** [slug, isPrimary], exactly as seeded. */
  categories: [string, boolean][];
  verified: boolean;
  daysAgo: number;
};

/** Read from the live database, so an expectation here holds on the device. */
const CATALOGUE: Fixture[] = [
  { slug: 'maison-leon', country: 'FR', audience: 'unisex', categories: [['mode', true]], verified: true, daysAgo: 2 },
  { slug: 'lune-studio', country: 'FR', audience: 'women', categories: [['bijoux', true]], verified: true, daysAgo: 4 },
  { slug: 'sneaklab', country: 'FR', audience: 'unisex', categories: [['mode', false], ['sneakers', true]], verified: true, daysAgo: 6 },
  { slug: 'atelier-noma', country: 'FR', audience: 'all', categories: [['maison', true]], verified: true, daysAgo: 9 },
  { slug: 'celeste', country: 'FR', audience: 'women', categories: [['beaute', true]], verified: true, daysAgo: 12 },
  { slug: 'district', country: 'BE', audience: 'unisex', categories: [['mode', true]], verified: false, daysAgo: 15 },
  { slug: 'studio-arho', country: 'DE', audience: 'all', categories: [['tech', true]], verified: false, daysAgo: 18 },
  { slug: 'nord-et-fils', country: 'FR', audience: 'unisex', categories: [['mode', true]], verified: false, daysAgo: 21 },
  { slug: 'cadence', country: 'FR', audience: 'unisex', categories: [['mode', false], ['sport', true]], verified: false, daysAgo: 24 },
  { slug: 'verte-rue', country: 'FR', audience: 'unisex', categories: [['mode', true]], verified: false, daysAgo: 27 },
];

function row(fixture: Fixture): ShopRow {
  return {
    id: `id-${fixture.slug}`,
    slug: fixture.slug,
    name: fixture.slug,
    short_description: null,
    website_url: `https://${fixture.slug}.example`,
    country_code: fixture.country,
    city: null,
    price_level: 2,
    audience: fixture.audience,
    published_at: new Date(NOW.getTime() - fixture.daysAgo * 86_400_000).toISOString(),
    shop_images: [],
    shop_categories: fixture.categories.map(([slug, isPrimary]) => ({
      is_primary: isPrimary,
      categories: { slug, name: CATEGORY_NAMES[slug] ?? slug },
    })),
    shop_tags: [],
    shop_verifications: fixture.verified
      ? [{ verification_type: 'domain', verified_at: '2026-08-01T00:00:00.000Z' }]
      : [],
  };
}

const ROWS = CATALOGUE.map(row);
const FRENCH = CATALOGUE.filter((f) => f.country === 'FR').map((f) => f.slug);

// ---------------------------------------------------------------------------
// A stand-in for PostgREST, faithful to the semantics that broke
// ---------------------------------------------------------------------------

/**
 * Runs a described query the way PostgREST does.
 *
 * Only the constructs `buildShopSearchQuery` can emit are modelled, on
 * purpose: a fake that understands more than the code under test produces is
 * a fake that can disagree with production for reasons no test explains.
 *
 * The rule that matters: a filter naming an embedded path prunes the DEEPEST
 * relation in that path. Whether the parent row survives is decided solely by
 * `!inner` markers, checked back up the chain.
 */
function runQuery(rows: readonly ShopRow[], query: ShopSearchQuery): ShopRow[] {
  const linkInner = query.select.includes('shop_categories!inner(');
  const categoryInner = /categories!inner\(slug/.test(query.select);
  const verificationInner = query.select.includes('shop_verifications!inner(');

  const result: ShopRow[] = [];

  for (const source of rows) {
    const shop: ShopRow = { ...source, shop_categories: [...(source.shop_categories ?? [])] };
    let keep = true;

    for (const filter of query.filters) {
      if (!keep) {
        break;
      }

      if (filter.kind === 'in' && filter.column === 'shop_categories.categories.slug') {
        // The filter reaches `categories`, so that is what gets nulled out.
        let links = (shop.shop_categories ?? []).map((link) => ({
          ...link,
          categories:
            link.categories !== null && filter.values.includes(link.categories.slug)
              ? link.categories
              : null,
        }));
        // `categories!inner` drops the emptied links...
        if (categoryInner) {
          links = links.filter((link) => link.categories !== null);
        }
        shop.shop_categories = links;
        // ...and only then can `shop_categories!inner` drop the shop.
        if (linkInner && links.length === 0) {
          keep = false;
        }
        continue;
      }

      if (filter.kind === 'eq') {
        keep = String(column(shop, filter.column) ?? '') === filter.value;
      } else if (filter.kind === 'in') {
        keep = filter.values.includes(String(column(shop, filter.column) ?? ''));
      } else {
        keep = filter.filter.split(',').some((clause) => matchesOr(shop, clause));
      }
    }

    if (keep && verificationInner && (shop.shop_verifications ?? []).length === 0) {
      keep = false;
    }
    if (keep) {
      result.push(shop);
    }
  }

  // `.order('published_at', desc).order('id', asc)`
  return result.sort(
    (a, b) =>
      String(b.published_at).localeCompare(String(a.published_at)) || a.id.localeCompare(b.id)
  );
}

/** `status` is not selected by the client model, so it is answered here. */
function column(shop: ShopRow, name: string): unknown {
  if (name === 'status') {
    return 'published';
  }
  return (shop as unknown as Record<string, unknown>)[name];
}

/** Supports exactly the `or` clauses buildShopSearchQuery emits. */
function matchesOr(shop: ShopRow, clause: string): boolean {
  const inMatch = /^(\w+)\.in\.\((.*)\)$/.exec(clause);
  if (inMatch) {
    return inMatch[2]!.split(',').includes(String(column(shop, inMatch[1]!) ?? ''));
  }
  const isNull = /^(\w+)\.is\.null$/.exec(clause);
  if (isNull) {
    return column(shop, isNull[1]!) === null;
  }
  const compare = /^(\w+)\.(gte|lte)\.(-?\d+(?:\.\d+)?)$/.exec(clause);
  if (compare) {
    const value = column(shop, compare[1]!);
    if (typeof value !== 'number') {
      return false;
    }
    const bound = Number(compare[3]);
    return compare[2] === 'gte' ? value >= bound : value <= bound;
  }
  throw new Error(`unmodelled or-clause: ${clause}`);
}

// ---------------------------------------------------------------------------
// The pipeline under test
// ---------------------------------------------------------------------------

function intentOf(query: string, hard: Partial<SearchIntent['hard']> = {}): SearchIntent {
  const intent = emptySearchIntent(query, 'model');
  Object.assign(intent.hard, hard);
  return intent;
}

/** Everything Explore does between an intent and the slugs it renders. */
function rendered(intent: SearchIntent, override?: (query: ShopSearchQuery) => ShopSearchQuery) {
  const plan = planShopFilters(intent);
  const query = override ? override(buildShopSearchQuery(plan)) : buildShopSearchQuery(plan);
  const shops = toShops(runQuery(ROWS, query));
  return rankShops(shops, intent, NOW).map((result) => result.shop.slug);
}

/** The select exactly as it was before the fix, to prove these tests catch it. */
function withoutNestedInner(query: ShopSearchQuery): ShopSearchQuery {
  return {
    ...query,
    select: query.select.replace('categories!inner(slug, name)', 'categories(slug, name)'),
  };
}

describe('the live bug: sneakers françaises', () => {
  const intent = intentOf('sneakers françaises', {
    categorySlugs: ['sneakers'],
    countryCodes: ['FR'],
  });

  it('renders only sneaklab', () => {
    assert.deepEqual(rendered(intent), ['sneaklab']);
  });

  it('cannot render a French shop that is not in the sneakers category', () => {
    const shown = rendered(intent);
    const wrong = shown.filter((slug) => slug !== 'sneaklab' && FRENCH.includes(slug));
    assert.deepEqual(wrong, [], 'a French shop outside the requested category reached the screen');
  });

  it('asks for an inner join at BOTH hops', () => {
    const { select } = buildShopSearchQuery(planShopFilters(intent));
    assert.ok(select.includes('shop_categories!inner('), 'junction table must join inner');
    assert.ok(select.includes('categories!inner(slug, name)'), 'nested categories must join inner');
  });

  it('reproduces the production failure when the nested inner is removed', () => {
    // Documents the defect and proves this harness would have caught it: the
    // only difference is the marker the fix adds.
    const shown = rendered(intent, withoutNestedInner);
    assert.deepEqual(
      shown.sort(),
      [...FRENCH].sort(),
      'without categories!inner every French shop comes back, which is what shipped'
    );
  });
});

describe('every category behaves the same way', () => {
  const cases: [string, string, string[]][] = [
    ['sneakers', 'FR', ['sneaklab']],
    ['bijoux', 'FR', ['lune-studio']],
    ['maison', 'FR', ['atelier-noma']],
    ['beaute', 'FR', ['celeste']],
    ['sport', 'FR', ['cadence']],
    ['tech', 'DE', ['studio-arho']],
    ['mode', 'BE', ['district']],
  ];

  for (const [category, country, expected] of cases) {
    it(`${category} + ${country} -> ${expected.join(', ')}`, () => {
      const shown = rendered(intentOf(`${category} ${country}`, {
        categorySlugs: [category],
        countryCodes: [country],
      }));
      assert.deepEqual(shown.sort(), [...expected].sort());
    });
  }

  it('keeps a shop matched on a non-primary category', () => {
    // sneaklab and cadence carry `mode` as a secondary category; an inner join
    // on the junction must not quietly become "primary category only".
    const shown = rendered(intentOf('mode française', {
      categorySlugs: ['mode'],
      countryCodes: ['FR'],
    }));
    assert.deepEqual(
      shown.sort(),
      ['cadence', 'maison-leon', 'nord-et-fils', 'sneaklab', 'verte-rue']
    );
  });

  it('returns nothing rather than everything when nothing matches', () => {
    assert.deepEqual(
      rendered(intentOf('tech française', { categorySlugs: ['tech'], countryCodes: ['FR'] })),
      []
    );
  });
});

describe('the other filters still express what the plan decided', () => {
  it('a category filter survives alongside verifiedOnly', () => {
    const shown = rendered(intentOf('sneakers vérifiées', {
      categorySlugs: ['sneakers'],
      verifiedOnly: true,
    }));
    assert.deepEqual(shown, ['sneaklab']);
  });

  it('verifiedOnly alone excludes unverified shops', () => {
    const shown = rendered(intentOf('boutiques vérifiées', { verifiedOnly: true }));
    assert.deepEqual(shown.sort(), ['atelier-noma', 'celeste', 'lune-studio', 'maison-leon', 'sneaklab']);
  });

  it('an audience filter keeps shops that declared none', () => {
    const query = buildShopSearchQuery(planShopFilters(intentOf('mode femme', { audiences: ['women'] })));
    const orFilter = query.filters.find((filter) => filter.kind === 'or');
    assert.ok(orFilter && orFilter.kind === 'or' && orFilter.filter.includes('audience.is.null'));
  });

  it('never asks for an inner join it does not need', () => {
    const { select } = buildShopSearchQuery(planShopFilters(intentOf('quelque chose')));
    assert.ok(!select.includes('!inner'), 'an unfiltered browse must not join inner');
  });

  it('always constrains status to published', () => {
    const { filters } = buildShopSearchQuery(planShopFilters(intentOf('quelque chose')));
    assert.deepEqual(filters[0], { kind: 'eq', column: 'status', value: 'published' });
  });
});
