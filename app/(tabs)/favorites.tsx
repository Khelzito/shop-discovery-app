import { router } from 'expo-router';
import { StyleSheet, useWindowDimensions, View } from 'react-native';

import { ShopCard } from '@/components/shop/shop-card';
import { EmptyState, Screen, Text } from '@/components/ui';
import { useFavorites } from '@/state/favorites';
import { layout, spacing } from '@/theme';

const COLUMN_GAP = spacing.sm;

/**
 * Favoris — the user's own collection of saved shops.
 *
 * A two-column grid where the photography is the card: no surface, no border,
 * no shadow. The screen is a pure view onto the shared favorites store, so a
 * shop saved from Accueil or Explorer is already here, and removing one here
 * empties its heart everywhere.
 */
export default function FavoritesScreen() {
  const { width } = useWindowDimensions();
  const { favoriteShops, toggleFavorite } = useFavorites();

  const cardWidth = Math.floor((width - layout.screenPadding * 2 - COLUMN_GAP) / 2);

  return (
    <Screen scroll>
      <Text variant="title">Favoris</Text>

      {favoriteShops.length > 0 ? (
        <View style={styles.grid}>
          {favoriteShops.map((shop) => (
            <ShopCard
              key={shop.id}
              shop={shop}
              width={cardWidth}
              favorite
              onToggleFavorite={toggleFavorite}
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
