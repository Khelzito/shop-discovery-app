import { ScrollView, StyleSheet } from 'react-native';

import { Chip } from '@/components/ui/chip';
import type { CategoryOption } from '@/data/shops';
import { layout, spacing } from '@/theme';

export type CategoryFilterProps = {
  /** Active categories from the catalogue. Empty while they load. */
  categories: readonly CategoryOption[];
  /** Slug of the active category, or `null` for no filter. */
  selected: string | null;
  onSelect: (categorySlug: string | null) => void;
};

/**
 * Lightweight horizontal category selector.
 *
 * Text-only chips on purpose: the icon family has no honest glyph for several
 * of these, and forcing one would add noise to a control that must stay
 * secondary to search and to the photography below it.
 */
export function CategoryFilter({ categories, selected, onSelect }: CategoryFilterProps) {
  if (categories.length === 0) {
    return null;
  }

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.bleed}
      contentContainerStyle={styles.content}
      accessibilityLabel="Catégories">
      {categories.map((category) => (
        <Chip
          key={category.id}
          label={category.name}
          selected={selected === category.slug}
          // Tapping the active chip clears the filter.
          onPress={() => onSelect(selected === category.slug ? null : category.slug)}
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
