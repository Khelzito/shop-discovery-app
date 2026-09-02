import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

type FavoritesContextValue = {
  isFavorite: (shopId: string) => boolean;
  toggleFavorite: (shopId: string) => void;
  /**
   * Saved shop ids, most recently added last. The Favoris screen resolves
   * them against the catalogue; this store deliberately holds no shop data.
   */
  favoriteIds: readonly string[];
};

const FavoritesContext = createContext<FavoritesContextValue | null>(null);

/**
 * Session-scoped favorites, shared by every tab.
 *
 * The store holds only database uuids. It used to derive shop objects from
 * the mock catalogue; now that shops come from Supabase, resolving an id to a
 * shop is a query, and doing it here would make this module fetch data on
 * behalf of screens. The Favoris screen owns that query instead.
 *
 * Starts empty on purpose. The old seed referenced mock ids, and mixing those
 * with real uuids would produce favourites that resolve to nothing.
 *
 * State lives in memory only: it survives navigation between tabs but not a
 * reload. Persistence belongs with the `favorites` table, which exists and is
 * deliberately not wired up in this phase.
 *
 * React Context is enough here — the value changes rarely and the tree is
 * small — so no state library is pulled in.
 */
export function FavoritesProvider({ children }: { children: ReactNode }) {
  // Insertion-ordered: a Set preserves it, so the grid shows what was saved
  // first at the top rather than reordering on every change.
  const [favoriteIds, setFavoriteIds] = useState<ReadonlySet<string>>(() => new Set());

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

  const orderedIds = useMemo(() => [...favoriteIds], [favoriteIds]);

  const value = useMemo(
    () => ({ isFavorite, toggleFavorite, favoriteIds: orderedIds }),
    [isFavorite, toggleFavorite, orderedIds]
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
