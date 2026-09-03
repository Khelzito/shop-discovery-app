import { shopSelect } from '../shops/select';
import type { ShopFilterPlan } from './intent-filters';

/**
 * The Supabase query a filter plan turns into, described as data.
 *
 * Extracted from `retrieve.ts` so it can be built and inspected without the
 * Supabase client — that client imports expo-sqlite and react-native, so any
 * module touching it is unloadable under a test runner and was therefore
 * untestable. Building the query is where a hard constraint is most easily
 * lost, so it is exactly the part that needs covering.
 *
 * The plan says what must be true; this says how PostgREST is asked for it.
 */

export type ShopQueryFilter =
  | { kind: 'eq'; column: string; value: string }
  | { kind: 'in'; column: string; values: string[] }
  | { kind: 'or'; filter: string };

export type ShopSearchQuery = {
  /** Embedded relations included, and which of them join inner. */
  select: string;
  filters: ShopQueryFilter[];
};

export function buildShopSearchQuery(plan: ShopFilterPlan): ShopSearchQuery {
  // PostgREST refuses to filter an embedded resource that is not in the select
  // (PGRST108), and only joins inner when asked — so the select is built from
  // the filters rather than fixed.
  const select = shopSelect({
    categories: plan.categorySlugs.length > 0,
    verifications: plan.verifiedOnly,
  });

  const filters: ShopQueryFilter[] = [
    // Redundant with the anonymous RLS policy and kept deliberately: a
    // signed-in merchant CAN see their own drafts through their policy, and a
    // discovery surface must never show them.
    { kind: 'eq', column: 'status', value: 'published' },
  ];

  if (plan.categorySlugs.length > 0) {
    filters.push({
      kind: 'in',
      column: 'shop_categories.categories.slug',
      values: [...plan.categorySlugs],
    });
  }
  if (plan.countryCodes.length > 0) {
    filters.push({ kind: 'in', column: 'country_code', values: [...plan.countryCodes] });
  }
  if (plan.audiences.length > 0) {
    // A shop that declared no audience is kept: absence of data is not a
    // mismatch. Exactness is rewarded in ranking instead.
    filters.push({ kind: 'or', filter: `audience.in.(${plan.audiences.join(',')}),audience.is.null` });
  }
  if (plan.priceMin !== null) {
    // Null-tolerant on purpose: "no declared price" must not read as "too
    // expensive". Today no shop declares a range, so this excludes nothing.
    filters.push({ kind: 'or', filter: `price_max.is.null,price_max.gte.${plan.priceMin}` });
  }
  if (plan.priceMax !== null) {
    filters.push({ kind: 'or', filter: `price_min.is.null,price_min.lte.${plan.priceMax}` });
  }

  return { select, filters };
}
