import type { SearchIntent } from '../../ai/contracts/search-intent';
import type { Shop } from '../../types/shop';

/**
 * Deterministic ranking of shops that already passed the hard filters.
 *
 * No ML, no embeddings, no reranker. This orders results; it never decides
 * which results exist. That separation is the point: eligibility is a factual
 * question answered by the database, and a shop that violated a hard filter
 * cannot be rescued by a high score because it never reaches this function.
 *
 * The weights are deliberately blunt and readable. A tuned formula would imply
 * a precision we cannot claim before semantic retrieval exists, and every
 * number here is a guess we can measure later against `search_interactions`.
 */

export type RankedShop = {
  shop: Shop;
  score: number;
  /** Development and test only. Never rendered. */
  reasons: string[];
};

/** Weights, gathered so the formula can be read at a glance. */
export const RANKING_WEIGHTS = {
  categoryMatch: 40,
  primaryCategoryBonus: 10,
  countryMatch: 25,
  audienceExact: 12,
  audienceCompatible: 4,
  verified: 15,
  /** Maximum contribution of the text overlap heuristic. */
  textOverlap: 30,
  /** Small tiebreaker so equally-scored results are not arbitrary. */
  freshness: 5,
} as const;

const FRESHNESS_WINDOW_DAYS = 60;

export function rankShops(
  shops: readonly Shop[],
  intent: SearchIntent,
  now: Date = new Date()
): RankedShop[] {
  const queryTokens = tokenize(
    [intent.semanticQuery, intent.originalQuery].filter(Boolean).join(' ')
  );

  const ranked = shops.map((shop) => score(shop, intent, queryTokens, now));

  // Sort is total and stable: score, then recency, then id. Without the id the
  // order of equally-scored shops would depend on the database's row order.
  return ranked.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    const aTime = a.shop.publishedAt ? Date.parse(a.shop.publishedAt) : 0;
    const bTime = b.shop.publishedAt ? Date.parse(b.shop.publishedAt) : 0;
    if (bTime !== aTime) {
      return bTime - aTime;
    }
    return a.shop.id.localeCompare(b.shop.id);
  });
}

function score(
  shop: Shop,
  intent: SearchIntent,
  queryTokens: readonly string[],
  now: Date
): RankedShop {
  let total = 0;
  const reasons: string[] = [];

  const wanted = new Set(intent.hard.categorySlugs);
  if (wanted.size > 0) {
    const matched = shop.categories.filter((category) => wanted.has(category.slug));
    if (matched.length > 0) {
      total += RANKING_WEIGHTS.categoryMatch;
      reasons.push(`category:${matched.map((c) => c.slug).join('+')}`);
      if (matched.some((category) => category.isPrimary)) {
        total += RANKING_WEIGHTS.primaryCategoryBonus;
        reasons.push('category:primary');
      }
    }
  }

  if (
    intent.hard.countryCodes.length > 0 &&
    shop.countryCode !== null &&
    intent.hard.countryCodes.includes(shop.countryCode)
  ) {
    total += RANKING_WEIGHTS.countryMatch;
    reasons.push(`country:${shop.countryCode}`);
  }

  // Audience is a filter that admits unisex and all; here exactness is
  // rewarded, so a menswear shop outranks a unisex one for a menswear query
  // without the unisex shop ever being excluded.
  if (intent.hard.audiences.length > 0) {
    const audience = shop.audience;
    if (audience !== null && intent.hard.audiences.includes(audience)) {
      total += RANKING_WEIGHTS.audienceExact;
      reasons.push(`audience:${audience}`);
    } else if (audience === 'unisex' || audience === 'all' || audience === null) {
      total += RANKING_WEIGHTS.audienceCompatible;
      reasons.push('audience:compatible');
    }
  }

  if (shop.verified) {
    total += RANKING_WEIGHTS.verified;
    reasons.push('verified');
  }

  const overlap = textOverlap(queryTokens, shop);
  if (overlap > 0) {
    const points = Math.round(RANKING_WEIGHTS.textOverlap * overlap);
    total += points;
    reasons.push(`text:${points}`);
  }

  const freshness = freshnessBonus(shop, now);
  if (freshness > 0) {
    total += freshness;
    reasons.push(`fresh:${freshness}`);
  }

  return { shop, score: total, reasons };
}

/**
 * A modest token-overlap heuristic over public factual text.
 *
 * This is NOT semantic search and must not be described as such: it cannot
 * relate "quiet luxury" to "minimaliste", or "sneakers" to "baskets". It is a
 * bridge that makes obvious word matches count until embeddings arrive in the
 * next phase.
 */
export function textOverlap(queryTokens: readonly string[], shop: Shop): number {
  if (queryTokens.length === 0) {
    return 0;
  }

  const haystack = new Set(
    tokenize(
      [
        shop.name,
        shop.shortDescription ?? '',
        shop.city ?? '',
        ...shop.categories.map((category) => category.name),
        ...shop.tags,
      ].join(' ')
    )
  );

  if (haystack.size === 0) {
    return 0;
  }

  const matched = queryTokens.filter((token) => haystack.has(token)).length;
  return matched / queryTokens.length;
}

function freshnessBonus(shop: Shop, now: Date): number {
  if (!shop.publishedAt) {
    return 0;
  }
  const publishedAt = Date.parse(shop.publishedAt);
  if (!Number.isFinite(publishedAt)) {
    return 0;
  }
  const ageDays = (now.getTime() - publishedAt) / 86_400_000;
  if (ageDays < 0 || ageDays > FRESHNESS_WINDOW_DAYS) {
    return 0;
  }
  return Math.round(RANKING_WEIGHTS.freshness * (1 - ageDays / FRESHNESS_WINDOW_DAYS));
}

/**
 * Words that carry no discriminating signal in either language, plus the
 * scaffolding of a search phrase ("je cherche une marque…"). Without this,
 * every shop would match "marque" and the overlap score would be noise.
 */
const STOPWORDS = new Set([
  'une', 'des', 'les', 'pour', 'avec', 'dans', 'sur', 'par', 'que', 'qui', 'quoi',
  'cherche', 'veux', 'voudrais', 'quelque', 'chose', 'truc', 'style', 'genre',
  'marque', 'marques', 'boutique', 'boutiques', 'site', 'sites', 'plus', 'moins',
  'trop', 'pas', 'tres', 'assez', 'mais', 'aussi', 'euros', 'euro', 'autour',
  'entre', 'the', 'and', 'for', 'with', 'from', 'that', 'this', 'want', 'looking',
  'some', 'shop', 'shops', 'brand', 'brands', 'like', 'something', 'good', 'nice',
]);

/** Lowercase, strip accents, split on non-letters, drop noise. */
export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}
