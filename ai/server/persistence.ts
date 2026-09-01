import type { EmbeddingResult, EmbeddingSourceKind } from '../contracts/embedding';
import type { SearchIntent } from '../contracts/search-intent';
import type { ShopAnalysisRecord } from '../contracts/shop-analysis';

/**
 * Mappers from AI contracts to the shapes of the deployed tables.
 *
 * Kept here rather than inside the services so the contracts stay free of
 * database concerns, and so the exact column mapping is reviewable in one
 * place. These build plain objects; nothing here talks to Supabase.
 */

/** A row for `shop_ai_analyses`. Every value is an AI inference. */
export type ShopAiAnalysisRow = {
  shop_id: string | null;
  submission_id: string | null;
  source_url: string;
  status: 'completed';
  summary: string | null;
  detected_styles: string[];
  detected_audience: string[];
  detected_products: string[];
  detected_values: string[];
  detected_price_positioning: string;
  keywords: string[];
  suggested_categories: { slug: string; confidence: number }[];
  suggested_tags: { slug: string; confidence: number }[];
  confidence_score: number;
  model_provider: string;
  model_name: string;
  analysis_version: string;
  source_hash: string | null;
  raw_extraction: Record<string, unknown> | null;
  analyzed_at: string;
};

export function toShopAiAnalysisRow(
  record: ShopAnalysisRecord,
  subject: { shopId?: string | null; submissionId?: string | null },
  rawExtraction?: Record<string, unknown> | null
): ShopAiAnalysisRow {
  const { analysis, model } = record;

  // The schema has no column for per-field confidence or visual identity yet.
  // Rather than drop them, they ride along in raw_extraction, which exists for
  // exactly this: material worth keeping that is not yet worth a column.
  const extras: Record<string, unknown> = { ...(rawExtraction ?? {}) };
  if (Object.keys(analysis.fieldConfidence).length > 0) {
    extras.fieldConfidence = analysis.fieldConfidence;
  }
  if (analysis.visualIdentity) {
    extras.visualIdentity = analysis.visualIdentity;
  }

  return {
    shop_id: subject.shopId ?? null,
    submission_id: subject.submissionId ?? null,
    source_url: record.sourceUrl,
    status: 'completed',
    summary: analysis.summary,
    detected_styles: analysis.detectedStyles,
    detected_audience: analysis.detectedAudience,
    detected_products: analysis.detectedProducts,
    detected_values: analysis.detectedValues,
    detected_price_positioning: analysis.pricePositioning,
    keywords: analysis.keywords,
    suggested_categories: analysis.suggestedCategories,
    suggested_tags: analysis.suggestedTags,
    confidence_score: analysis.confidence,
    model_provider: model.provider,
    model_name: model.model,
    analysis_version: model.contractVersion,
    source_hash: record.sourceHash,
    raw_extraction: Object.keys(extras).length > 0 ? extras : null,
    analyzed_at: record.analyzedAt,
  };
}

/** A row for `shop_embeddings`. */
export type ShopEmbeddingRow = {
  shop_id: string;
  embedding: number[];
  dimensions: number;
  embedding_model: string;
  embedding_version: string | null;
  source_hash: string | null;
  source_kind: EmbeddingSourceKind;
};

export function toShopEmbeddingRow(
  shopId: string,
  result: EmbeddingResult,
  sourceKind: EmbeddingSourceKind
): ShopEmbeddingRow {
  return {
    shop_id: shopId,
    embedding: result.vector,
    // Reported by the provider, never assumed. The column is an unconstrained
    // pgvector for the same reason.
    dimensions: result.dimensions,
    embedding_model: `${result.model.provider}:${result.model.model}`,
    embedding_version: result.model.modelVersion,
    source_hash: result.sourceHash,
    source_kind: sourceKind,
  };
}

/** A row for `searches`. */
export type SearchRow = {
  user_id: string | null;
  query_text: string;
  parsed_intent: Record<string, unknown>;
  category_ids: string[] | null;
  country_codes: string[] | null;
  price_min: number | null;
  price_max: number | null;
  search_mode: 'classic' | 'natural' | 'category';
  results_count: number | null;
};

/**
 * `searches` stores category IDs while an intent carries slugs, because the
 * intent is produced before any database lookup. The caller resolves slugs to
 * ids and passes them in; an unresolvable slug is simply dropped rather than
 * failing the search.
 */
export function toSearchRow(
  intent: SearchIntent,
  resolved: { userId: string | null; categoryIds: string[]; resultsCount: number | null }
): SearchRow {
  return {
    user_id: resolved.userId,
    query_text: intent.originalQuery.slice(0, 500),
    parsed_intent: intent as unknown as Record<string, unknown>,
    category_ids: resolved.categoryIds.length > 0 ? resolved.categoryIds : null,
    country_codes: intent.hard.countryCodes.length > 0 ? intent.hard.countryCodes : null,
    price_min: intent.hard.priceMin,
    price_max: intent.hard.priceMax,
    search_mode: intent.source === 'model' ? 'natural' : 'classic',
    results_count: resolved.resultsCount,
  };
}
