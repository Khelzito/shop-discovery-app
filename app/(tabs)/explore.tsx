import { useMemo, useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';

import { CategoryFilter } from '@/components/shop/category-filter';
import { InspirationRail } from '@/components/shop/inspiration-rail';
import { ShopRow } from '@/components/shop/shop-row';
import { EmptyState, Screen, SearchField, Section, Text } from '@/components/ui';
import { matchesCategory } from '@/data/explore-categories';
import { INSPIRATIONS } from '@/data/inspirations';
import { MOCK_SHOPS } from '@/data/mock-shops';
import { countryLabel } from '@/lib/format';
import { useFavorites } from '@/state/favorites';
import { layout, spacing } from '@/theme';
import type { Shop } from '@/types/shop';

/**
 * Explorer — active discovery.
 *
 * Home recommends; Explorer is where the user goes looking. One search field,
 * a light category filter, editorial themes when nothing is active, and a
 * browsable list of shops.
 *
 * Search is local and deliberately simple: a substring match over the mock
 * catalogue, no ranking and no AI. The real search runs server-side on its
 * own results route in a later phase, and this screen's `query` state is the
 * seam it plugs into. There is only ever one search experience — no separate
 * "AI mode" (docs/MASTER_SPEC.md §8).
 */
export default function ExploreScreen() {
  const { width } = useWindowDimensions();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const { isFavorite, toggleFavorite } = useFavorites();

  const trimmedQuery = query.trim();
  const isBrowsing = trimmedQuery.length === 0 && category === null;

  const shops = useMemo(
    () => MOCK_SHOPS.filter((shop) => matchesCategory(shop, category) && matchesQuery(shop, trimmedQuery)),
    [category, trimmedQuery]
  );

  const resetFilters = () => {
    setQuery('');
    setCategory(null);
  };

  const inspirationWidth = Math.round((width - layout.screenPadding * 2) * 0.74);

  return (
    <Screen scroll>
      <Text variant="title">Explorer</Text>

      <View style={styles.controls}>
        <SearchField value={query} onChangeText={setQuery} />
        <CategoryFilter selected={category} onSelect={setCategory} />
      </View>

      <View style={styles.sections}>
        {isBrowsing ? (
          <Section title="Inspirations">
            <InspirationRail inspirations={INSPIRATIONS} itemWidth={inspirationWidth} />
          </Section>
        ) : null}

        <Section title={isBrowsing ? 'À découvrir' : 'Résultats'}>
          {shops.length > 0 ? (
            <View style={styles.list}>
              {shops.map((shop) => (
                <ShopRow
                  key={shop.id}
                  shop={shop}
                  favorite={isFavorite(shop.id)}
                  onToggleFavorite={toggleFavorite}
                />
              ))}
            </View>
          ) : (
            <EmptyState
              icon="search"
              title="Aucune boutique trouvée"
              description="Essaie un terme plus large, ou parcours toutes les boutiques."
              actionLabel="Tout afficher"
              onActionPress={resetFilters}
            />
          )}
        </Section>
      </View>
    </Screen>
  );
}

/** Substring match over the few fields a user would reasonably type. */
function matchesQuery(shop: Shop, query: string): boolean {
  if (query.length === 0) {
    return true;
  }
  const needle = query.toLocaleLowerCase('fr-FR');
  return [shop.name, shop.category, countryLabel(shop.country), ...shop.tags].some((field) =>
    field.toLocaleLowerCase('fr-FR').includes(needle)
  );
}

const styles = StyleSheet.create({
  controls: {
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  sections: {
    gap: layout.sectionGap,
    marginTop: layout.sectionGap,
  },
  list: {
    gap: spacing.lg,
  },
});
