import { useState } from 'react';
import { StyleSheet, TextInput, View, type TextInputProps } from 'react-native';

import { Text } from '@/components/ui/text';
import { colors, layout, radii, spacing, typography } from '@/theme';

export type TextFieldProps = Omit<TextInputProps, 'style' | 'placeholderTextColor'> & {
  label: string;
};

/**
 * Labelled text input for forms.
 *
 * Shares the search field's quiet treatment — filled, borderless at rest, a
 * hairline outline on focus — so forms feel like the rest of the app rather
 * than a system dialog.
 */
export function TextField({ label, onFocus, onBlur, ...rest }: TextFieldProps) {
  const [focused, setFocused] = useState(false);

  return (
    <View style={styles.field}>
      <Text variant="meta" tone="secondary">
        {label}
      </Text>
      <TextInput
        style={[styles.input, focused && styles.inputFocused]}
        placeholderTextColor={colors.textTertiary}
        onFocus={(event) => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          onBlur?.(event);
        }}
        {...rest}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    gap: spacing.xs,
  },
  input: {
    height: layout.controlHeight.md,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: layout.borderWidth,
    borderColor: 'transparent',
    ...typography.body,
    color: colors.textPrimary,
  },
  inputFocused: {
    backgroundColor: colors.surface,
    borderColor: colors.borderStrong,
  },
});
