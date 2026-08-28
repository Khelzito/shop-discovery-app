import type { Shop } from '@/types/shop';

export type ExploreCategory = {
  id: string;
  label: string;
  /**
   * Shop categories that roll up into this browse entry. Explorer offers a
   * short, human list; the catalogue itself uses finer labels.
   */
  shopCategories: readonly string[];
};

/**
 * The browse categories offered on Explorer.
 *
 * Kept deliberately short. This is a lightweight way into the catalogue, not
 * a taxonomy — a full category tree is not part of V1.
 */
export const EXPLORE_CATEGORIES: readonly ExploreCategory[] = [
  {
    id: 'mode',
    label: 'Mode',
    shopCategories: [
      'Streetwear',
      'Prêt-à-porter',
      'Mode responsable',
      'Maroquinerie',
      'Accessoires',
    ],
  },
  { id: 'sneakers', label: 'Sneakers', shopCategories: ['Chaussures'] },
  { id: 'bijoux', label: 'Bijoux', shopCategories: ['Bijoux'] },
  { id: 'beaute', label: 'Beauté', shopCategories: ['Beauté'] },
  { id: 'maison', label: 'Maison', shopCategories: ['Décoration'] },
  { id: 'tech', label: 'Tech', shopCategories: ['Audio'] },
  { id: 'sport', label: 'Sport', shopCategories: ['Sport'] },
];

export function matchesCategory(shop: Shop, categoryId: string | null): boolean {
  if (categoryId === null) {
    return true;
  }
  const category = EXPLORE_CATEGORIES.find((candidate) => candidate.id === categoryId);
  return category ? category.shopCategories.includes(shop.category) : true;
}
