/**
 * Shop domain model.
 *
 * This mirrors the shape the Supabase read model will expose later
 * (docs/DATABASE.md), so screens built against the mock data keep working
 * once real data arrives.
 */

export type ShopImages = {
  /** Main editorial visual. `null` when the shop has no usable imagery yet. */
  cover: string | null;
  /** Additional visuals, used by the shop profile in a later phase. */
  gallery: string[];
};

/** 1 = accessible, 2 = milieu de gamme, 3 = premium. */
export type PriceLevel = 1 | 2 | 3;

export type Shop = {
  id: string;
  name: string;
  /** Single positioning label. Home shows exactly one category per shop. */
  category: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  description: string;
  /** Trust status is granted server-side and can never be purchased. */
  verified: boolean;
  images: ShopImages;
  tags: string[];
  priceLevel: PriceLevel;
  website: string;
};
