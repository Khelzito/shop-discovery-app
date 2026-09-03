/**
 * Intent-driven shop search.
 *
 * Prompt 14 scope: AI intent extraction + factual database retrieval +
 * deterministic ranking. No embeddings, no vector search, no reranker.
 */
export {
  DEFERRED_FILTERS,
  planIsRestrictive,
  planShopFilters,
  expandAudiences,
  type DeferredFilter,
  type ShopFilterPlan,
} from './intent-filters';
export { RANKING_WEIGHTS, rankShops, textOverlap, tokenize, type RankedShop } from './rank';
export {
  DEFAULT_CANDIDATE_LIMIT,
  searchShopsByIntent,
  type ShopSearchOptions,
  type ShopSearchOutcome,
} from './retrieve';
