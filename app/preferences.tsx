import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Chip, IconButton, Screen, Section, Text } from '@/components/ui';
import { EXPLORE_CATEGORIES } from '@/data/explore-categories';
import { countryLabel } from '@/lib/format';
import { usePreferences } from '@/state/preferences';
import { layout, spacing } from '@/theme';

/**
 * Préférences — what the user is into, and where they want to be delivered.
 *
 * Interests reuse the Explorer categories rather than a parallel list, so a
 * preference and a browse filter mean the same thing. Nothing is persisted
 * yet; see `state/preferences.tsx`.
 */
export default function PreferencesScreen() {
  const { isInterested, toggleInterest, deliveryCountry } = usePreferences();

  return (
    <Screen scroll>
      <IconButton
        icon="back"
        variant="bare"
        onPress={() => router.back()}
        accessibilityLabel="Retour"
        style={styles.back}
      />

      <Text variant="title">Préférences</Text>

      <View style={styles.sections}>
        <Section title="Centres d’intérêt">
          <View style={styles.chips}>
            {EXPLORE_CATEGORIES.map((category) => (
              <Chip
                key={category.id}
                label={category.label}
                selected={isInterested(category.id)}
                onPress={() => toggleInterest(category.id)}
              />
            ))}
          </View>
        </Section>

        <Section title="Pays de livraison préféré">
          <Text variant="body">{countryLabel(deliveryCountry)}</Text>
        </Section>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  back: {
    marginBottom: spacing.lg,
  },
  sections: {
    gap: layout.sectionGap,
    marginTop: layout.sectionGap,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
});
