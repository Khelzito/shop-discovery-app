import { Pressable, StyleSheet, View } from 'react-native';

import { Icon, type IconName } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { colors, layout, spacing } from '@/theme';

export type ListRowProps = {
  icon: IconName;
  label: string;
  onPress?: () => void;
  /** Hairline under the row. Set on every row of a group except the last. */
  separator?: boolean;
};

/**
 * A plain navigation row: icon, label, chevron.
 *
 * No card, no surface, no shadow — the row is the divider-and-text pattern
 * the design system asks for, so a group of these reads as a quiet list
 * rather than a settings dashboard.
 */
export function ListRow({ icon, label, onPress, separator = false }: ListRowProps) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.row, separator && styles.separator, pressed && styles.pressed]}>
      <Icon name={icon} size="md" color={colors.iconMuted} />
      <Text variant="body" style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      <Icon name="chevronRight" size="md" color={colors.textTertiary} />
    </Pressable>
  );
}

/** Groups rows and applies the separator to all but the last. */
export function ListRowGroup({ rows }: { rows: readonly Omit<ListRowProps, 'separator'>[] }) {
  return (
    <View>
      {rows.map((row, index) => (
        <ListRow key={row.label} {...row} separator={index < rows.length - 1} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: layout.minTouchTarget,
    paddingVertical: spacing.md,
  },
  separator: {
    borderBottomWidth: layout.hairline,
    borderBottomColor: colors.border,
  },
  pressed: {
    opacity: 0.5,
  },
  label: {
    flex: 1,
  },
});
