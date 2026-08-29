import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { EmptyState, IconButton, Screen, Text } from '@/components/ui';
import { findHelpTopic } from '@/data/help-topics';
import { layout, spacing } from '@/theme';

/** A single explanatory page from Aide. */
export default function HelpTopicScreen() {
  const { topic: topicId } = useLocalSearchParams<{ topic: string }>();
  const topic = typeof topicId === 'string' ? findHelpTopic(topicId) : undefined;

  if (!topic) {
    return (
      <Screen center>
        <EmptyState
          icon="alert"
          title="Page introuvable"
          actionLabel="Retour"
          onActionPress={() => router.back()}
        />
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <IconButton
        icon="back"
        variant="bare"
        onPress={() => router.back()}
        accessibilityLabel="Retour"
        style={styles.back}
      />

      <Text variant="title">{topic.title}</Text>

      <View style={styles.body}>
        {topic.paragraphs.map((paragraph) => (
          <Text key={paragraph} variant="body">
            {paragraph}
          </Text>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  back: {
    marginBottom: spacing.lg,
  },
  body: {
    gap: spacing.md,
    marginTop: layout.sectionGap,
  },
});
