import { router } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Screen, SearchField, Section, ShopCardSkeleton, Text } from '@/components/ui';
import { layout, spacing } from '@/theme';

/**
 * Home shell — structure only.
 *
 * The three discovery sections (Pour toi, Pépites cachées, Nouveautés) render
 * their loading state until real shop data arrives in a later phase.
 */
export default function HomeScreen() {
  return (
    <Screen scroll>
      <View style={styles.header}>
        <Text variant="title">Shop Discovery</Text>
        <Text variant="meta" tone="secondary">
          Des boutiques qui méritent d’être connues.
        </Text>
      </View>

      <SearchField value="" onChangeText={() => {}} readOnlyPress={() => router.push('/explore')} />

      <View style={styles.sections}>
        <Section title="Pour toi">
          <ShopCardRowPlaceholder />
        </Section>

        <Section title="Pépites cachées">
          <ShopCardRowPlaceholder />
        </Section>

        <Section title="Nouveautés">
          <ShopCardRowPlaceholder />
        </Section>
      </View>
    </Screen>
  );
}

const CARD_WIDTH = 176;

function ShopCardRowPlaceholder() {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      // Cancel the screen gutter so cards can bleed to the edge while scrolling.
      style={styles.rowBleed}>
      {[0, 1, 2].map((index) => (
        <ShopCardSkeleton key={index} width={CARD_WIDTH} />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  header: {
    gap: spacing.xxs,
    marginBottom: spacing.lg,
  },
  sections: {
    gap: layout.sectionGap,
    marginTop: layout.sectionGap,
  },
  rowBleed: {
    marginHorizontal: -layout.screenPadding,
  },
  row: {
    gap: spacing.sm,
    paddingHorizontal: layout.screenPadding,
  },
});
