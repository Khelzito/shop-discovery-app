import { router } from 'expo-router';
import { useMemo } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';

import { featuredCardWidth, standardCardWidth } from '@/components/shop/shop-card';
import { ShopRail } from '@/components/shop/shop-rail';
import { Screen, SearchField, Section } from '@/components/ui';
import { FOR_YOU_SHOPS, HIDDEN_GEM_SHOPS, NEW_SHOPS } from '@/data/mock-shops';
import { useFavorites } from '@/state/favorites';
import { layout, spacing } from '@/theme';
import type { Shop } from '@/types/shop';

const COMPACT_CARD_WIDTH = 140;

/**
 * Home — the discovery entry point.
 *
 * Three sections only: Pour toi, Pépites cachées, Nouveautés. No greeting, no
 * categories, no promotion, no explanation of why a shop is recommended
 * (docs/MASTER_SPEC.md §7). Content starts immediately under the search field
 * and photography carries the screen.
 */
export default function HomeScreen() {
  const { width } = useWindowDimensions();
  const { isFavorite, toggleFavorite } = useFavorites();

  const cardWidths = useMemo(
    () => ({
      standard: standardCardWidth(width, spacing.sm),
      featured: featuredCardWidth(width),
    }),
    [width]
  );

  const openSearch = () => router.push('/explore');
  const openShop = (shop: Shop) => router.push({ pathname: '/shop/[id]', params: { id: shop.id } });

  return (
    <Screen scroll>
      <SearchField
        value=""
        onChangeText={() => {}}
        size="md"
        placeholder="Rechercher une boutique, un produit..."
        readOnlyPress={openSearch}
      />

      <View style={styles.sections}>
        <Section title="Pour toi" actionLabel="Voir tout" onActionPress={openSearch}>
          <ShopRail
            shops={FOR_YOU_SHOPS}
            variant="standard"
            itemWidth={cardWidths.standard}
            snap
            isFavorite={isFavorite}
            onToggleFavorite={toggleFavorite}
            onPressShop={openShop}
            accessibilityLabel="Boutiques sélectionnées pour toi"
          />
        </Section>

        <Section title="Pépites cachées" actionLabel="Voir tout" onActionPress={openSearch}>
          <ShopRail
            shops={HIDDEN_GEM_SHOPS}
            variant="featured"
            itemWidth={cardWidths.featured}
            snap
            isFavorite={isFavorite}
            onToggleFavorite={toggleFavorite}
            onPressShop={openShop}
            accessibilityLabel="Pépites cachées"
          />
        </Section>

        <Section title="Nouveautés" actionLabel="Voir tout" onActionPress={openSearch}>
          <ShopRail
            shops={NEW_SHOPS}
            variant="compact"
            itemWidth={COMPACT_CARD_WIDTH}
            isFavorite={isFavorite}
            onToggleFavorite={toggleFavorite}
            onPressShop={openShop}
            accessibilityLabel="Boutiques récemment ajoutées"
          />
        </Section>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  sections: {
    gap: layout.sectionGap,
    marginTop: spacing.xl,
  },
});
