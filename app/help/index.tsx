import { router } from 'expo-router';
import { Alert, StyleSheet, View } from 'react-native';

import { IconButton, ListRowGroup, Screen, Text } from '@/components/ui';
import { HELP_TOPICS } from '@/data/help-topics';
import { layout, spacing } from '@/theme';

/**
 * Aide — four entries, nothing else.
 *
 * The two explanatory ones open a short page. Reporting and contact have no
 * destination yet: V1 has neither a support address nor a ticketing backend,
 * and inventing either would be worse than saying so.
 */
export default function HelpScreen() {
  const notAvailableYet = (title: string) => {
    Alert.alert(title, 'Cette fonctionnalité arrivera dans une prochaine version.', [
      { text: 'J’ai compris' },
    ]);
  };

  return (
    <Screen scroll>
      <IconButton
        icon="back"
        variant="bare"
        onPress={() => router.back()}
        accessibilityLabel="Retour"
        style={styles.back}
      />

      <Text variant="title">Aide</Text>

      <View style={styles.entries}>
        <ListRowGroup
          rows={[
            ...HELP_TOPICS.map((topic) => ({
              icon: 'info' as const,
              label: topic.title,
              onPress: () =>
                router.push({ pathname: '/help/[topic]', params: { topic: topic.id } }),
            })),
            {
              icon: 'flag' as const,
              label: 'Signaler un problème',
              onPress: () => notAvailableYet('Signaler un problème'),
            },
            {
              icon: 'mail' as const,
              label: 'Nous contacter',
              onPress: () => notAvailableYet('Nous contacter'),
            },
          ]}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  back: {
    marginBottom: spacing.lg,
  },
  entries: {
    marginTop: layout.sectionGap,
  },
});
