import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { Text } from '@/components/ui/text';
import { colors, layout, radii, spacing } from '@/theme';

export type ChipProps = {
  label: string;
  selected?: boolean;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
};

/**
 * Small selectable filter control.
 *
 * Selection is carried by a filled dark background rather than a tint, so it
 * reads at a glance without introducing an accent color, and never rests on
 * color alone — the accessibility state is exposed too.
 */
export function Chip({ label, selected = false, onPress, style }: ChipProps) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        styles.chip,
        selected ? styles.selected : styles.unselected,
        pressed && !selected && styles.pressed,
        style,
      ]}>
      <Text variant="label" tone={selected ? 'inverse' : 'primary'} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    height: 38,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: layout.borderWidth,
  },
  unselected: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
  },
  pressed: {
    backgroundColor: colors.surfacePressed,
  },
  selected: {
    backgroundColor: colors.actionPrimary,
    borderColor: colors.actionPrimary,
  },
});
