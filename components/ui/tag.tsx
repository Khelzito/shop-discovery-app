import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { colors, radii, spacing } from '@/theme';

/**
 * A quiet, non-interactive descriptor. Tags situate a shop; they are not
 * filters and must never read as buttons.
 */
export function Tag({ label }: { label: string }) {
  return (
    <View style={styles.tag}>
      <Text variant="caption" tone="secondary" numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tag: {
    paddingVertical: spacing.xxs,
    paddingHorizontal: spacing.xs,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceSecondary,
  },
});
