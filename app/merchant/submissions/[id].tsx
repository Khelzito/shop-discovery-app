import { router, useLocalSearchParams } from 'expo-router';
import { useCallback } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { BackButton, MerchantAuthGate, Notice } from '@/components/merchant';
import { Button, EmptyState, Screen, Text } from '@/components/ui';
import { getMySubmission } from '@/lib/api/merchant';
import { uuidParam } from '@/lib/merchant/routes';
import { SUBMISSION_ACTION_LABELS, submissionStatusView, submissionTitle } from '@/lib/merchant/submissions';
import { useFocusResource } from '@/lib/use-focus-resource';
import { colors, layout, spacing } from '@/theme';

/**
 * One request, as its merchant sees it: where it stands, the reviewer's note
 * when it is meant for them, and the one action that makes sense.
 */
export default function MerchantSubmissionScreen() {
  return (
    <MerchantAuthGate>
      <SubmissionContent />
    </MerchantAuthGate>
  );
}

function SubmissionContent() {
  const params = useLocalSearchParams<{ id?: string }>();
  const id = uuidParam(params.id);
  const load = useCallback(async () => (id ? getMySubmission(id) : null), [id]);
  const resource = useFocusResource(load);

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

  const summary = resource.data;
  const view = summary ? submissionStatusView(summary.status) : null;
  if (!summary || !view) {
    return (
      <Screen center>
        <EmptyState
          title="Demande introuvable"
          description="Cette demande n’existe pas ou n’est plus disponible."
          actionLabel="Retour au profil"
          onActionPress={() => router.dismissTo('/profile')}
        />
      </Screen>
    );
  }

  const shopId = summary.shopId;

  return (
    <Screen scroll>
      <BackButton />

      <Text variant="title">{submissionTitle(summary)}</Text>
      {summary.proposedName && summary.host ? (
        <Text variant="meta" tone="secondary" style={styles.host}>
          {summary.host}
        </Text>
      ) : null}

      <View style={styles.status}>
        <Text variant="sectionTitle">{view.label}</Text>
        <Text variant="body" tone="secondary">
          {view.description}
        </Text>
      </View>

      {view.showNote && summary.reviewNote ? (
        <View style={styles.section}>
          <Notice>{`Note de l’équipe : ${summary.reviewNote}`}</Notice>
        </View>
      ) : null}

      {view.action === 'edit' ? (
        <Button
          label={SUBMISSION_ACTION_LABELS.edit}
          size="lg"
          fullWidth
          style={styles.action}
          onPress={() => router.push({ pathname: '/merchant/review', params: { submissionId: summary.id } })}
        />
      ) : null}

      {view.action === 'manage' && shopId ? (
        <Button
          label={SUBMISSION_ACTION_LABELS.manage}
          size="lg"
          fullWidth
          style={styles.action}
          onPress={() => router.push({ pathname: '/merchant/shop/[shopId]', params: { shopId } })}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  host: {
    marginTop: spacing.xxs,
  },
  status: {
    gap: spacing.xs,
    marginTop: layout.sectionGap,
  },
  section: {
    marginTop: spacing.xl,
  },
  action: {
    marginTop: layout.sectionGap,
  },
});
