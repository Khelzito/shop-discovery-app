import type { ModelMetadata } from './model';

/**
 * What can be embedded.
 *
 * A discriminated union rather than a bare string, because shop imagery is a
 * plausible second modality and a text-only signature would force a rewrite
 * of every caller the day images arrive.
 */
export type EmbeddingInput =
  | { modality: 'text'; text: string }
  | { modality: 'image'; imageUrl: string };

/** Why a vector was produced. Matches `shop_embeddings.source_kind`. */
export const EMBEDDING_SOURCE_KINDS = [
  'shop_profile',
  'shop_description',
  'shop_ai_summary',
] as const;
export type EmbeddingSourceKind = (typeof EMBEDDING_SOURCE_KINDS)[number];

/**
 * A vector and everything needed to interpret it later.
 *
 * `dimensions` is REPORTED, never assumed. No dimension is fixed anywhere in
 * this codebase: it is a property of whichever model is configured, and the
 * database column is deliberately unconstrained for the same reason. Callers
 * must read it from the result rather than hardcoding a size.
 */
export type EmbeddingResult = {
  vector: number[];
  dimensions: number;
  model: ModelMetadata;
  /** Hash of the embedded content, so stale vectors are detectable. */
  sourceHash: string | null;
};

/** A batch keeps its order: results[i] corresponds to inputs[i]. */
export type EmbeddingBatchResult = {
  results: EmbeddingResult[];
  model: ModelMetadata;
};
