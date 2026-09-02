import type {
  Audience,
  Confidence,
  CountryCode,
  CurrencyCode,
  LanguageCode,
  PopularityPreference,
  PricePositioning,
  Slug,
} from './common.ts';

/**
 * Constraints the catalogue must satisfy. These become SQL.
 *
 * A shop that fails a hard filter is not a worse result, it is not a result.
 * "Ships to France" and "under 150 EUR" belong here: returning a shop that
 * cannot deliver, however semantically perfect, is a broken answer.
 *
 * Every field is nullable or empty by default. An absent constraint must
 * never be invented by the model.
 */
export type SearchHardFilters = {
  /** Slugs from `categories`, resolved to ids before querying. */
  categorySlugs: Slug[];
  audiences: Audience[];
  /** Where the shop itself is based. */
  countryCodes: CountryCode[];
  /** Where the user needs delivery. */
  shippingCountryCodes: CountryCode[];
  priceMin: number | null;
  priceMax: number | null;
  currency: CurrencyCode | null;
  /** Only shops holding an approved verification. */
  verifiedOnly: boolean;
};

/**
 * Everything that should influence the ORDER of results, never their
 * presence. These become ranking weights.
 *
 * "Minimalist", "a bit chic", "lesser known" are judgements, not facts:
 * treating them as filters would silently hide good shops over a model's
 * opinion.
 */
export type SearchSoftPreferences = {
  styles: string[];
  productTypes: string[];
  values: string[];
  brandPositioning: PricePositioning | null;
  popularity: PopularityPreference;
};

/** How the intent was produced. Lets cheap and strong tiers coexist later. */
export const INTENT_SOURCES = ['deterministic', 'model'] as const;
export type IntentSource = (typeof INTENT_SOURCES)[number];

/**
 * The validated structured reading of a user's query.
 *
 * The split between `hard` and `soft` is the single most important decision
 * in this contract: it is what stops a language model from quietly deciding
 * which shops a user is allowed to see.
 */
export type SearchIntent = {
  /** Exactly what the user typed, unmodified. */
  originalQuery: string;
  language: LanguageCode | null;
  /**
   * The query restated for embedding: constraints stripped, meaning kept.
   * "petite marque francaise minimaliste autour de 100 euros" becomes
   * "petite marque minimaliste" once country and price move to `hard`.
   */
  semanticQuery: string;
  hard: SearchHardFilters;
  soft: SearchSoftPreferences;
  /** How sure the parser is overall. Drives fallback to a stronger tier. */
  confidence: Confidence;
  source: IntentSource;
};

/** An intent asking nothing: the safe result when parsing fails. */
export function emptySearchIntent(originalQuery: string, source: IntentSource): SearchIntent {
  return {
    originalQuery,
    language: null,
    semanticQuery: originalQuery,
    hard: {
      categorySlugs: [],
      audiences: [],
      countryCodes: [],
      shippingCountryCodes: [],
      priceMin: null,
      priceMax: null,
      currency: null,
      verifiedOnly: false,
    },
    soft: {
      styles: [],
      productTypes: [],
      values: [],
      brandPositioning: null,
      popularity: 'any',
    },
    confidence: 0,
    source,
  };
}
