/**
 * The shape every shop read asks Supabase for.
 *
 * Its own module, deliberately, with no imports at all. Two reasons:
 *
 *   * The select string is the only thing standing between a filter and a
 *     wrong result set. A category filter that fails to restrict is invisible
 *     at every other layer — the query succeeds, rows come back, the mapper
 *     maps them, ranking ranks them, and the screen renders shops the user
 *     never asked for.
 *   * `repository.ts` imports the Supabase client, which pulls in expo-sqlite
 *     and react-native. Nothing that imports it can load in a test runner, so
 *     while the select lived there it could not be covered at all.
 */

/**
 * Selected explicitly rather than with `*`.
 *
 * Beyond avoiding useless bytes, this is the list a reviewer can check against
 * the client model: adding an internal column here would be visible in the
 * diff instead of arriving silently with a schema change.
 */
export const SHOP_SELECT = `
  id,
  slug,
  name,
  short_description,
  website_url,
  country_code,
  city,
  price_level,
  audience,
  published_at,
  shop_images(external_url, storage_path, image_type, position, alt_text),
  shop_categories(is_primary, categories(slug, name)),
  shop_tags(tags(slug, name)),
  shop_verifications(verification_type, verified_at)
`;

/**
 * PostgREST only allows filtering an embedded resource that appears in the
 * select, and only joins inner when asked (PGRST108 otherwise). Search needs
 * both variants, so the select is built rather than duplicated.
 */
export function shopSelect(inner: { categories?: boolean; verifications?: boolean } = {}): string {
  let select = SHOP_SELECT;

  if (inner.categories) {
    // Both levels must be inner, and this is the part that is easy to get
    // wrong. Categories hang off shops through a junction table, so the filter
    // column is `shop_categories.categories.slug` — two hops.
    //
    // The filter prunes the deepest relation it names: the nested `categories`
    // object becomes null on links that do not match, leaving rows shaped like
    // `{ is_primary: true, categories: null }`. `shop_categories!inner` then
    // asks only "does this shop have a link row at all", which every shop with
    // any category satisfies, so the parent survives.
    //
    // Only `categories!inner` propagates the pruning back up: it drops the
    // emptied link rows, which in turn empties `shop_categories` and drops the
    // shop. Without it a category filter silently degrades into no filter.
    select = select
      .replace('shop_categories(', 'shop_categories!inner(')
      .replace('categories(slug, name)', 'categories!inner(slug, name)');
  }

  if (inner.verifications) {
    // One hop, so a single `!inner` is genuinely enough here.
    select = select.replace('shop_verifications(', 'shop_verifications!inner(');
  }

  return select;
}
