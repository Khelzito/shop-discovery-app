import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { FavoriteButton } from '@/components/ui/favorite-button';
import { ImageFrame } from '@/components/ui/image-frame';
import { Text } from '@/components/ui/text';
import { VerifiedMark } from '@/components/ui/verified-mark';
import { shopMetaLine } from '@/lib/format';
import { spacing } from '@/theme';
import type { Shop } from '@/types/shop';

const THUMBNAIL = 84;

export type ShopRowProps = {
  shop: Shop;
  favorite: boolean;
  onToggleFavorite: (shopId: string) => void;
  /** Opens the shop profile. Wired once that route exists. */
  onPress?: (shop: Shop) => void;
  style?: StyleProp<ViewStyle>;
};

/**
 * A shop in a vertical browse list.
 *
 * The horizontal form Explorer uses: image, name, verification mark, one
 * meta line and the favorite control. No description, rating, price,
 * delivery, tag list or visit button — none of it helps a user choose here.
 */
export function ShopRow({ shop, favorite, onToggleFavorite, onPress, style }: ShopRowProps) {
  const body = (
    <>
      <ImageFrame
        name={shop.name}
        source={shop.images.cover}
        ratio="square"
        width={THUMBNAIL}
        radius="md"
      />

      <View style={styles.body}>
        <View style={styles.nameRow}>
          <Text variant="shopName" numberOfLines={1} style={styles.name}>
            {shop.name}
          </Text>
          {shop.domainVerified ? <VerifiedMark /> : null}
        </View>
        <Text variant="meta" tone="secondary" numberOfLines={1}>
          {shopMetaLine(shop)}
        </Text>
      </View>

      <FavoriteButton
        active={favorite}
        onPress={() => onToggleFavorite(shop.id)}
        label={shop.name}
        variant="bare"
      />
    </>
  );

  if (!onPress) {
    return <View style={[styles.row, style]}>{body}</View>;
  }

  return (
    <Pressable
      onPress={() => onPress(shop)}
      accessibilityRole="button"
      accessibilityLabel={`${shop.name}, ${shopMetaLine(shop)}`}
      style={({ pressed }) => [styles.row, pressed && styles.pressed, style]}>
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  pressed: {
    opacity: 0.85,
  },
  body: {
    flex: 1,
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
});
