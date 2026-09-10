import type { SemanticMatch } from '../../ai/contracts/endpoints';
import type { Shop } from '../../types/shop';
import { type ShopFilterPlan } from './intent-filters';

// Re-exported so a caller importing the merge does not also have to reach into
// the wire contract for the shape it consumes.
export type { SemanticMatch };

/**
 * Where the two retrieval arms meet.
 *
 * The factual arm answers "which shops are eligible"; the semantic arm answers
 * "which shops are about this". Merging them is the one place where a vector
 * could quietly widen eligibility, so the gate lives here and is the reason
 * this module exists as its own tested unit rather than a few lines inside
 * retrieval.
 *
 * THE RULE: similarity may add a candidate the factual query missed, never one
 * the factual constraints exclude. A shop reached through the semantic arm is
 * re-checked against the same plan before it is allowed through. A German
 * brand cannot enter a "marque française" search however close its vector is.
 *
 * That check is deliberately redundant with the SQL: the database applies the
 * same constraints inside the vector query, and this repeats them over the
 * rows that actually came back. A filter lost on either side is caught by the
 * other, and a wrong exclusion is invisible to the user — they simply never
 * see the shop — so one layer of verification is not enough.
 */

/** Which arm produced a candidate. A shop can come from both. */
export type CandidateOrigin = 'factual' | 'semantic';

export type MergedCandidate = {
  shop: Shop;
  /** Sorted, deduplicated. `['factual', 'semantic']` when both arms agreed. */
  origins: CandidateOrigin[];
  /** Null when the semantic arm never saw this shop. */
  similarity: number | null;
};

export type MergeOutcome = {
  candidates: MergedCandidate[];
  /**
   * Semantic ids dropped by the gate, for diagnosing a suspicious result set.
   * Never rendered; a user is not told which shops were rejected.
   */
  rejected: string[];
};

/**
 * Why the price bounds are absent from the gate below.
 *
 * `Shop` exposes `priceLevel`, a coarse band, and not the `price_min` /
 * `price_max` range the plan filters on. Re-checking a range the client model
 * does not carry would mean either inventing a conversion between the two —
 * there is no honest one — or rejecting every shop. The bounds are therefore
 * enforced in SQL only, on both arms, and this list records that it is a
 * deliberate gap rather than an oversight.
 */
export const CLIENT_UNCHECKABLE_CONSTRAINTS = ['priceMin', 'priceMax'] as const;

/**
 * True when a shop genuinely satisfies the plan's hard constraints.
 *
 * Mirrors `buildShopSearchQuery` clause for clause, including its tolerances:
 * a shop that declared no audience passes, because absence of data is not
 * evidence of mismatch, while a shop that declared no country FAILS a country
 * constraint, because `country_code in (…)` never matches null. Where the two
 * differ the query is authoritative and this must be corrected to match it.
 */
export function satisfiesPlan(shop: Shop, plan: ShopFilterPlan): boolean {
  if (plan.categorySlugs.length > 0) {
    const wanted = new Set(plan.categorySlugs);
    if (!shop.categories.some((category) => wanted.has(category.slug))) {
      return false;
    }
  }

  if (plan.countryCodes.length > 0) {
    if (shop.countryCode === null || !plan.countryCodes.includes(shop.countryCode)) {
      return false;
    }
  }

  // `audience.in.(…), audience.is.null` — undeclared is kept on purpose.
  if (plan.audiences.length > 0) {
    if (shop.audience !== null && !plan.audiences.includes(shop.audience)) {
      return false;
    }
  }

  if (plan.verifiedOnly && !shop.verified) {
    return false;
  }

  return true;
}

/**
 * Unions the two arms into one candidate list.
 *
 * Factual candidates are trusted as-is: they came back from a query that
 * already applied the plan. Semantic candidates are gated. A shop present in
 * both appears once, carrying both origins and its similarity.
 *
 * Order is deterministic — factual first in the order retrieval returned them,
 * then the surviving semantic-only shops by similarity — so a merge is
 * reproducible in a test. Ranking re-sorts everything afterwards; this order
 * exists to be stable, not to be meaningful.
 */
export function mergeCandidates(input: {
  factual: readonly Shop[];
  /** Shops fetched for the semantic ids, under the client's own RLS. */
  semantic: readonly Shop[];
  similarities: readonly SemanticMatch[];
  plan: ShopFilterPlan;
}): MergeOutcome {
  const similarityById = new Map<string, number>();
  for (const match of input.similarities) {
    // Highest wins if a shop somehow appears twice, so the merge cannot depend
    // on the order the server listed its matches in.
    const previous = similarityById.get(match.shopId);
    if (previous === undefined || match.similarity > previous) {
      similarityById.set(match.shopId, match.similarity);
    }
  }

  const byId = new Map<string, MergedCandidate>();
  const order: string[] = [];

  for (const shop of input.factual) {
    if (byId.has(shop.id)) {
      continue;
    }
    byId.set(shop.id, {
      shop,
      origins: ['factual'],
      similarity: similarityById.get(shop.id) ?? null,
    });
    order.push(shop.id);
  }

  const rejected: string[] = [];
  const accepted: MergedCandidate[] = [];

  for (const shop of input.semantic) {
    const existing = byId.get(shop.id);
    if (existing) {
      // Already eligible through the factual arm; the semantic arm only adds
      // provenance. No gate needed, and no duplicate row.
      if (!existing.origins.includes('semantic')) {
        existing.origins = ['factual', 'semantic'];
      }
      continue;
    }

    if (!satisfiesPlan(shop, input.plan)) {
      rejected.push(shop.id);
      continue;
    }

    const candidate: MergedCandidate = {
      shop,
      origins: ['semantic'],
      similarity: similarityById.get(shop.id) ?? null,
    };
    byId.set(shop.id, candidate);
    accepted.push(candidate);
  }

  accepted.sort((a, b) => {
    const bySimilarity = (b.similarity ?? 0) - (a.similarity ?? 0);
    return bySimilarity !== 0 ? bySimilarity : a.shop.id.localeCompare(b.shop.id);
  });

  return {
    candidates: [...order.map((id) => byId.get(id)!), ...accepted],
    rejected,
  };
}

/** Similarities keyed by shop id, in the shape ranking consumes. */
export function similarityIndex(candidates: readonly MergedCandidate[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const candidate of candidates) {
    if (candidate.similarity !== null) {
      index.set(candidate.shop.id, candidate.similarity);
    }
  }
  return index;
}
