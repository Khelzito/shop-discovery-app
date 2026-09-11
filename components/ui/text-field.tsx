import { useState } from 'react';
import { StyleSheet, TextInput, View, type TextInputProps } from 'react-native';

import { Text } from '@/components/ui/text';
import { colors, layout, radii, spacing, typography } from '@/theme';

export type TextFieldProps = Omit<TextInputProps, 'style' | 'placeholderTextColor'> & {
  label: string;
  /** Discreet line under the field, e.g. where a value came from. */
  hint?: string | null;
  /** Shown under the field in the danger tone; also exposed to accessibility. */
  error?: string | null;
  /** Right-aligned next to the label, e.g. `42/280`. */
  counter?: string;
};

/**
 * Labelled text input for forms.
 *
 * Shares the search field's quiet treatment — filled, borderless at rest, a
 * hairline outline on focus — so forms feel like the rest of the app rather
 * than a system dialog.
 */
export function TextField({ label, hint, error, counter, multiline, onFocus, onBlur, ...rest }: TextFieldProps) {
  const [focused, setFocused] = useState(false);

  return (
    <View style={styles.field}>
      <View style={styles.header}>
        <Text variant="meta" tone="secondary">
          {label}
        </Text>
        {counter ? (
          <Text variant="caption" tone="tertiary">
            {counter}
          </Text>
        ) : null}
      </View>
      <TextInput
        style={[
          styles.input,
          multiline && styles.multiline,
          focused && styles.inputFocused,
          error ? styles.inputError : null,
        ]}
        placeholderTextColor={colors.textTertiary}
        multiline={multiline}
        accessibilityLabel={label}
        accessibilityHint={error ?? undefined}
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
      {error ? (
        <Text variant="meta" tone="danger">
          {error}
        </Text>
      ) : hint ? (
        <Text variant="caption" tone="tertiary">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    gap: spacing.xs,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: spacing.sm,
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
  multiline: {
    height: undefined,
    minHeight: 112,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    textAlignVertical: 'top',
  },
  inputFocused: {
    backgroundColor: colors.surface,
    borderColor: colors.borderStrong,
  },
  inputError: {
    borderColor: colors.dangerBorder,
  },
});
