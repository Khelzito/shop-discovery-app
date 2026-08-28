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

/**
 * The single secondary line under a shop name, e.g. `Streetwear · France`.
 * One line, two facts: enough to situate a shop, nothing more.
 */
export function shopMetaLine(shop: Shop): string {
  return `${shop.category} · ${countryLabel(shop.country)}`;
}
