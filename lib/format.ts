import type { Shop } from '@/types/shop';

const COUNTRY_LABELS: Record<string, string> = {
  FR: 'France',
  BE: 'Belgique',
  DE: 'Allemagne',
  ES: 'Espagne',
  IT: 'Italie',
  NL: 'Pays-Bas',
  PT: 'Portugal',
  GB: 'Royaume-Uni',
};

/** French country name for an ISO alpha-2 code, falling back to the code. */
export function countryLabel(code: string): string {
  return COUNTRY_LABELS[code] ?? code;
}

/** The category shown on a card. Primary when one is set, else the first. */
export function shopCategoryLabel(shop: Shop): string | null {
  return shop.primaryCategory?.name ?? null;
}

/**
 * The single secondary line under a shop name, e.g. `Streetwear · France`.
 * One line, two facts: enough to situate a shop, nothing more.
 *
 * Both halves are optional in the database, so the separator only appears
 * when there are two things to separate.
 */
export function shopMetaLine(shop: Shop): string {
  const parts = [shopCategoryLabel(shop), shop.countryCode ? countryLabel(shop.countryCode) : null];
  return parts.filter((part): part is string => part !== null).join(' · ');
}
