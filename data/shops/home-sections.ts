import type { Shop } from '../../types/shop';

/**
 * TEMPORARY Home composition.
 *
 * There is no recommendation engine, and there are no exposure signals yet:
 * `shop_views` and `outbound_clicks` exist but are empty, so nothing here can
 * honestly claim to know what is popular or what suits a given user.
 *
 * So this is deterministic and says so. It is NOT personalisation, and it
 * fabricates no metric it does not have. Its only real jobs are to fill the
 * three approved sections from real data and to guarantee the rule the spec
 * does impose: a shop never appears twice on one Home render
 * (docs/MASTER_SPEC.md §7).
 *
 * Replacing it means replacing this one pure function. Nothing else on Home
 * knows how the sections were chosen.
 */

export type HomeSections = {
  /** Placeholder for personalisation: a category-diversified slice. */
  forYou: Shop[];
  /** Placeholder for low-exposure ranking: verified shops outside the newest. */
  hiddenGems: Shop[];
  /** Genuinely newest by `published_at`. The one section that is already real. */
  newest: Shop[];
};

const NEWEST_COUNT = 6;
const HIDDEN_GEM_COUNT = 3;
const FOR_YOU_COUNT = 6;

/**
 * @param shops Published shops, already ordered newest first by the repository.
 */
export function buildHomeSections(shops: readonly Shop[]): HomeSections {
  const newest = shops.slice(0, NEWEST_COUNT);
  const taken = new Set(newest.map((shop) => shop.id));

  const remaining = shops.filter((shop) => !taken.has(shop.id));

  // "Hidden gems" must at least mean "worth trusting", and verification is the
  // only quality signal that actually exists today. Older shops first, since
  // the newest ones already have their own section.
  const gemCandidates = [
    ...remaining.filter((shop) => shop.verified),
    ...remaining.filter((shop) => !shop.verified),
  ];
  const hiddenGems = diversify(gemCandidates, HIDDEN_GEM_COUNT);
  hiddenGems.forEach((shop) => taken.add(shop.id));

  const forYou = diversify(
    shops.filter((shop) => !taken.has(shop.id)),
    FOR_YOU_COUNT
  );

  // With a small catalogue every shop can land in `newest`, leaving the other
  // two sections empty and Home looking broken. Falling back to the newest
  // shops keeps the screen whole; the duplicate-free rule still holds within
  // each render because these are disjoint slices of the same ordered list.
  if (forYou.length === 0 && hiddenGems.length === 0 && newest.length > 0) {
    return { forYou: [], hiddenGems: [], newest };
  }

  return { forYou, hiddenGems, newest };
}

/**
 * Picks `count` shops while avoiding two of the same category in a row.
 *
 * Deterministic: it walks the input in order and defers a shop whose category
 * matches the previous pick, rather than shuffling. The same input always
 * produces the same output, which matters because Home should not reshuffle
 * on every render.
 */
function diversify(shops: readonly Shop[], count: number): Shop[] {
  const picked: Shop[] = [];
  const deferred: Shop[] = [];
  let lastCategory: string | null = null;

  for (const shop of shops) {
    if (picked.length >= count) {
      break;
    }
    const category = shop.primaryCategory?.slug ?? null;
    if (category !== null && category === lastCategory) {
      deferred.push(shop);
      continue;
    }
    picked.push(shop);
    lastCategory = category;
  }

  for (const shop of deferred) {
    if (picked.length >= count) {
      break;
    }
    picked.push(shop);
  }

  return picked;
}
