import type { SemanticMatch } from '@/ai/contracts/endpoints';
import type { SearchIntent } from '@/ai/contracts/search-intent';
import { toShops, type ShopRow } from '@/data/shops/mapper';
import { getShopsByIds, shopClient } from '@/data/shops/repository';
import { planShopFilters, type ShopFilterPlan } from './intent-filters';
import { mergeCandidates, similarityIndex, type MergedCandidate } from './merge';
import { buildShopSearchQuery } from './query';
import { rankShops, type RankedShop } from './rank';

/**
 * Intent-driven shop retrieval — Search V2, hybrid.
 *
 * Two arms meet here. The FACTUAL arm turns hard constraints into SQL and the
 * database decides eligibility. The SEMANTIC arm arrives as a list of shop ids
 * the server found close to the query's meaning; this module re-reads those
 * shops through the ordinary RLS-governed query and gates them against the
 * same plan before letting them in.
 *
 * NOTHING HERE CAN PROMOTE A SHOP THAT FAILED A FILTER. A factual candidate
 * never reaches ranking unless the database returned it, and a semantic
 * candidate never reaches ranking unless `satisfiesPlan` agrees with the SQL
 * that already gated it server-side. Similarity only reorders and widens; it
 * never overrules the catalogue.
 *
 * With no semantic matches — provider down, nothing embedded, purely factual
 * query — this is byte for byte the V1 path: one query, one ranking pass, no
 * similarity term. That is the fallback, and it is the default rather than a
 * special case.
 */

/** Bounded so a growing catalogue cannot turn one search into a huge payload. */
export const DEFAULT_CANDIDATE_LIMIT = 60;

export type ShopSearchOutcome = {
  results: RankedShop[];
  /** What was actually applied, and what was deliberately not. */
  plan: ShopFilterPlan;
  /** Candidates before ranking, for diagnosing an empty result. */
  candidateCount: number;
  /** Development diagnostics for the hybrid step. Never rendered. */
  hybrid: {
    factualCount: number;
    /** Semantic ids that survived the gate and were not already factual. */
    semanticAddedCount: number;
    /** Semantic ids the gate rejected. Should normally be empty. */
    rejectedCount: number;
  };
};

export type ShopSearchOptions = {
  limit?: number;
  offset?: number;
  now?: Date;
  /**
   * Shop ids and similarities from the semantic arm.
   *
   * Absent or empty means the semantic arm did not run or found nothing, and
   * the search is exactly V1.
   */
  semanticMatches?: readonly SemanticMatch[];
};

export async function searchShopsByIntent(
  intent: SearchIntent,
  options: ShopSearchOptions = {}
): Promise<ShopSearchOutcome> {
  const plan = planShopFilters(intent);
  const limit = options.limit ?? DEFAULT_CANDIDATE_LIMIT;
  const offset = options.offset ?? 0;
  const matches = options.semanticMatches ?? [];

  const factual = await retrieveFactual(plan, limit, offset);

  // Only the ids the factual arm did NOT already return are fetched, and only
  // when there are any: a query that matched everything semantically must not
  // cost a second round trip for rows we are holding.
  const known = new Set(factual.map((shop) => shop.id));
  const missingIds = [...new Set(matches.map((match) => match.shopId))].filter(
    (id) => !known.has(id)
  );

  // getShopsByIds applies `status = published` and runs under the caller's own
  // RLS, so an id the server proposed cannot surface a shop this user could
  // not already read.
  const semantic = missingIds.length > 0 ? await getShopsByIds(missingIds) : [];

  const merged = mergeCandidates({ factual, semantic, similarities: matches, plan });
  const candidates = merged.candidates;

  return {
    results: rankShops(
      candidates.map((candidate) => candidate.shop),
      intent,
      options.now,
      similarityIndex(candidates)
    ),
    plan,
    candidateCount: candidates.length,
    hybrid: {
      factualCount: factual.length,
      semanticAddedCount: countSemanticOnly(candidates),
      rejectedCount: merged.rejected.length,
    },
  };
}

/**
 * The V1 query, unchanged.
 *
 * Built in ./query, which has no Supabase import and is therefore testable;
 * this is the thin part that runs it.
 */
async function retrieveFactual(plan: ShopFilterPlan, limit: number, offset: number) {
  const query = buildShopSearchQuery(plan);

  let request = shopClient().from('shops').select(query.select);
  // A total switch over the three filter kinds. The plan decided what must be
  // true and ./query decided how to ask; this only hands it to the client.
  for (const filter of query.filters) {
    if (filter.kind === 'eq') {
      request = request.eq(filter.column, filter.value);
    } else if (filter.kind === 'in') {
      request = request.in(filter.column, filter.values);
    } else {
      request = request.or(filter.filter);
    }
  }

  const { data, error } = await request
    .order('published_at', { ascending: false })
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) {
    if (__DEV__) {
      console.warn('[search] retrieval failed', { code: error.code });
    }
    throw new Error('Shop search failed');
  }

  return toShops((data ?? []) as unknown as ShopRow[]);
}

function countSemanticOnly(candidates: readonly MergedCandidate[]): number {
  return candidates.filter(
    (candidate) => candidate.origins.length === 1 && candidate.origins[0] === 'semantic'
  ).length;
}
