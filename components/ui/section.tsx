import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { layout, spacing } from '@/theme';

export type SectionProps = {
  title: string;
  /** Optional one-line context under the title. Use only when it adds value. */
  subtitle?: string;
  /** Secondary text action, typically `Voir tout`. */
  actionLabel?: string;
  onActionPress?: () => void;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
};

/**
 * A titled block of discovery content ("Pour toi", "Pépites cachées", "Nouveautés").
 * Owns its own vertical rhythm so screens do not re-invent spacing.
 */
export function Section({
  title,
  subtitle,
  actionLabel,
  onActionPress,
  children,
  style,
}: SectionProps) {
  return (
    <View style={[styles.section, style]}>
      <View style={styles.header}>
        <View style={styles.headings}>
          <Text variant="sectionTitle" accessibilityRole="header">
            {title}
          </Text>
          {subtitle ? (
            <Text variant="meta" tone="secondary">
              {subtitle}
            </Text>
          ) : null}
        </View>
        {actionLabel && onActionPress ? (
          <Button variant="text" label={actionLabel} onPress={onActionPress} />
        ) : null}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: layout.sectionHeaderGap,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  headings: {
    flexShrink: 1,
    gap: spacing.xxs,
  },
});
