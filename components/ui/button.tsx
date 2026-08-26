import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { Icon, type IconName } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { colors, layout, radii, spacing } from '@/theme';

/**
 * `primary`  — one dominant dark action per section (e.g. `Visiter`).
 * `secondary`— quiet outlined control, used sparingly.
 * `text`     — the default for secondary actions such as `Voir tout`.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'text';
export type ButtonSize = 'sm' | 'md' | 'lg';

export type ButtonProps = Omit<PressableProps, 'style' | 'children'> & {
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Trailing icon, e.g. `external` for an outbound CTA. */
  iconRight?: IconName;
  iconLeft?: IconName;
  loading?: boolean;
  /** Stretch to the container width. */
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function Button({
  label,
  variant = 'primary',
  size = 'md',
  iconRight,
  iconLeft,
  loading = false,
  fullWidth = false,
  disabled,
  style,
  ...rest
}: ButtonProps) {
  const isDisabled = disabled === true || loading;
  const isText = variant === 'text';

  const contentColor = resolveContentColor(variant, isDisabled);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      hitSlop={isText ? layout.hitSlop : undefined}
      style={({ pressed }) => [
        styles.base,
        !isText && styles.block,
        !isText && { height: layout.controlHeight[size] },
        variantStyle(variant, isDisabled, pressed),
        fullWidth && styles.fullWidth,
        style,
      ]}
      {...rest}>
      <View style={styles.content}>
        {loading ? (
          <ActivityIndicator size="small" color={contentColor} />
        ) : (
          <>
            {iconLeft ? <Icon name={iconLeft} size="sm" color={contentColor} /> : null}
            <Text variant={isText ? 'label' : 'button'} style={{ color: contentColor }}>
              {label}
            </Text>
            {iconRight ? <Icon name={iconRight} size="sm" color={contentColor} /> : null}
          </>
        )}
      </View>
    </Pressable>
  );
}

function resolveContentColor(variant: ButtonVariant, isDisabled: boolean): string {
  if (isDisabled) {
    return colors.actionDisabledText;
  }
  return variant === 'primary' ? colors.actionPrimaryText : colors.textPrimary;
}

function variantStyle(variant: ButtonVariant, isDisabled: boolean, pressed: boolean): ViewStyle {
  if (variant === 'primary') {
    if (isDisabled) {
      return { backgroundColor: colors.actionDisabled };
    }
    return { backgroundColor: pressed ? colors.actionPrimaryPressed : colors.actionPrimary };
  }

  if (variant === 'secondary') {
    return {
      backgroundColor: pressed ? colors.surfacePressed : colors.surface,
      borderWidth: layout.borderWidth,
      borderColor: colors.border,
    };
  }

  return { opacity: pressed ? 0.5 : 1 };
}

const styles = StyleSheet.create({
  base: {
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radii.md,
  },
  block: {
    paddingHorizontal: spacing.lg,
  },
  fullWidth: {
    alignSelf: 'stretch',
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
});
