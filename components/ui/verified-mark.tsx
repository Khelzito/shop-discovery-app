import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { colors, radii, spacing } from '@/theme';

export type VerifiedMarkProps = {
  /** `mark` sits next to a shop name; `badge` adds a label for trust sections. */
  variant?: 'mark' | 'badge';
  label?: string;
  style?: StyleProp<ViewStyle>;
};

const DEFAULT_LABEL = 'Boutique vérifiée';

/**
 * A deliberately subtle trust indicator. Verification is earned server-side
 * and never purchased, so the mark stays quiet rather than promotional
 * (docs/MASTER_SPEC.md §11). Meaning is never carried by color alone: the
 * mark always exposes an accessibility label.
 */
export function VerifiedMark({ variant = 'mark', label = DEFAULT_LABEL, style }: VerifiedMarkProps) {
  if (variant === 'badge') {
    return (
      <View
        accessible
        accessibilityLabel={label}
        style={[styles.badge, style]}>
        <Icon name="verified" size={12} color={colors.textSecondary} />
        <Text variant="caption" tone="secondary">
          {label}
        </Text>
      </View>
    );
  }

  return (
    <View accessible accessibilityLabel={label} style={[styles.mark, style]}>
      <Icon name="verified" size={10} color={colors.textInverse} />
    </View>
  );
}

const styles = StyleSheet.create({
  mark: {
    width: 16,
    height: 16,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.textPrimary,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xxs,
    alignSelf: 'flex-start',
    paddingVertical: spacing.xxs,
    paddingHorizontal: spacing.xs,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceSecondary,
  },
});
