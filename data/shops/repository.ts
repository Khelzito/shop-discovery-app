import { supabase } from '@/lib/supabase';
import type { Shop } from '@/types/shop';
import { toShops, type ShopRow } from './mapper';

/**
 * The only place the app talks to Supabase about shops.
 *
 * Screens call these functions and receive `Shop` objects; no component builds
 * a query or sees a raw row. Every read runs under the anon/authenticated RLS
 * policies deployed in Prompt 9 — there is no elevated credential in the app
 * and there never can be, since only the publishable key ships in the bundle.
 *
 * `status = eq.published` is redundant with the RLS policy for anonymous
 * users, and deliberately kept: a signed-in merchant CAN see their own draft
 * shops through that policy, and a discovery surface must never show them.
 */

/**
 * Selected explicitly rather than with `*`.
 *
 * Beyond avoiding useless bytes, this is the list a reviewer can check against
 * the client model: adding an internal column here would be visible in the
 * diff instead of arriving silently with a schema change.
 */
const SHOP_SELECT = `
  id,
  slug,
  name,
  short_description,
  website_url,
  country_code,
  city,
  price_level,
  published_at,
  shop_images(external_url, storage_path, image_type, position, alt_text),
  shop_categories(is_primary, categories(slug, name)),
  shop_tags(tags(slug, name)),
  shop_verifications(verification_type, verified_at)
`;

/** Keeps a first page bounded while the catalogue is small. */
export const DEFAULT_SHOP_LIMIT = 24;

export type ShopPage = {
  shops: Shop[];
  /** True when another page probably exists. Drives future pagination. */
  hasMore: boolean;
};

export type ShopQuery = {
  limit?: number;
  /** Rows to skip. The API is range-based so pagination needs no redesign. */
  offset?: number;
  categorySlug?: string | null;
};

export class ShopRepositoryError extends Error {
  readonly cause: unknown;
  constructor(operation: string, cause: unknown) {
    super(`Shop query failed: ${operation}`);
    this.name = 'ShopRepositoryError';
    this.cause = cause;
  }
}

function client() {
  if (!supabase) {
    throw new ShopRepositoryError('client', new Error('Supabase is not configured'));
  }
  return supabase;
}

/** Sanitised technical context for development, never shown to a user. */
function logFailure(operation: string, error: { code?: string; message?: string } | null): void {
  if (__DEV__ && error) {
    console.warn(`[shops] ${operation} failed`, { code: error.code });
  }
}

/**
 * Published shops, newest first.
 *
 * `published_at desc, id asc` rather than `published_at desc` alone: several
 * shops published in the same seed transaction share a timestamp, and without
 * a tiebreaker their relative order — and therefore any paging over them — is
 * undefined.
 */
export async function getPublishedShops(query: ShopQuery = {}): Promise<ShopPage> {
  const limit = query.limit ?? DEFAULT_SHOP_LIMIT;
  const offset = query.offset ?? 0;

  // An inner join makes the category filter run in Postgres rather than in the
  // app, so a filtered page is still a full page.
  const select = query.categorySlug
    ? SHOP_SELECT.replace('shop_categories(', 'shop_categories!inner(')
    : SHOP_SELECT;

  let request = client().from('shops').select(select).eq('status', 'published');

  if (query.categorySlug) {
    request = request.eq('shop_categories.categories.slug', query.categorySlug);
  }

  const { data, error } = await request
    .order('published_at', { ascending: false })
    .order('id', { ascending: true })
    // One row beyond the page reveals whether another page exists.
    .range(offset, offset + limit);

  if (error) {
    logFailure('getPublishedShops', error);
    throw new ShopRepositoryError('getPublishedShops', error);
  }

  const rows = (data ?? []) as unknown as ShopRow[];
  return { shops: toShops(rows.slice(0, limit)), hasMore: rows.length > limit };
}

/** One shop by uuid or slug. Returns null when nothing published matches. */
export async function getShopByIdOrSlug(identifier: string): Promise<Shop | null> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);

  const { data, error } = await client()
    .from('shops')
    .select(SHOP_SELECT)
    .eq('status', 'published')
    .eq(isUuid ? 'id' : 'slug', identifier)
    .limit(1);

  if (error) {
    logFailure('getShopByIdOrSlug', error);
    throw new ShopRepositoryError('getShopByIdOrSlug', error);
  }

  const rows = (data ?? []) as unknown as ShopRow[];
  return rows.length > 0 ? toShops(rows)[0]! : null;
}

/**
 * Shops for a set of ids, used by Favoris.
 *
 * One query rather than one per favourite: an N+1 here would mean a request
 * per heart. Ids that no longer resolve — unpublished, suspended, deleted —
 * are simply absent from the result.
 */
export async function getShopsByIds(ids: readonly string[]): Promise<Shop[]> {
  if (ids.length === 0) {
    return [];
  }

  const { data, error } = await client()
    .from('shops')
    .select(SHOP_SELECT)
    .eq('status', 'published')
    .in('id', [...ids])
    .limit(ids.length);

  if (error) {
    logFailure('getShopsByIds', error);
    throw new ShopRepositoryError('getShopsByIds', error);
  }

  const shops = toShops((data ?? []) as unknown as ShopRow[]);
  // Preserve the caller's order so the grid does not reshuffle on refetch.
  const byId = new Map(shops.map((shop) => [shop.id, shop]));
  return ids.map((id) => byId.get(id)).filter((shop): shop is Shop => shop !== undefined);
}

export type CategoryOption = { id: string; slug: string; name: string };

/** Active categories, ordered as the catalogue defines. */
export async function getCategories(): Promise<CategoryOption[]> {
  const { data, error } = await client()
    .from('categories')
    .select('id, slug, name')
    .eq('is_active', true)
    .order('sort_order', { ascending: true });

  if (error) {
    logFailure('getCategories', error);
    throw new ShopRepositoryError('getCategories', error);
  }

  return (data ?? []) as CategoryOption[];
}
