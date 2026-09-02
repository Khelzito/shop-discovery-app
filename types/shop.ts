/**
 * The consumer-facing shop model.
 *
 * This is what the UI is allowed to know. It is a deliberate projection of the
 * database, not a mirror of it: moderation state, verification evidence, AI
 * inferences and confidences, claim and submission internals, and member data
 * all exist in the schema and none of them appear here. RLS and column grants
 * make them unreachable from the client anyway; this model makes it obvious.
 *
 * Every field is factual or publicly derived. Nothing here is AI-inferred.
 */

/** 1 = accessible, 4 = luxury. Declared by the merchant. */
export type PriceLevel = 1 | 2 | 3 | 4;

export type ShopCategoryRef = {
  slug: string;
  name: string;
  /** One category per shop may be primary; it drives the card's single label. */
  isPrimary: boolean;
};

export type ShopImages = {
  /** Main visual, or null when the shop has none usable yet. */
  cover: string | null;
  /** Additional visuals in deterministic order. */
  gallery: string[];
};

export type Shop = {
  /** Database uuid. Stable, and what favourites and routes key on. */
  id: string;
  slug: string;
  name: string;
  shortDescription: string | null;
  /** Validated http(s), or null. Never a placeholder. */
  websiteUrl: string | null;
  countryCode: string | null;
  city: string | null;
  priceLevel: PriceLevel | null;
  categories: ShopCategoryRef[];
  /** Convenience: the primary category, else the first, else null. */
  primaryCategory: ShopCategoryRef | null;
  tags: string[];
  images: ShopImages;
  /**
   * Derived from approved, unexpired verification records the client is
   * allowed to see. There is no editable `verified` column anywhere, and no
   * client can write this.
   */
  verified: boolean;
  publishedAt: string | null;
};
