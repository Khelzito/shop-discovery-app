import { Text as RNText, StyleSheet, type TextProps as RNTextProps } from 'react-native';

import { colors, typography, type TypographyVariant } from '@/theme';

/** Text colors available to screens. Errors use `danger`. */
export type TextTone = 'primary' | 'secondary' | 'tertiary' | 'inverse' | 'danger';

const TONE_COLOR: Record<TextTone, string> = {
  primary: colors.textPrimary,
  secondary: colors.textSecondary,
  tertiary: colors.textTertiary,
  inverse: colors.textInverse,
  danger: colors.danger,
};

export type TextProps = RNTextProps & {
  /** A variant from the typography scale. Defaults to `body`. */
  variant?: TypographyVariant;
  /** Semantic color. Defaults to `primary`. */
  tone?: TextTone;
  /** Convenience alignment, avoids a one-off StyleSheet in screens. */
  align?: 'auto' | 'left' | 'right' | 'center';
};

/**
 * The only text component in the app.
 *
 * Font size, weight and color always come from tokens, so no screen should
 * ever pass a raw `fontSize` or `color` through `style`.
 */
export function Text({ variant = 'body', tone = 'primary', align, style, ...rest }: TextProps) {
  return (
    <RNText
      style={[typography[variant], { color: TONE_COLOR[tone] }, align ? { textAlign: align } : null, style]}
      {...rest}
    />
  );
}

/** Shared styles a few primitives reuse. */
export const textStyles = StyleSheet.create({
  singleLine: {
    flexShrink: 1,
  },
});
