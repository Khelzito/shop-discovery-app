import { Pressable, StyleSheet, View } from 'react-native';

import { ImageFrame } from '@/components/ui/image-frame';
import { Text } from '@/components/ui/text';
import { colors, radii, spacing } from '@/theme';
import type { Inspiration } from '@/types/inspiration';

export type InspirationCardProps = {
  inspiration: Inspiration;
  width: number;
  onPress?: (inspiration: Inspiration) => void;
};

/**
 * Editorial entry point into a discovery theme.
 *
 * The photograph carries the meaning and the title sits on it — no
 * description, no badge, no call to action. A flat scrim (not a gradient)
 * keeps the label legible whatever the image behind it.
 */
export function InspirationCard({ inspiration, width, onPress }: InspirationCardProps) {
  const card = (
    <ImageFrame
      name={inspiration.title}
      source={inspiration.image}
      ratio="landscape"
      width={width}
      radius="image">
      <View style={styles.scrim} />
      <View style={styles.caption}>
        <Text variant="shopName" tone="inverse" numberOfLines={2}>
          {inspiration.title}
        </Text>
      </View>
    </ImageFrame>
  );

  if (!onPress) {
    return card;
  }

  return (
    <Pressable
      onPress={() => onPress(inspiration)}
      accessibilityRole="button"
      accessibilityLabel={inspiration.title}
      style={({ pressed }) => (pressed ? styles.pressed : undefined)}>
      {card}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.scrimStrong,
    borderRadius: radii.image,
  },
  caption: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    bottom: spacing.md,
  },
  pressed: {
    opacity: 0.85,
  },
});
