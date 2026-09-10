/**
 * Intent-driven shop search.
 *
 * Deployed today: AI intent extraction + factual database retrieval +
 * deterministic ranking.
 *
 * Present but NOT yet wired into `searchShopsByIntent`: the hybrid merge and
 * the semantic ranking term. They are pure, tested and inert — nothing calls
 * them — because the semantic arm needs a vector index and an RPC that are
 * still proposals. Ranking without a similarity map behaves exactly as before.
 */
export {
  DEFERRED_FILTERS,
  planIsRestrictive,
  planShopFilters,
  expandAudiences,
  type DeferredFilter,
  type ShopFilterPlan,
} from './intent-filters';
export {
  CLIENT_UNCHECKABLE_CONSTRAINTS,
  mergeCandidates,
  satisfiesPlan,
  similarityIndex,
  type CandidateOrigin,
  type MergeOutcome,
  type MergedCandidate,
  type SemanticMatch,
} from './merge';
export {
  RANKING_WEIGHTS,
  SEMANTIC_SIMILARITY_FLOOR,
  rankShops,
  semanticBonus,
  textOverlap,
  tokenize,
  type RankedShop,
} from './rank';
export {
  DEFAULT_CANDIDATE_LIMIT,
  searchShopsByIntent,
  type ShopSearchOptions,
  type ShopSearchOutcome,
} from './retrieve';
