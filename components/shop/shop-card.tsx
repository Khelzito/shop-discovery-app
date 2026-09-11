import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { FavoriteButton } from '@/components/ui/favorite-button';
import { ImageFrame } from '@/components/ui/image-frame';
import { Text } from '@/components/ui/text';
import { VerifiedMark } from '@/components/ui/verified-mark';
import { shopCategoryLabel } from '@/lib/format';
import { layout, spacing } from '@/theme';
import type { Shop } from '@/types/shop';

/**
 * `standard` — tall portrait card, the Home default.
 * `featured` — wide editorial card that lets the photograph carry the section.
 * `compact`  — small square card for denser rows.
 */
export type ShopCardVariant = 'standard' | 'featured' | 'compact';

export type ShopCardProps = {
  shop: Shop;
  variant?: ShopCardVariant;
  /** Fixed card width. Omit to fill the parent. */
  width?: number;
  favorite: boolean;
  onToggleFavorite: (shopId: string) => void;
  /** Opens the shop profile. Wired once that route exists. */
  onPress?: (shop: Shop) => void;
  style?: StyleProp<ViewStyle>;
};

/**
 * A shop as it appears in a discovery list.
 *
 * Deliberately limited to image, name, verification mark, one category and
 * the favorite control. Country, price, rating, delivery and tags do not help
 * a user decide at this moment, so they are not shown (docs/DESIGN_SYSTEM.md).
 */
export function ShopCard({
  shop,
  variant = 'standard',
  width,
  favorite,
  onToggleFavorite,
  onPress,
  style,
}: ShopCardProps) {
  const isCompact = variant === 'compact';
  const category = shopCategoryLabel(shop);

  const body = (
    <>
      <ImageFrame
        name={shop.name}
        source={shop.images.cover}
        ratio={RATIO[variant]}
        width={width}
        radius={isCompact ? 'md' : 'image'}>
        <FavoriteButton
          active={favorite}
          onPress={() => onToggleFavorite(shop.id)}
          label={shop.name}
          size={isCompact ? 'sm' : 'md'}
          style={[styles.favorite, isCompact && styles.favoriteCompact]}
        />
      </ImageFrame>

      <View style={styles.caption}>
        <View style={styles.nameRow}>
          <Text variant={isCompact ? 'bodyStrong' : 'shopName'} numberOfLines={1} style={styles.name}>
            {shop.name}
          </Text>
          {shop.domainVerified ? <VerifiedMark /> : null}
        </View>
        {category ? (
          <Text variant={isCompact ? 'caption' : 'meta'} tone="secondary" numberOfLines={1}>
            {category}
          </Text>
        ) : null}
      </View>
    </>
  );

  const containerStyle = [styles.card, width != null ? { width } : null, style];

  if (!onPress) {
    return <View style={containerStyle}>{body}</View>;
  }

  return (
    <Pressable
      onPress={() => onPress(shop)}
      accessibilityRole="button"
      accessibilityLabel={category ? `${shop.name}, ${category}` : shop.name}
      style={({ pressed }) => [containerStyle, pressed && styles.pressed]}>
      {body}
    </Pressable>
  );
}

const RATIO: Record<ShopCardVariant, 'portrait' | 'feature' | 'square'> = {
  standard: 'portrait',
  featured: 'feature',
  compact: 'square',
};

const styles = StyleSheet.create({
  card: {
    gap: spacing.sm,
  },
  pressed: {
    opacity: 0.85,
  },
  favorite: {
    position: 'absolute',
    top: spacing.xs,
    right: spacing.xs,
  },
  favoriteCompact: {
    top: spacing.xxs,
    right: spacing.xxs,
  },
  caption: {
    gap: spacing.xxs,
    paddingRight: spacing.xxs,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  name: {
    flexShrink: 1,
  },
});

/** Width that shows ~1.7 standard cards, so the row reads as scrollable. */
export function standardCardWidth(screenWidth: number, gap: number): number {
  return Math.round((screenWidth - layout.screenPadding + gap) / 1.7 - gap);
}

/** Featured card fills most of the width while letting the next one peek. */
export function featuredCardWidth(screenWidth: number): number {
  return Math.round(screenWidth - layout.screenPadding * 2 - spacing.xl);
}
