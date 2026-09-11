import { router } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';

import { CategoryFilter } from '@/components/shop/category-filter';
import { InspirationRail } from '@/components/shop/inspiration-rail';
import { ShopRow } from '@/components/shop/shop-row';
import { Button, EmptyState, Screen, SearchField, Section, Skeleton, Text } from '@/components/ui';
import { INSPIRATIONS } from '@/data/inspirations';
import { searchShopsByIntent } from '@/data/search';
import { getCategories, getPublishedShops } from '@/data/shops';
import { recordSearchInteraction } from '@/lib/api/discovery';
import { searchWithIntent } from '@/lib/api/search';
import { useAsyncResource } from '@/lib/use-async-resource';
import { useAuth } from '@/state/auth';
import { useFavorites } from '@/state/favorites';
import { usePreferences } from '@/state/preferences';
import { layout, spacing } from '@/theme';
import type { Shop } from '@/types/shop';

const BROWSE_LIMIT = 40;

/** Result of a submitted natural-language search. */
type SearchState =
  | { status: 'idle' }
  | { status: 'loading'; query: string }
  | { status: 'ready'; query: string; shops: Shop[]; degraded: boolean; searchId: string | null }
  | { status: 'error'; query: string };

/**
 * Explorer — active discovery over real published shops.
 *
 * Two distinct paths, deliberately:
 *
 *   * Browsing and category chips query the catalogue directly. Tapping a chip
 *     is a factual filter and must never cost an AI call.
 *   * Submitting free text calls ai-search, which parses the intent and, when
 *     the query carries meaning no column holds, also returns semantically
 *     close shops. Retrieval then merges both arms and ranks them.
 *
 * Hard constraints stay gates on both arms: "quiet luxury" can now surface a
 * shop whose text never contains those words, but "marque française" still
 * cannot return a German one however close its vector is.
 *
 * If ai-search is unreachable the client falls back to ai-search-intent and
 * the search runs exactly as it did in V1, without the semantic arm.
 */
