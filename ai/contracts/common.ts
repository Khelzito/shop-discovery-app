/**
 * Vocabulary shared by every AI contract.
 *
 * These values mirror the CHECK constraints in the deployed schema, so a
 * validated contract can be written to the database without translation.
 */

/** Matches `shops.audience` and `shop_ai_analyses.detected_audience`. */
export const AUDIENCES = ['women', 'men', 'kids', 'unisex', 'all'] as const;
export type Audience = (typeof AUDIENCES)[number];

/** Matches `shop_ai_analyses.detected_price_positioning`. */
export const PRICE_POSITIONINGS = ['budget', 'mid', 'premium', 'luxury', 'unknown'] as const;
export type PricePositioning = (typeof PRICE_POSITIONINGS)[number];

/**
 * How much the user wants to be pushed away from already-popular shops.
 * Feeds the diversity term of ranking, never a hard filter.
 */
export const POPULARITY_PREFERENCES = ['any', 'prefer_lesser_known', 'prefer_established'] as const;
export type PopularityPreference = (typeof POPULARITY_PREFERENCES)[number];

/** ISO 3166-1 alpha-2, uppercase. Matches the `country_code` domain. */
export type CountryCode = string;

/** ISO 4217, uppercase. Matches the `currency_code` domain. */
export type CurrencyCode = string;

/** ISO 639-1, lowercase. */
export type LanguageCode = string;

/** A slug from `categories.slug` or `tags.slug`. */
export type Slug = string;

/** A confidence in [0, 1]. Never a percentage, never unbounded. */
export type Confidence = number;
