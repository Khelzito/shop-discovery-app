import { router } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';

import { CategoryFilter } from '@/components/shop/category-filter';
import { InspirationRail } from '@/components/shop/inspiration-rail';
import { ShopRow } from '@/components/shop/shop-row';
import { EmptyState, Screen, SearchField, Section, Skeleton, Text } from '@/components/ui';
import { INSPIRATIONS } from '@/data/inspirations';
import { getCategories, getPublishedShops } from '@/data/shops';
import { parseSearchIntent } from '@/lib/api/search-intent';
import { countryLabel, shopCategoryLabel } from '@/lib/format';
import { useAsyncResource } from '@/lib/use-async-resource';
import { useFavorites } from '@/state/favorites';
import { layout, spacing } from '@/theme';
import type { Shop } from '@/types/shop';

const EXPLORE_SHOP_LIMIT = 40;

/**
 * Explorer — active discovery, now over real published shops.
 *
 * Home recommends; Explorer is where the user goes looking. One search field,
 * a light category filter, editorial themes when nothing is active, and a
 * browsable list of shops.
 *
 * Two things are deliberately separate here. The list is filtered locally by a
 * plain substring match over factual fields — this is NOT ranked search and
 * makes no claim to be. Submitting the query calls the ai-search-intent Edge
 * Function, whose structured intent is not yet applied to the results;
 * semantic retrieval and ranking are later phases. Keeping both means the
 * spine stays exercised without pretending the visible list came from it.
 */
export default function ExploreScreen() {
  const { width } = useWindowDimensions();
  const [query, setQuery] = useState('');
  const [categorySlug, setCategorySlug] = useState<string | null>(null);
  const { isFavorite, toggleFavorite } = useFavorites();

  const loadShops = useCallback(() => getPublishedShops({ limit: EXPLORE_SHOP_LIMIT }), []);
  const shops = useAsyncResource(loadShops);

  const loadCategories = useCallback(() => getCategories(), []);
  const categories = useAsyncResource(loadCategories);

  const trimmedQuery = query.trim();
  const isBrowsing = trimmedQuery.length === 0 && categorySlug === null;

  const results = useMemo(() => {
    const all = shops.data?.shops ?? [];
    return all.filter(
      (shop) => matchesCategory(shop, categorySlug) && matchesQuery(shop, trimmedQuery)
    );
  }, [shops.data, categorySlug, trimmedQuery]);

  const resetFilters = () => {
    setQuery('');
    setCategorySlug(null);
  };

  const openShop = (shop: Shop) => router.push({ pathname: '/shop/[id]', params: { id: shop.id } });

  /**
   * Exercises the ai-search-intent Edge Function. The parsed intent is logged
   * in development only; it does not drive the list yet.
   */
  const submitSearch = async () => {
    const submitted = query.trim();
    if (submitted.length === 0) {
      return;
    }
    const outcome = await parseSearchIntent(submitted);
    if (!__DEV__) {
      return;
    }
    if (outcome.ok) {
      console.log('[search-intent]', JSON.stringify(outcome.intent, null, 2));
      console.log('[search-intent] degraded:', outcome.degraded);
    } else {
      console.log('[search-intent] error:', outcome.error.code, outcome.error.message);
    }
  };

  const inspirationWidth = Math.round((width - layout.screenPadding * 2) * 0.74);

  return (
    <Screen scroll>
      <Text variant="title">Explorer</Text>

      <View style={styles.controls}>
        <SearchField
          value={query}
          onChangeText={setQuery}
          returnKeyType="search"
          onSubmitEditing={() => {
            void submitSearch();
          }}
        />
        <CategoryFilter
          categories={categories.data ?? []}
          selected={categorySlug}
          onSelect={setCategorySlug}
        />
      </View>

      <View style={styles.sections}>
        {isBrowsing ? (
          <Section title="Inspirations">
            <InspirationRail inspirations={INSPIRATIONS} itemWidth={inspirationWidth} />
          </Section>
        ) : null}

        <Section title={isBrowsing ? 'À découvrir' : 'Résultats'}>
          {shops.status === 'loading' ? <ListSkeleton /> : null}

          {shops.status === 'error' ? (
            <EmptyState
              tone="error"
              title="Chargement impossible"
              description="Vérifie ta connexion et réessaie."
              actionLabel="Réessayer"
              onActionPress={shops.reload}
            />
          ) : null}

          {shops.status === 'ready' && results.length > 0 ? (
            <View style={styles.list}>
              {results.map((shop) => (
                <ShopRow
                  key={shop.id}
                  shop={shop}
                  favorite={isFavorite(shop.id)}
                  onToggleFavorite={toggleFavorite}
                  onPress={openShop}
                />
              ))}
            </View>
          ) : null}

          {shops.status === 'ready' && results.length === 0 ? (
            <EmptyState
              icon="search"
              title="Aucune boutique trouvée"
              description="Essaie un terme plus large, ou parcours toutes les boutiques."
              actionLabel="Tout afficher"
              onActionPress={resetFilters}
            />
          ) : null}
        </Section>
      </View>
    </Screen>
  );
}

function ListSkeleton() {
  return (
    <View style={styles.list}>
      {[0, 1, 2, 3].map((index) => (
        <View key={index} style={styles.skeletonRow}>
          <Skeleton width={84} height={84} radius="md" />
          <View style={styles.skeletonText}>
            <Skeleton width="60%" height={17} />
            <Skeleton width="40%" height={13} />
          </View>
        </View>
      ))}
    </View>
  );
}

function matchesCategory(shop: Shop, slug: string | null): boolean {
  if (slug === null) {
    return true;
  }
  return shop.categories.some((category) => category.slug === slug);
}

/** Substring match over the few factual fields a user would reasonably type. */
function matchesQuery(shop: Shop, query: string): boolean {
  if (query.length === 0) {
    return true;
  }
  const needle = query.toLocaleLowerCase('fr-FR');
  const fields = [
    shop.name,
    shopCategoryLabel(shop) ?? '',
    shop.countryCode ? countryLabel(shop.countryCode) : '',
    shop.city ?? '',
    ...shop.tags,
  ];
  return fields.some((field) => field.toLocaleLowerCase('fr-FR').includes(needle));
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
  skeletonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  skeletonText: {
    flex: 1,
    gap: spacing.xs,
  },
});
