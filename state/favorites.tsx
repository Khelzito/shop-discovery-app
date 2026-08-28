import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { MOCK_SHOPS, SEED_FAVORITE_SHOPS } from '@/data/mock-shops';
import type { Shop } from '@/types/shop';

type FavoritesContextValue = {
  isFavorite: (shopId: string) => boolean;
  toggleFavorite: (shopId: string) => void;
  /** Saved shops, in catalogue order. */
  favoriteShops: readonly Shop[];
};

const FavoritesContext = createContext<FavoritesContextValue | null>(null);

/**
 * Session-scoped favorites, shared by every tab.
 *
 * The store holds shop ids and derives the shop objects from the single mock
 * catalogue, so a favorite is never a copy of a shop that could drift from
 * the source. State lives in memory only: it survives navigation between
 * tabs but not a reload. Persistence and per-user favorites arrive with
 * Supabase and authentication.
 *
 * React Context is enough here — the value changes rarely and the tree is
 * small — so no state library is pulled in.
 */
export function FavoritesProvider({ children }: { children: ReactNode }) {
  const [favoriteIds, setFavoriteIds] = useState<ReadonlySet<string>>(
    () => new Set(SEED_FAVORITE_SHOPS.map((shop) => shop.id))
  );

  const isFavorite = useCallback((shopId: string) => favoriteIds.has(shopId), [favoriteIds]);

  const toggleFavorite = useCallback((shopId: string) => {
    setFavoriteIds((current) => {
      const next = new Set(current);
      if (next.has(shopId)) {
        next.delete(shopId);
      } else {
        next.add(shopId);
      }
      return next;
    });
  }, []);

  const favoriteShops = useMemo(
    () => MOCK_SHOPS.filter((shop) => favoriteIds.has(shop.id)),
    [favoriteIds]
  );

  const value = useMemo(
    () => ({ isFavorite, toggleFavorite, favoriteShops }),
    [isFavorite, toggleFavorite, favoriteShops]
  );

  return <FavoritesContext.Provider value={value}>{children}</FavoritesContext.Provider>;
}

export function useFavorites(): FavoritesContextValue {
  const context = useContext(FavoritesContext);
  if (context === null) {
    throw new Error('useFavorites must be called inside a FavoritesProvider');
  }
  return context;
}
