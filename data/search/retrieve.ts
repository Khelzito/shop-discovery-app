import type { SearchIntent } from '@/ai/contracts/search-intent';
import { toShops, type ShopRow } from '@/data/shops/mapper';
import { shopClient } from '@/data/shops/repository';
import { planShopFilters, type ShopFilterPlan } from './intent-filters';
import { buildShopSearchQuery } from './query';
import { rankShops, type RankedShop } from './rank';

/**
 * Intent-driven shop retrieval.
 *
 * The whole phase in one function: hard constraints become SQL, the database
 * decides eligibility, and ranking only orders what survived. Nothing here can
 * promote a shop that failed a filter, because such a shop is never fetched.
 *
 * The query itself is built in ./query, which has no Supabase import and is
 * therefore testable; this module is the thin part that runs it.
 *
 * This is NOT semantic search. There are no embeddings and no vector index; a
 * query that says "quiet luxury" matches nothing unless those words literally
 * appear in a shop's public text. Prompt 15 replaces that limitation.
 */

/** Bounded so a growing catalogue cannot turn one search into a huge payload. */
export const DEFAULT_CANDIDATE_LIMIT = 60;

export type ShopSearchOutcome = {
  results: RankedShop[];
  /** What was actually applied, and what was deliberately not. */
  plan: ShopFilterPlan;
  /** Candidates before ranking, for diagnosing an empty result. */
  candidateCount: number;
};

export type ShopSearchOptions = {
  limit?: number;
  offset?: number;
  now?: Date;
};

export async function searchShopsByIntent(
  intent: SearchIntent,
  options: ShopSearchOptions = {}
): Promise<ShopSearchOutcome> {
  const plan = planShopFilters(intent);
  const limit = options.limit ?? DEFAULT_CANDIDATE_LIMIT;
  const offset = options.offset ?? 0;

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

  const shops = toShops((data ?? []) as unknown as ShopRow[]);

  return {
    results: rankShops(shops, intent, options.now),
    plan,
    candidateCount: shops.length,
  };
}
