import { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';

import { Icon } from '@/components/ui/icon';
import { colors, layout, radii, spacing, typography } from '@/theme';

export type SearchFieldProps = Omit<TextInputProps, 'style' | 'value' | 'onChangeText'> & {
  value: string;
  onChangeText: (value: string) => void;
  /** Called when the clear control is pressed. Defaults to clearing the value. */
  onClear?: () => void;
  placeholder?: string;
  /**
   * Renders a non-editable field that behaves like a button. Used on Home,
   * where tapping the field opens the real search screen.
   */
  readOnlyPress?: () => void;
  style?: StyleProp<ViewStyle>;
};

/**
 * The signature search control: large, quiet, no decorative AI iconography.
 * The intelligence of search stays implicit.
 */
export function SearchField({
  value,
  onChangeText,
  onClear,
  placeholder = "Qu'est-ce que tu cherches ?",
  readOnlyPress,
  style,
  ...rest
}: SearchFieldProps) {
  const [focused, setFocused] = useState(false);
  const showClear = value.length > 0 && !readOnlyPress;

  const field = (
    <View style={[styles.container, focused && styles.containerFocused, style]}>
      <Icon name="search" size="md" color={colors.iconMuted} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textSecondary}
        style={styles.input}
        editable={!readOnlyPress}
        pointerEvents={readOnlyPress ? 'none' : 'auto'}
        returnKeyType="search"
        autoCorrect={false}
        autoCapitalize="none"
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        {...rest}
      />
      {showClear ? (
        <Pressable
          onPress={() => (onClear ? onClear() : onChangeText(''))}
          hitSlop={layout.hitSlop}
          accessibilityRole="button"
          accessibilityLabel="Effacer la recherche">
          <Icon name="clear" size="md" color={colors.iconMuted} />
        </Pressable>
      ) : null}
    </View>
  );

  if (readOnlyPress) {
    return (
      <Pressable
        onPress={readOnlyPress}
        accessibilityRole="search"
        accessibilityLabel={placeholder}
        style={styles.pressWrapper}>
        {field}
      </Pressable>
    );
  }

  return field;
}

const styles = StyleSheet.create({
  pressWrapper: {
    alignSelf: 'stretch',
  },
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: layout.searchFieldHeight,
    paddingHorizontal: spacing.md,
    borderRadius: radii.lg,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: layout.borderWidth,
    borderColor: 'transparent',
  },
  containerFocused: {
    backgroundColor: colors.surface,
    borderColor: colors.borderStrong,
  },
  input: {
    flex: 1,
    padding: 0,
    ...typography.body,
    color: colors.textPrimary,
  },
});
