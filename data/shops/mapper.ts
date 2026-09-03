import { isHttpUrl } from '../../lib/http-url';
import { SHOP_AUDIENCES } from '../../types/shop';
import type { PriceLevel, Shop, ShopAudience, ShopCategoryRef, ShopImages } from '../../types/shop';

/**
 * The single boundary between Supabase rows and the UI.
 *
 * Nothing downstream understands snake_case, PostgREST join shapes, or the
 * fact that an embedded to-one relation arrives as an object while a to-many
 * arrives as an array. Components receive a `Shop` and nothing else.
 *
 * The mapper is defensive rather than trusting: PostgREST will happily return
 * a null embedded relation, an empty array, or a row whose optional columns
 * are all null, and every one of those is a normal state rather than an error.
 */

/** Shape returned by the repository's select. Mirrors the query exactly. */
export type ShopImageRow = {
  external_url: string | null;
  storage_path: string | null;
  image_type: string | null;
  position: number | null;
  alt_text: string | null;
};

export type ShopCategoryRow = {
  is_primary: boolean | null;
  categories: { slug: string; name: string } | null;
};

export type ShopTagRow = {
  tags: { slug: string; name: string } | null;
};

export type ShopVerificationRow = {
  verification_type: string | null;
  verified_at: string | null;
};

export type ShopRow = {
  id: string;
  slug: string;
  name: string;
  short_description: string | null;
  website_url: string | null;
  country_code: string | null;
  city: string | null;
  price_level: number | null;
  audience: string | null;
  published_at: string | null;
  shop_images: ShopImageRow[] | null;
  shop_categories: ShopCategoryRow[] | null;
  shop_tags: ShopTagRow[] | null;
  shop_verifications: ShopVerificationRow[] | null;
};

export function toShop(row: ShopRow): Shop {
  const categories = toCategories(row.shop_categories);

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    shortDescription: nonEmpty(row.short_description),
    // A malformed or non-http URL becomes null rather than reaching the
    // browser. The CTA is hidden when it is null.
    websiteUrl: isHttpUrl(row.website_url) ? (row.website_url as string).trim() : null,
    countryCode: nonEmpty(row.country_code),
    city: nonEmpty(row.city),
    priceLevel: toPriceLevel(row.price_level),
    audience: toAudience(row.audience),
    categories,
    primaryCategory: categories.find((category) => category.isPrimary) ?? categories[0] ?? null,
    tags: toTags(row.shop_tags),
    images: toImages(row.shop_images),
    // RLS already restricts this relation to approved, unexpired records, so
    // its mere presence is the answer. Nothing is recomputed here, and no
    // editable column is consulted.
    verified: (row.shop_verifications ?? []).length > 0,
    publishedAt: row.published_at,
  };
}

export function toShops(rows: readonly ShopRow[]): Shop[] {
  return rows.map(toShop);
}

/**
 * Cover first, then gallery, both ordered by `position`.
 *
 * A shop with only gallery images still gets a cover — promoting the first
 * one beats showing a typographic placeholder next to visuals that exist.
 * `storage_path` images are skipped: no Storage bucket is configured yet, so
 * there is no URL to build and guessing one would produce broken images.
 */
function toImages(rows: ShopImageRow[] | null): ShopImages {
  const usable = (rows ?? [])
    .filter((image) => isHttpUrl(image.external_url))
    .map((image) => ({
      url: (image.external_url as string).trim(),
      type: image.image_type ?? 'gallery',
      position: typeof image.position === 'number' ? image.position : 0,
    }))
    // Deterministic: position, then url as a tiebreaker so equal positions
    // never reorder between fetches.
    .sort((a, b) => a.position - b.position || a.url.localeCompare(b.url));

  const covers = usable.filter((image) => image.type === 'cover');
  const rest = usable.filter((image) => image.type !== 'cover' && image.type !== 'logo');

  if (covers.length > 0) {
    return { cover: covers[0]!.url, gallery: [...covers.slice(1), ...rest].map((i) => i.url) };
  }

  const [first, ...gallery] = rest;
  return { cover: first?.url ?? null, gallery: gallery.map((image) => image.url) };
}

/** Primary first, then alphabetical, so a card's single label is stable. */
function toCategories(rows: ShopCategoryRow[] | null): ShopCategoryRef[] {
  const seen = new Set<string>();
  const categories: ShopCategoryRef[] = [];

  for (const row of rows ?? []) {
    const category = row.categories;
    if (!category || typeof category.slug !== 'string' || seen.has(category.slug)) {
      continue;
    }
    seen.add(category.slug);
    categories.push({
      slug: category.slug,
      name: category.name,
      isPrimary: row.is_primary === true,
    });
  }

  return categories.sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) {
      return a.isPrimary ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

function toTags(rows: ShopTagRow[] | null): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const row of rows ?? []) {
    const tag = row.tags;
    if (!tag || typeof tag.name !== 'string' || seen.has(tag.slug)) {
      continue;
    }
    seen.add(tag.slug);
    names.push(tag.name);
  }
  return names.sort((a, b) => a.localeCompare(b));
}

function toAudience(value: string | null): ShopAudience | null {
  return (SHOP_AUDIENCES as readonly string[]).includes(value ?? '')
    ? (value as ShopAudience)
    : null;
}

function toPriceLevel(value: number | null): PriceLevel | null {
  if (value === 1 || value === 2 || value === 3 || value === 4) {
    return value;
  }
  return null;
}

function nonEmpty(value: string | null): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
