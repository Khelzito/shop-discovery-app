import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { Icon, type IconName } from '@/components/ui/icon';
import { colors, layout, radii } from '@/theme';

export type IconButtonProps = {
  icon: IconName;
  onPress: () => void;
  accessibilityLabel: string;
  /** `overlay` floats over a photograph; `bare` sits on the page background. */
  variant?: 'overlay' | 'bare';
  size?: 'sm' | 'md';
  style?: StyleProp<ViewStyle>;
};

const CHIP_SIZE = { sm: 28, md: 34 } as const;

/** Circular icon-only control, sized to match the favorite chip. */
export function IconButton({
  icon,
  onPress,
  accessibilityLabel,
  variant = 'overlay',
  size = 'md',
  style,
}: IconButtonProps) {
  const dimension = CHIP_SIZE[size];

  return (
    <Pressable
      onPress={onPress}
      hitSlop={layout.hitSlop}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        styles.chip,
        { width: dimension, height: dimension },
        variant === 'overlay' ? styles.overlay : styles.bare,
        pressed && styles.pressed,
        style,
      ]}>
      <Icon name={icon} size={size === 'sm' ? 14 : 18} color={colors.textPrimary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.pill,
  },
  overlay: {
    backgroundColor: colors.overlayChip,
  },
  bare: {
    backgroundColor: 'transparent',
  },
  pressed: {
    opacity: 0.6,
  },
});
