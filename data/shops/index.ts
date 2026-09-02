/**
 * Shop data access. Screens import from here, never from Supabase directly.
 */
export { buildHomeSections, type HomeSections } from './home-sections';
export { toShop, toShops, type ShopRow } from './mapper';
export {
  DEFAULT_SHOP_LIMIT,
  getCategories,
  getPublishedShops,
  getShopByIdOrSlug,
  getShopsByIds,
  ShopRepositoryError,
  type CategoryOption,
  type ShopPage,
  type ShopQuery,
} from './repository';
