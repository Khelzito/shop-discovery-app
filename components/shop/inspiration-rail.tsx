import { ScrollView, StyleSheet } from 'react-native';

import { InspirationCard } from '@/components/shop/inspiration-card';
import { layout, spacing } from '@/theme';
import type { Inspiration } from '@/types/inspiration';

const GAP = spacing.sm;

export type InspirationRailProps = {
  inspirations: readonly Inspiration[];
  itemWidth: number;
  onPressInspiration?: (inspiration: Inspiration) => void;
};

/** Horizontal row of editorial themes, bleeding past the screen gutter. */
export function InspirationRail({
  inspirations,
  itemWidth,
  onPressInspiration,
}: InspirationRailProps) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.bleed}
      contentContainerStyle={styles.content}
      decelerationRate="fast"
      snapToInterval={itemWidth + GAP}
      snapToAlignment="start"
      accessibilityLabel="Inspirations">
      {inspirations.map((inspiration) => (
        <InspirationCard
          key={inspiration.id}
          inspiration={inspiration}
          width={itemWidth}
          onPress={onPressInspiration}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  bleed: {
    marginHorizontal: -layout.screenPadding,
  },
  content: {
    gap: GAP,
    paddingHorizontal: layout.screenPadding,
  },
});
