import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Button } from '@/components/ui/button';
import { Icon, type IconName } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { colors, layout, radii, spacing } from '@/theme';

export type EmptyStateProps = {
  title: string;
  /** One or two calm sentences. Offer a way forward, never a dead end. */
  description?: string;
  icon?: IconName;
  actionLabel?: string;
  onActionPress?: () => void;
  /** Error variant keeps the same calm layout with a restrained danger tone. */
  tone?: 'neutral' | 'error';
  style?: StyleProp<ViewStyle>;
};

/**
 * Shared empty / no-result / error presentation.
 * Error states must preserve the calm visual language of the app.
 */
export function EmptyState({
  title,
  description,
  icon,
  actionLabel,
  onActionPress,
  tone = 'neutral',
  style,
}: EmptyStateProps) {
  const isError = tone === 'error';
  const resolvedIcon: IconName | undefined = icon ?? (isError ? 'alert' : undefined);

  return (
    <View accessibilityRole="summary" style={[styles.container, style]}>
      {resolvedIcon ? (
        <View style={[styles.iconWrapper, isError && styles.iconWrapperError]}>
          <Icon
            name={resolvedIcon}
            size="lg"
            color={isError ? colors.danger : colors.iconMuted}
          />
        </View>
      ) : null}

      <View style={styles.copy}>
        <Text variant="shopName" align="center" tone={isError ? 'danger' : 'primary'}>
          {title}
        </Text>
        {description ? (
          <Text variant="body" tone="secondary" align="center">
            {description}
          </Text>
        ) : null}
      </View>

      {actionLabel && onActionPress ? (
        <Button label={actionLabel} onPress={onActionPress} variant="secondary" size="sm" />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.lg,
  },
  iconWrapper: {
    width: layout.controlHeight.md,
    height: layout.controlHeight.md,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceSecondary,
  },
  iconWrapperError: {
    backgroundColor: colors.dangerSurface,
  },
  copy: {
    gap: spacing.xxs,
    maxWidth: 320,
  },
});
