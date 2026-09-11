import { router } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { BackButton, StatusRow } from '@/components/merchant';
import { EmptyState, Screen, Text } from '@/components/ui';
import { listSubmissionsForModeration } from '@/lib/api/moderation';
import { formatClaimDate } from '@/lib/merchant/claim';
import type { ModerationListItem } from '@/lib/merchant/moderation';
import { useFocusResource } from '@/lib/use-focus-resource';
import { colors, layout, spacing } from '@/theme';

/** The queue: requests to review, oldest first, and those waiting on their merchant. */
export default function ModerationListScreen() {
  const resource = useFocusResource(listSubmissionsForModeration);

  if (resource.status === 'loading') {
    return (
      <Screen center>
        <ActivityIndicator color={colors.textSecondary} />
      </Screen>
    );
  }

  if (resource.status === 'error') {
    return (
      <Screen center>
        <EmptyState
          tone="error"
          title="Chargement impossible"
          description="Vérifiez votre connexion puis réessayez."
          actionLabel="Réessayer"
          onActionPress={resource.reload}
        />
      </Screen>
    );
  }

  const { toReview, awaitingMerchant } = resource.data;

  return (
    <Screen scroll>
      <BackButton />
      <Text variant="title">Modération</Text>

      <Section title="À examiner" items={toReview} empty="Aucune demande à examiner." />
      <Section title="En attente du marchand" items={awaitingMerchant} empty="Aucune demande en attente." />
    </Screen>
  );
}

function Section({ title, items, empty }: { title: string; items: readonly ModerationListItem[]; empty: string }) {
  return (
    <View style={styles.section}>
      <Text variant="sectionTitle">{title}</Text>
      {items.length === 0 ? (
        <Text variant="meta" tone="tertiary">
          {empty}
        </Text>
      ) : (
        <View>
          {items.map((item, index) => (
            <StatusRow
              key={item.id}
              title={item.proposedName ?? item.host ?? 'Demande'}
              meta={[item.proposedName ? item.host : null, formatClaimDate(item.updatedAt)].filter(Boolean).join(' · ')}
              separator={index < items.length - 1}
              onPress={() => router.push({ pathname: '/admin/submissions/[id]', params: { id: item.id } })}
            />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: spacing.xs,
    marginTop: layout.sectionGap,
  },
});
