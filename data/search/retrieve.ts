import type { SearchIntent } from '@/ai/contracts/search-intent';
import { toShops, type ShopRow } from '@/data/shops/mapper';
import { shopClient, shopSelect } from '@/data/shops/repository';
import { planShopFilters, type ShopFilterPlan } from './intent-filters';
import { rankShops, type RankedShop } from './rank';

/**
 * Intent-driven shop retrieval.
 *
 * The whole phase in one function: hard constraints become SQL, the database
 * decides eligibility, and ranking only orders what survived. Nothing here can
 * promote a shop that failed a filter, because such a shop is never fetched.
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

  // PostgREST refuses to filter an embedded resource that is not in the select
  // (PGRST108), and only joins inner when asked — so the select is built from
  // the filters rather than fixed.
  const select = shopSelect({
    categories: plan.categorySlugs.length > 0,
    verifications: plan.verifiedOnly,
  });

  let request = shopClient()
    .from('shops')
    // Redundant with the anonymous RLS policy and kept deliberately: a
    // signed-in merchant CAN see their own drafts through their policy, and a
    // discovery surface must never show them.
    .select(select)
    .eq('status', 'published');

  if (plan.categorySlugs.length > 0) {
    request = request.in('shop_categories.categories.slug', plan.categorySlugs);
  }
  if (plan.countryCodes.length > 0) {
    request = request.in('country_code', plan.countryCodes);
  }
  if (plan.audiences.length > 0) {
    // A shop that declared no audience is kept: absence of data is not a
    // mismatch. Exactness is rewarded in ranking instead.
    request = request.or(
      `audience.in.(${plan.audiences.join(',')}),audience.is.null`
    );
  }
  if (plan.priceMin !== null) {
    // Null-tolerant on purpose: "no declared price" must not read as "too
    // expensive". Today no shop declares a range, so this excludes nothing.
    request = request.or(`price_max.is.null,price_max.gte.${plan.priceMin}`);
  }
  if (plan.priceMax !== null) {
    request = request.or(`price_min.is.null,price_min.lte.${plan.priceMax}`);
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
