import type { Audience, Confidence, PricePositioning, Slug } from './common.ts';
import type { ModelMetadata } from './model.ts';

/** A classification the model proposes. Never an accepted fact. */
export type SuggestedCategory = {
  slug: Slug;
  confidence: Confidence;
};

export type SuggestedTag = {
  slug: Slug;
  confidence: Confidence;
};

/**
 * Visual reading of a shop. Populated only once image analysis exists; the
 * field is present now so adding it later is not a breaking change.
 */
export type VisualIdentity = {
  /** Hex colours sampled from the shop's own imagery. */
  dominantColors: string[];
  /** Free-form descriptors: "editorial", "high-contrast", "pastel". */
  descriptors: string[];
};

/** The fields a per-field confidence may be reported for. */
export const SHOP_ANALYSIS_FIELDS = [
  'summary',
  'suggestedCategories',
  'suggestedTags',
  'detectedStyles',
  'detectedAudience',
  'detectedProducts',
  'detectedValues',
  'pricePositioning',
  'keywords',
  'visualIdentity',
] as const;
export type ShopAnalysisField = (typeof SHOP_ANALYSIS_FIELDS)[number];

/**
 * What a model inferred about a shop from its public website.
 *
 * Every field here is an INTERPRETATION. None of it is verified, none of it
 * may overwrite a declared fact, and none of it grants a shop verification or
 * publication. A merchant reviews and corrects this before it becomes
 * anything (docs/AI_ARCHITECTURE.md).
 *
 * `unknown` is a valid answer and is preferred over a confident guess.
 */
export type ShopAnalysis = {
  summary: string | null;
  suggestedCategories: SuggestedCategory[];
  suggestedTags: SuggestedTag[];
  detectedStyles: string[];
  detectedAudience: Audience[];
  detectedProducts: string[];
  detectedValues: string[];
  pricePositioning: PricePositioning;
  keywords: string[];
  visualIdentity: VisualIdentity | null;
  /** Overall confidence in the analysis. */
  confidence: Confidence;
  /** Optional per-field confidence, for fields the model was unsure about. */
  fieldConfidence: Partial<Record<ShopAnalysisField, Confidence>>;
};

/**
 * An analysis together with what produced it, ready to persist.
 * Mirrors a `shop_ai_analyses` row.
 */
export type ShopAnalysisRecord = {
  analysis: ShopAnalysis;
  model: ModelMetadata;
  /** The URL that was analysed. */
  sourceUrl: string;
  /** Hash of the extracted content, so an unchanged site is not re-analysed. */
  sourceHash: string | null;
  analyzedAt: string;
};
