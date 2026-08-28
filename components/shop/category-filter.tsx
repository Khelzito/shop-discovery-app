import { ScrollView, StyleSheet } from 'react-native';

import { Chip } from '@/components/ui/chip';
import { EXPLORE_CATEGORIES } from '@/data/explore-categories';
import { layout, spacing } from '@/theme';

export type CategoryFilterProps = {
  /** `null` means no category is active. */
  selected: string | null;
  onSelect: (categoryId: string | null) => void;
};

/**
 * Lightweight horizontal category selector.
 *
 * Text-only chips on purpose: the icon family has no honest glyph for several
 * of these, and forcing one would add noise to a control that must stay
 * secondary to search and to the photography below it.
 */
export function CategoryFilter({ selected, onSelect }: CategoryFilterProps) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.bleed}
      contentContainerStyle={styles.content}
      accessibilityLabel="Catégories">
      {EXPLORE_CATEGORIES.map((category) => (
        <Chip
          key={category.id}
          label={category.label}
          selected={selected === category.id}
          // Tapping the active chip clears the filter.
          onPress={() => onSelect(selected === category.id ? null : category.id)}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  bleed: {
    marginHorizontal: -layout.screenPadding,
    flexGrow: 0,
  },
  content: {
    gap: spacing.xs,
    paddingHorizontal: layout.screenPadding,
  },
});
