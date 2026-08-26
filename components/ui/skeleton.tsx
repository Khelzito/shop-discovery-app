import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, radii, spacing } from '@/theme';

export type SkeletonProps = {
  width?: number | `${number}%`;
  height?: number;
  /** Use `image` for media placeholders, `pill` for chips. */
  radius?: keyof typeof radii;
  /** Aspect ratio (width / height). Takes precedence over `height`. */
  ratio?: number;
  style?: StyleProp<ViewStyle>;
};

/**
 * A calm loading placeholder. The pulse is deliberately slow and low
 * contrast: if the animation calls attention to itself, it is too strong.
 */
export function Skeleton({ width = '100%', height = 16, radius = 'sm', ratio, style }: SkeletonProps) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(progress, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(progress, {
          toValue: 0,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [progress]);

  const opacity = progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0.45] });

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.base,
        { borderRadius: radii[radius] },
        ratio ? { width, aspectRatio: ratio } : { width, height },
        { opacity },
        style,
      ]}
    />
  );
}

/** Ready-made skeleton for one shop card: image, name line, meta line. */
export function ShopCardSkeleton({ ratio = 4 / 5, width = '100%' }: { ratio?: number; width?: SkeletonProps['width'] }) {
  return (
    <View style={[styles.card, typeof width === 'number' ? { width } : { alignSelf: 'stretch' }]}>
      <Skeleton ratio={ratio} radius="image" />
      <Skeleton width="70%" height={16} />
      <Skeleton width="45%" height={12} />
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    backgroundColor: colors.skeleton,
  },
  card: {
    gap: spacing.xs,
  },
});
