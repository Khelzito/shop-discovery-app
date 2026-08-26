import { useRef } from 'react';
import { Animated, Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { colors, layout, radii } from '@/theme';

export type FavoriteButtonProps = {
  active: boolean;
  onPress: () => void;
  /** Name of the thing being favorited, used to build the a11y label. */
  label: string;
  size?: 'sm' | 'md';
  style?: StyleProp<ViewStyle>;
};

const CHIP_SIZE = { sm: 28, md: 34 } as const;

/**
 * Heart control that floats over a photograph.
 *
 * State is carried by the chip's fill as well as the icon color, so the
 * on/off distinction never rests on color alone, and the control keeps its
 * contrast over a light or a dark image. The press micro-interaction is a
 * small spring: the one animation the design system asks to be noticeable,
 * and still barely so.
 */
export function FavoriteButton({
  active,
  onPress,
  label,
  size = 'md',
  style,
}: FavoriteButtonProps) {
  const scale = useRef(new Animated.Value(1)).current;

  const springTo = (toValue: number) => {
    Animated.spring(scale, {
      toValue,
      useNativeDriver: true,
      speed: 40,
      bounciness: 8,
    }).start();
  };

  const dimension = CHIP_SIZE[size];

  return (
    <Pressable
      onPress={() => {
        springTo(1);
        onPress();
      }}
      onPressIn={() => springTo(0.88)}
      onPressOut={() => springTo(1)}
      hitSlop={layout.hitSlop}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={
        active ? `Retirer ${label} des favoris` : `Ajouter ${label} aux favoris`
      }
      style={style}>
      <Animated.View
        style={[
          styles.chip,
          { width: dimension, height: dimension, transform: [{ scale }] },
          active ? styles.chipActive : styles.chipResting,
        ]}>
        <Icon
          name="favorite"
          size={size === 'sm' ? 14 : 16}
          color={active ? colors.textInverse : colors.textPrimary}
        />
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.pill,
  },
  chipResting: {
    backgroundColor: colors.overlayChip,
  },
  chipActive: {
    backgroundColor: colors.actionPrimary,
  },
});
