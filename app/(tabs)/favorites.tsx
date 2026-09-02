import { router } from 'expo-router';
import { useCallback } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';

import { ShopCard } from '@/components/shop/shop-card';
import { EmptyState, Screen, ShopCardSkeleton, Text } from '@/components/ui';
import { getShopsByIds } from '@/data/shops';
import { useAsyncResource } from '@/lib/use-async-resource';
import { useFavorites } from '@/state/favorites';
import { layout, spacing } from '@/theme';
import type { Shop } from '@/types/shop';

const COLUMN_GAP = spacing.sm;

/**
 * Favoris — the user's own collection of saved shops.
 *
 * A two-column grid where the photography is the card: no surface, no border,
 * no shadow. The store holds only ids, so this screen resolves them against
 * the catalogue in a single query — one request, not one per heart.
 *
 * A favourited shop that is later unpublished simply stops resolving and
 * disappears from the grid, which is the correct behaviour: an unpublished
 * shop must not be reachable from a discovery surface.
 */
export default function FavoritesScreen() {
  const { width } = useWindowDimensions();
  const { favoriteIds, toggleFavorite } = useFavorites();

  const key = favoriteIds.join(',');
  const load = useCallback(
    () => getShopsByIds(key.length > 0 ? key.split(',') : []),
    [key]
  );
  const shops = useAsyncResource(load);

  const openShop = (shop: Shop) => router.push({ pathname: '/shop/[id]', params: { id: shop.id } });

  const cardWidth = Math.floor((width - layout.screenPadding * 2 - COLUMN_GAP) / 2);
  const resolved = shops.data ?? [];

  return (
    <Screen scroll>
      <Text variant="title">Favoris</Text>

      {favoriteIds.length > 0 && shops.status === 'loading' ? (
        <View style={styles.grid}>
          {favoriteIds.slice(0, 4).map((id) => (
            <ShopCardSkeleton key={id} width={cardWidth} />
          ))}
        </View>
      ) : null}

      {shops.status === 'error' ? (
        <EmptyState
          tone="error"
          title="Chargement impossible"
          description="Vérifie ta connexion et réessaie."
          actionLabel="Réessayer"
          onActionPress={shops.reload}
          style={styles.empty}
        />
      ) : null}

      {shops.status === 'ready' && resolved.length > 0 ? (
        <View style={styles.grid}>
          {resolved.map((shop) => (
            <ShopCard
              key={shop.id}
              shop={shop}
              width={cardWidth}
              favorite
              onToggleFavorite={toggleFavorite}
              onPress={openShop}
            />
          ))}
        </View>
      ) : null}

      {shops.status === 'ready' && resolved.length === 0 ? (
        <EmptyState
          title="Aucun favori"
          description="Tes boutiques préférées apparaîtront ici."
          actionLabel="Explorer les boutiques"
          onActionPress={() => router.push('/explore')}
          style={styles.empty}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: COLUMN_GAP,
    rowGap: spacing.xl,
    marginTop: layout.sectionGap,
  },
  empty: {
    marginTop: layout.sectionGap,
  },
});