export default function ExploreScreen() {
  const { width } = useWindowDimensions();
  const [query, setQuery] = useState('');
  const [categorySlug, setCategorySlug] = useState<string | null>(null);
  const [search, setSearch] = useState<SearchState>({ status: 'idle' });
  const { session } = useAuth();
  const { isFavorite, toggleFavorite } = useFavorites();
  const { deliveryCountry, hydrated: preferencesHydrated } = usePreferences();

  const loadBrowse = useCallback(
    () => getPublishedShops({ limit: BROWSE_LIMIT, categorySlug }),
    [categorySlug]
  );
  const browse = useAsyncResource(loadBrowse);

  const loadCategories = useCallback(() => getCategories(), []);
  const categories = useAsyncResource(loadCategories);

  const searching = search.status !== 'idle';
  const isBrowsing = !searching && categorySlug === null;

  const resetFilters = () => {
    setQuery('');
    setCategorySlug(null);
    setSearch({ status: 'idle' });
  };

  const openShop = (shop: Shop) => {
    const position = listShops.findIndex((candidate) => candidate.id === shop.id);
    const searchId = search.status === 'ready' ? search.searchId : null;
    if (searching) void recordSearchInteraction(searchId, shop.id, 'shop_open', position);
    router.push({
      pathname: '/shop/[id]',
      params: {
        id: shop.id,
        source: searching ? 'search' : 'explore',
        ...(searchId ? { searchId } : {}),
        ...(position >= 0 ? { position: String(position) } : {}),
      },
    });
  };

  /**
   * The full path: query -> intent -> factual retrieval -> ranking.
   *
   * A degraded intent still drives retrieval. The deterministic tier produces
   * a real SearchIntent, so an AI outage narrows what search understands
   * without stopping it.
   */
  const submitSearch = async () => {
    const submitted = query.trim();
    if (submitted.length === 0) {
      setSearch({ status: 'idle' });
      return;
    }

    // A free-text search supersedes the chip, so results can never be silently
    // narrowed by a filter the user is no longer looking at.
    setCategorySlug(null);
    setSearch({ status: 'loading', query: submitted });

    const outcome = await searchWithIntent(
      submitted,
      session && preferencesHydrated ? { shippingCountryCode: deliveryCountry } : {}
    );
    if (!outcome.ok) {
      if (__DEV__) {
        console.log('[search] intent unavailable:', outcome.error.code);
      }
      setSearch({ status: 'error', query: submitted });
      return;
    }

    try {
      const found = await searchShopsByIntent(outcome.intent, {
        semanticMatches: outcome.semanticMatches,
      });
      if (__DEV__) {
        console.log('[search]', {
          source: outcome.intent.source,
          degraded: outcome.degraded,
          semantic: outcome.semantic,
          hybrid: found.hybrid,
          applied: found.plan,
          results: found.results.map((result) => ({
            slug: result.shop.slug,
            score: result.score,
            reasons: result.reasons,
          })),
        });
      }
      setSearch({
        status: 'ready',
        query: submitted,
        shops: found.results.map((result) => result.shop),
        degraded: outcome.degraded,
        searchId: outcome.searchId,
      });
    } catch {
      setSearch({ status: 'error', query: submitted });
    }
  };

  const inspirationWidth = Math.round((width - layout.screenPadding * 2) * 0.74);

  const listShops = searching
    ? search.status === 'ready'
      ? search.shops
      : []
    : (browse.data?.shops ?? []);
  const listLoading = searching ? search.status === 'loading' : browse.status === 'loading';
  const listError = searching ? search.status === 'error' : browse.status === 'error';

  return (
    <Screen scroll>
      <Text variant="title">Explorer</Text>

      <View style={styles.controls}>
        <SearchField
          value={query}
          onChangeText={(value) => {
            setQuery(value);
            if (value.trim().length === 0) {
              setSearch({ status: 'idle' });
            }
          }}
          returnKeyType="search"
          onSubmitEditing={() => {
            void submitSearch();
          }}
        />
        <Button
          label="Demander à l’assistant"
          iconLeft="sparkle"
          variant="secondary"
          fullWidth
          onPress={() => router.push('/assistant' as never)}
        />
        <CategoryFilter
          categories={categories.data ?? []}
          selected={categorySlug}
          onSelect={(slug) => {
            // Chips are a factual filter: no intent call, no cost.
            setSearch({ status: 'idle' });
            setQuery('');
            setCategorySlug(slug);
          }}
        />
      </View>

      <View style={styles.sections}>
        {isBrowsing ? (
          <Section title="Inspirations">
            <InspirationRail inspirations={INSPIRATIONS} itemWidth={inspirationWidth} />
          </Section>
        ) : null}

        <Section title={isBrowsing ? 'À découvrir' : 'Résultats'}>
          {listLoading ? <ListSkeleton /> : null}

          {listError ? (
            <EmptyState
              tone="error"
              title="Recherche indisponible"
              description="Vérifie ta connexion et réessaie."
              actionLabel="Réessayer"
              onActionPress={() => {
                if (searching) {
                  void submitSearch();
                } else {
                  browse.reload();
                }
              }}
            />
          ) : null}

          {!listLoading && !listError && listShops.length > 0 ? (
            <View style={styles.list}>
              {listShops.map((shop, index) => (
                <ShopRow
                  key={shop.id}
                  shop={shop}
                  favorite={isFavorite(shop.id)}
                  onToggleFavorite={(shopId) => {
                    const wasFavorite = isFavorite(shopId);
                    toggleFavorite(shopId);
                    if (searching && !wasFavorite) {
                      const searchId = search.status === 'ready' ? search.searchId : null;
                      void recordSearchInteraction(searchId, shopId, 'favorite', index);
                    }
                  }}
                  onPress={openShop}
                />
              ))}
            </View>
          ) : null}

          {/* Strict correctness: an empty result stays empty rather than
              quietly dropping a constraint the user actually stated. */}
          {!listLoading && !listError && listShops.length === 0 ? (
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
