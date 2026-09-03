import type { SearchIntent } from '../../ai/contracts/search-intent';

/**
 * The single translation from SearchIntent to database filters.
 *
 * Nothing else in the app reads `intent.hard`. Keeping the mapping in one pure
 * function means the rule that matters — which parts of an intent are allowed
 * to REMOVE shops — is reviewable in one place rather than spread across a
 * query builder and a component.
 *
 * The guiding principle: a hard filter is a claim that a shop is disqualified.
 * We only make that claim from facts the catalogue actually holds. Where the
 * data does not exist, the constraint is deferred rather than guessed, because
 * a wrong exclusion is invisible to the user — they simply never see the shop.
 */

/** A constraint the intent expressed that we deliberately did not apply. */
export const DEFERRED_FILTERS = [
  /** No shop declares shipping destinations yet. */
  'shipping_country',
  /** No `independent` field exists in the hard contract; it is a soft signal. */
  'independent',
  /** No exposure signals exist, so "lesser known" cannot be measured. */
  'popularity',
] as const;

export type DeferredFilter = (typeof DEFERRED_FILTERS)[number];

export type ShopFilterPlan = {
  categorySlugs: string[];
  countryCodes: string[];
  /** Expanded to the compatible set, not just the requested value. */
  audiences: string[];
  verifiedOnly: boolean;
  /**
   * Numeric bounds in the intent's currency.
   *
   * Applied null-tolerantly: a shop that declares no price range is NEVER
   * excluded, because "we have no data" is not the same as "it is too
   * expensive". Today no seeded shop declares one, so this excludes nothing
   * and starts working the moment merchants provide ranges.
   *
   * Euro amounts are NOT translated into `price_level`. There is no honest
   * conversion — a level-2 shop is not "under 150 €" — and inventing one would
   * silently hide shops over an arbitrary threshold.
   */
  priceMin: number | null;
  priceMax: number | null;
  deferred: DeferredFilter[];
};

/**
 * Audience is widened rather than matched exactly.
 *
 * Someone searching menswear is well served by a unisex shop, so excluding
 * `unisex` and `all` would hide good results for no factual reason. Exactness
 * is rewarded in ranking instead, where being wrong only costs a position.
 *
 * A shop that has declared no audience is also kept: absence of data is not
 * evidence of mismatch.
 */
export function expandAudiences(requested: readonly string[]): string[] {
  if (requested.length === 0) {
    return [];
  }
  const expanded = new Set<string>(requested);
  // 'all' and 'unisex' serve every audience.
  expanded.add('unisex');
  expanded.add('all');
  return [...expanded];
}

export function planShopFilters(intent: SearchIntent): ShopFilterPlan {
  const deferred: DeferredFilter[] = [];

  if (intent.hard.shippingCountryCodes.length > 0) {
    deferred.push('shipping_country');
  }
  if (intent.soft.popularity !== 'any') {
    deferred.push('popularity');
  }
  if (intent.soft.values.some(mentionsIndependent)) {
    deferred.push('independent');
  }

  return {
    categorySlugs: unique(intent.hard.categorySlugs),
    countryCodes: unique(intent.hard.countryCodes.map((code) => code.toUpperCase())),
    audiences: expandAudiences(intent.hard.audiences),
    verifiedOnly: intent.hard.verifiedOnly,
    priceMin: intent.hard.priceMin,
    priceMax: intent.hard.priceMax,
    deferred,
  };
}

/** True when the plan would narrow the catalogue at all. */
export function planIsRestrictive(plan: ShopFilterPlan): boolean {
  return (
    plan.categorySlugs.length > 0 ||
    plan.countryCodes.length > 0 ||
    plan.audiences.length > 0 ||
    plan.verifiedOnly ||
    plan.priceMin !== null ||
    plan.priceMax !== null
  );
}

function mentionsIndependent(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized.includes('independ') || normalized.includes('indépend');
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}
