import { router } from 'expo-router';
import { useCallback, useEffect, useMemo } from 'react';
import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';

import { featuredCardWidth, standardCardWidth } from '@/components/shop/shop-card';
import { ShopRail } from '@/components/shop/shop-rail';
import { EmptyState, Screen, SearchField, Section, ShopCardSkeleton } from '@/components/ui';
import { buildHomeSections, getPublishedShops } from '@/data/shops';
import { getPersonalizedHome, homeIdsFromDiscovery, recordHomeImpressions } from '@/lib/api/discovery';
import { useFocusResource } from '@/lib/use-focus-resource';
import { useFavorites } from '@/state/favorites';
import { layout, spacing } from '@/theme';
import type { Shop } from '@/types/shop';

const COMPACT_CARD_WIDTH = 140;
/** Enough to fill three sections without fetching a catalogue that will grow. */
const HOME_SHOP_LIMIT = 24;

/**
 * Home — the discovery entry point, now reading published shops from Supabase.
 *
 * Three sections only: Pour toi, Pépites cachées, Nouveautés. No greeting, no
 * categories, no promotion, no explanation of why a shop is recommended
 * (docs/MASTER_SPEC.md §7). Content starts immediately under the search field
 * and photography carries the screen.
 *
 * Ranking is server-side: explicit interests, first-party behaviour, quality,
 * freshness and controlled exposure. If the Prompt 18 RPC is unavailable, the
 * previous deterministic composition remains a safe fallback.
 */
export default function HomeScreen() {
  const { width } = useWindowDimensions();
  const { isFavorite, toggleFavorite } = useFavorites();

  const load = useCallback(async () => {
    try {
      return await getPersonalizedHome(6);
    } catch {
      const page = await getPublishedShops({ limit: HOME_SHOP_LIMIT });
      return buildHomeSections(page.shops);
    }
  }, []);
  const shops = useFocusResource(load);
  const sections = shops.data ?? { forYou: [], hiddenGems: [], newest: [] };

  useEffect(() => {
    if (shops.status !== 'ready' || !shops.data) return;
    void recordHomeImpressions(homeIdsFromDiscovery(shops.data));
  }, [shops.status, shops.data]);

  const cardWidths = useMemo(
    () => ({
      standard: standardCardWidth(width, spacing.sm),
      featured: featuredCardWidth(width),
    }),
    [width]
  );

  const openSearch = () => router.push('/explore');
  const openShop = (shop: Shop) => router.push({ pathname: '/shop/[id]', params: { id: shop.id, source: 'home' } });

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
        {shops.status === 'loading' ? <HomeSkeleton width={cardWidths.standard} /> : null}

        {shops.status === 'error' ? (
          <EmptyState
            tone="error"
            title="Chargement impossible"
            description="Vérifie ta connexion et réessaie."
            actionLabel="Réessayer"
            onActionPress={shops.reload}
          />
        ) : null}

        {shops.status === 'ready' && sections.forYou.length + sections.hiddenGems.length + sections.newest.length === 0 ? (
          <EmptyState
            icon="search"
            title="Aucune boutique pour le moment"
            description="De nouvelles boutiques arrivent bientôt."
          />
        ) : null}

        {shops.status === 'ready' && sections.forYou.length > 0 ? (
          <Section title="Pour toi" actionLabel="Voir tout" onActionPress={openSearch}>
            <ShopRail
              shops={sections.forYou}
              variant="standard"
              itemWidth={cardWidths.standard}
              snap
              isFavorite={isFavorite}
              onToggleFavorite={toggleFavorite}
              onPressShop={openShop}
              accessibilityLabel="Boutiques sélectionnées pour toi"
            />
          </Section>
        ) : null}

        {shops.status === 'ready' && sections.hiddenGems.length > 0 ? (
          <Section title="Pépites cachées" actionLabel="Voir tout" onActionPress={openSearch}>
            <ShopRail
              shops={sections.hiddenGems}
              variant="featured"
              itemWidth={cardWidths.featured}
              snap
              isFavorite={isFavorite}
              onToggleFavorite={toggleFavorite}
              onPressShop={openShop}
              accessibilityLabel="Pépites cachées"
            />
          </Section>
        ) : null}

        {shops.status === 'ready' && sections.newest.length > 0 ? (
          <Section title="Nouveautés" actionLabel="Voir tout" onActionPress={openSearch}>
            <ShopRail
              shops={sections.newest}
              variant="compact"
              itemWidth={COMPACT_CARD_WIDTH}
              isFavorite={isFavorite}
              onToggleFavorite={toggleFavorite}
              onPressShop={openShop}
              accessibilityLabel="Boutiques récemment ajoutées"
            />
          </Section>
        ) : null}
      </View>
    </Screen>
  );
}

/** Mirrors the loaded layout so the screen does not jump when data arrives. */
function HomeSkeleton({ width }: { width: number }) {
  return (
    <>
      {['Pour toi', 'Pépites cachées', 'Nouveautés'].map((title) => (
        <Section key={title} title={title}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            scrollEnabled={false}
            style={styles.railBleed}
            contentContainerStyle={styles.railContent}>
            {[0, 1, 2].map((index) => (
              <ShopCardSkeleton key={index} width={width} />
            ))}
          </ScrollView>
        </Section>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  sections: {
    gap: layout.sectionGap,
    marginTop: spacing.xl,
  },
  railBleed: {
    marginHorizontal: -layout.screenPadding,
  },
  railContent: {
    gap: spacing.sm,
    paddingHorizontal: layout.screenPadding,
  },
});
