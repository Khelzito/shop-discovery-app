import { router, useLocalSearchParams } from 'expo-router';
import { useCallback } from 'react';
import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Button,
  EmptyState,
  FavoriteButton,
  IconButton,
  ImageFrame,
  Screen,
  Skeleton,
  Tag,
  Text,
  VerifiedMark,
} from '@/components/ui';
import { getShopByIdOrSlug } from '@/data/shops';
import { shopMetaLine } from '@/lib/format';
import { openExternalUrl } from '@/lib/url';
import { useAsyncResource } from '@/lib/use-async-resource';
import { useFavorites } from '@/state/favorites';
import { colors, layout, spacing } from '@/theme';

const MAX_TAGS = 3;
const GALLERY_WIDTH_RATIO = 0.62;

/**
 * Shop profile — the core moment of the product, now backed by Supabase.
 *
 * The photograph dominates and the text stays minimal: name, one meta line,
 * a short description, a few quiet tags, and a single dominant action. No
 * price, cart, delivery, rating or stock — Shop Discovery is not a
 * marketplace, and buying happens on the merchant's own site.
 *
 * The route accepts the database uuid or the slug, so a shareable link can
 * use the readable form later without changing anything here.
 *
 * Lives outside the `(tabs)` group, so the tab bar is naturally absent.
 */
export default function ShopDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { isFavorite, toggleFavorite } = useFavorites();

  const identifier = typeof id === 'string' ? id : '';
  const load = useCallback(() => getShopByIdOrSlug(identifier), [identifier]);
  const resource = useAsyncResource(load);

  if (resource.status === 'loading') {
    return <DetailSkeleton width={width} />;
  }

  if (resource.status === 'error') {
    return (
      <Screen center>
        <EmptyState
          tone="error"
          title="Chargement impossible"
          description="Vérifie ta connexion et réessaie."
          actionLabel="Réessayer"
          onActionPress={resource.reload}
        />
      </Screen>
    );
  }

  const shop = resource.data;

  if (!shop) {
    return (
      <Screen center>
        <EmptyState
          icon="alert"
          title="Boutique introuvable"
          description="Cette boutique n’est plus disponible."
          actionLabel="Retour"
          onActionPress={() => router.back()}
        />
      </Screen>
    );
  }

  const metaLine = shopMetaLine(shop);
  const tags = shop.tags.slice(0, MAX_TAGS);
  const websiteUrl = shop.websiteUrl;
  const galleryWidth = Math.round((width - layout.screenPadding * 2) * GALLERY_WIDTH_RATIO);

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <ImageFrame
          name={shop.name}
          source={shop.images.cover}
          ratio="portrait"
          width={width}
          radius="none"
        />

        <View style={styles.body}>
          <View style={styles.heading}>
            <View style={styles.nameRow}>
              <Text variant="title" style={styles.name}>
                {shop.name}
              </Text>
              {shop.verified ? <VerifiedMark /> : null}
            </View>
            {metaLine.length > 0 ? (
              <Text variant="body" tone="secondary">
                {metaLine}
              </Text>
            ) : null}
          </View>

          {shop.shortDescription ? (
            <Text variant="body" numberOfLines={3}>
              {shop.shortDescription}
            </Text>
          ) : null}

          {tags.length > 0 ? (
            <View style={styles.tags}>
              {tags.map((tag) => (
                <Tag key={tag} label={tag} />
              ))}
            </View>
          ) : null}

          {/* Hidden rather than broken when the catalogue has no usable URL. */}
          {websiteUrl ? (
            <Button
              label="Visiter la boutique"
              iconRight="external"
              size="lg"
              fullWidth
              style={styles.cta}
              onPress={() => {
                void openExternalUrl(websiteUrl);
              }}
            />
          ) : null}
        </View>

        {shop.images.gallery.length > 0 ? (
          <View style={styles.gallery}>
            <Text variant="sectionTitle" style={styles.galleryTitle}>
              À découvrir
            </Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.galleryRow}
              decelerationRate="fast"
              snapToInterval={galleryWidth + spacing.sm}
              snapToAlignment="start">
              {shop.images.gallery.map((image) => (
                <ImageFrame
                  key={image}
                  name={shop.name}
                  source={image}
                  ratio="portrait"
                  width={galleryWidth}
                />
              ))}
            </ScrollView>
          </View>
        ) : null}
      </ScrollView>

      <View
        pointerEvents="box-none"
        style={[styles.floatingHeader, { top: insets.top + spacing.xs }]}>
        <IconButton icon="back" onPress={() => router.back()} accessibilityLabel="Retour" />
        <FavoriteButton
          active={isFavorite(shop.id)}
          onPress={() => toggleFavorite(shop.id)}
          label={shop.name}
        />
      </View>
    </View>
  );
}

/** Mirrors the loaded layout so the hero does not jump into place. */
function DetailSkeleton({ width }: { width: number }) {
  const insets = useSafeAreaInsets();

  return (
    <View style={styles.root}>
      <Skeleton width={width} ratio={layout.imageRatio.portrait} radius="none" />
      <View style={styles.body}>
        <Skeleton width="70%" height={30} />
        <Skeleton width="45%" height={20} />
        <Skeleton width="100%" height={44} />
      </View>
      <View
        pointerEvents="box-none"
        style={[styles.floatingHeader, { top: insets.top + spacing.xs }]}>
        <IconButton icon="back" onPress={() => router.back()} accessibilityLabel="Retour" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    paddingBottom: spacing.huge,
  },
  floatingHeader: {
    position: 'absolute',
    left: layout.screenPadding,
    right: layout.screenPadding,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  body: {
    paddingHorizontal: layout.screenPadding,
    paddingTop: spacing.xl,
    gap: spacing.md,
  },
  heading: {
    gap: spacing.xxs,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  name: {
    flexShrink: 1,
  },
  tags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  cta: {
    marginTop: spacing.xs,
  },
  gallery: {
    marginTop: layout.sectionGap,
  },
  galleryTitle: {
    paddingHorizontal: layout.screenPadding,
    marginBottom: layout.sectionHeaderGap,
  },
  galleryRow: {
    gap: spacing.sm,
    paddingHorizontal: layout.screenPadding,
  },
});
