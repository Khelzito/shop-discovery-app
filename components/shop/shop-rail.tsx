import { ScrollView, StyleSheet } from 'react-native';

import { ShopCard, type ShopCardVariant } from '@/components/shop/shop-card';
import { layout, spacing } from '@/theme';
import type { Shop } from '@/types/shop';

export type ShopRailProps = {
  shops: readonly Shop[];
  variant: ShopCardVariant;
  itemWidth: number;
  /** Snap each card to the gutter. Off for lighter, free-scrolling rows. */
  snap?: boolean;
  isFavorite: (shopId: string) => boolean;
  onToggleFavorite: (shopId: string) => void;
  onPressShop?: (shop: Shop) => void;
  accessibilityLabel: string;
};

const GAP = spacing.sm;

/**
 * Horizontal row of shop cards.
 *
 * The row bleeds past the screen gutter so cards run to the edge while
 * scrolling, but the first card still lines up with the section title.
 */
export function ShopRail({
  shops,
  variant,
  itemWidth,
  snap = false,
  isFavorite,
  onToggleFavorite,
  onPressShop,
  accessibilityLabel,
}: ShopRailProps) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.bleed}
      contentContainerStyle={styles.content}
      accessibilityLabel={accessibilityLabel}
      decelerationRate={snap ? 'fast' : 'normal'}
      snapToInterval={snap ? itemWidth + GAP : undefined}
      snapToAlignment="start">
      {shops.map((shop) => (
        <ShopCard
          key={shop.id}
          shop={shop}
          variant={variant}
          width={itemWidth}
          favorite={isFavorite(shop.id)}
          onToggleFavorite={onToggleFavorite}
          onPress={onPressShop}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  bleed: {
    marginHorizontal: -layout.screenPadding,
  },
  content: {
    gap: GAP,
    paddingHorizontal: layout.screenPadding,
  },
});
