import type { Audience, CountryCode, PricePositioning, Slug } from './common.ts';
import type { ModelMetadata } from './model.ts';

/**
 * A shop offered to a reranker.
 *
 * Deliberately NOT a database row. A reranker should be replaceable and
 * testable without dragging Supabase types, RLS or nullability quirks into
 * the AI layer; the query layer projects rows into this shape.
 */
export type RerankCandidate = {
  shopId: string;
  /** Usually the shop name. */
  title: string;
  /** The text the reranker actually scores. Assembled by the caller. */
  document: string;
  /** Structured facts a reranker or a later ranking pass may use. */
  facts: {
    categorySlugs: Slug[];
    audience: Audience | null;
    countryCode: CountryCode | null;
    pricePositioning: PricePositioning | null;
    isVerified: boolean;
  };
};

export type RerankedCandidate = {
  shopId: string;
  /** Provider score. Comparable within one result set only. */
  score: number;
  /** Position before reranking, so the effect can be measured. */
  previousRank: number;
  rank: number;
};

export type RerankResult = {
  results: RerankedCandidate[];
  model: ModelMetadata;
};
