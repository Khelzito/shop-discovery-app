import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';

import { ShopCard } from '@/components/shop/shop-card';
import { EmptyState, Screen, Text } from '@/components/ui';
import { FAVORITE_SHOPS, MOCK_SHOPS } from '@/data/mock-shops';
import { layout, spacing } from '@/theme';

const COLUMN_GAP = spacing.sm;

/**
 * Favoris — the user's own collection of saved shops.
 *
 * A two-column grid where the photography is the card: no surface, no border,
 * no shadow. Removing a favorite is immediate and local; the favorites table
 * arrives with authentication in a later phase.
 */
export default function FavoritesScreen() {
  const { width } = useWindowDimensions();
  const [favoriteIds, setFavoriteIds] = useState<ReadonlySet<string>>(
    () => new Set(FAVORITE_SHOPS.map((shop) => shop.id))
  );

  const shops = useMemo(
    () => MOCK_SHOPS.filter((shop) => favoriteIds.has(shop.id)),
    [favoriteIds]
  );

  const removeFavorite = (shopId: string) => {
    setFavoriteIds((current) => {
      const next = new Set(current);
      next.delete(shopId);
      return next;
    });
  };

  const cardWidth = Math.floor((width - layout.screenPadding * 2 - COLUMN_GAP) / 2);

  return (
    <Screen scroll>
      <Text variant="title">Favoris</Text>

      {shops.length > 0 ? (
        <View style={styles.grid}>
          {shops.map((shop) => (
            <ShopCard
              key={shop.id}
              shop={shop}
              width={cardWidth}
              favorite
              onToggleFavorite={removeFavorite}
            />
          ))}
        </View>
      ) : (
        <EmptyState
          title="Aucun favori"
          description="Tes boutiques préférées apparaîtront ici."
          actionLabel="Explorer les boutiques"
          onActionPress={() => router.push('/explore')}
          style={styles.empty}
        />
      )}
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
