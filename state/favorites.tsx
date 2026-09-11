import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { loadFavoriteIds, setFavorite } from '@/lib/api/favorites';
import { useAuth } from '@/state/auth';

type FavoritesContextValue = {
  isFavorite: (shopId: string) => boolean;
  toggleFavorite: (shopId: string) => void;
  favoriteIds: readonly string[];
  hydrated: boolean;
};

const FavoritesContext = createContext<FavoritesContextValue | null>(null);

/**
 * Favorites are optimistic in the UI and persistent for signed-in users.
 * Signed-out users keep a session-local collection; signing in replaces it
 * with the account's server-owned rows rather than merging identities.
 */
export function FavoritesProvider({ children }: { children: ReactNode }) {
  const { session, status } = useAuth();
  const userId = session?.user.id ?? null;
  const [favoriteIds, setFavoriteIds] = useState<ReadonlySet<string>>(() => new Set());
  const [hydrated, setHydrated] = useState(status !== 'signedIn');
  const generation = useRef(0);

  useEffect(() => {
    const run = ++generation.current;
    if (!userId) {
      setFavoriteIds(new Set());
      setHydrated(true);
      return;
    }
    setHydrated(false);
    void loadFavoriteIds(userId)
      .then((ids) => {
        if (generation.current !== run) return;
        setFavoriteIds(new Set(ids));
        setHydrated(true);
      })
      .catch(() => {
        if (generation.current !== run) return;
        setHydrated(true);
      });
  }, [userId]);

  const isFavorite = useCallback((shopId: string) => favoriteIds.has(shopId), [favoriteIds]);

  const toggleFavorite = useCallback((shopId: string) => {
    const nextActive = !favoriteIds.has(shopId);
    setFavoriteIds((current) => {
      const next = new Set(current);
      if (nextActive) next.add(shopId);
      else next.delete(shopId);
      return next;
    });

    if (userId) {
      void setFavorite(userId, shopId, nextActive).catch(() => {
        // Roll back only this membership. Another tap wins because its desired
        // state is represented by the current set at the time this runs.
        setFavoriteIds((current) => {
          const next = new Set(current);
          if (nextActive) next.delete(shopId);
          else next.add(shopId);
          return next;
        });
      });
    }
  }, [favoriteIds, userId]);

  const orderedIds = useMemo(() => [...favoriteIds], [favoriteIds]);
  const value = useMemo(
    () => ({ isFavorite, toggleFavorite, favoriteIds: orderedIds, hydrated }),
    [isFavorite, toggleFavorite, orderedIds, hydrated]
  );

  return <FavoritesContext.Provider value={value}>{children}</FavoritesContext.Provider>;
}

export function useFavorites(): FavoritesContextValue {
  const context = useContext(FavoritesContext);
  if (context === null) throw new Error('useFavorites must be called inside a FavoritesProvider');
  return context;
}
