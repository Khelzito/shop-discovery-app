import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';

import { SHOP_REPORT_DESCRIPTION_MAX, SHOP_REPORT_REASONS, type ShopReportReason } from '@/ai/contracts/merchant-trust';
import { BackButton, ChoiceChips, FieldBlock } from '@/components/merchant';
import { Button, EmptyState, Icon, Screen, Text, TextField } from '@/components/ui';
import { reportShop } from '@/lib/api/reports';
import { REPORT_MESSAGES, REPORT_REASON_LABELS, validateReport, type ReportOutcome } from '@/lib/merchant/report';
import { uuidParam } from '@/lib/merchant/routes';
import { singleFlight } from '@/lib/merchant/submit';
import { useAuth } from '@/state/auth';
import { colors, layout, radii, spacing } from '@/theme';

const REASON_OPTIONS = SHOP_REPORT_REASONS.map((reason) => ({ value: reason, label: REPORT_REASON_LABELS[reason] }));

/**
 * "Signaler cette boutique" — a private message to the moderation team.
 * Never public, never a score, never an automatic suspension.
 */
export default function ReportShopScreen() {
  const params = useLocalSearchParams<{ shopId?: string }>();
  const shopId = uuidParam(params.shopId);
  const { status } = useAuth();

  if (status === 'loading') {
    return (
      <Screen center>
        <ActivityIndicator color={colors.textSecondary} />
      </Screen>
    );
  }

  if (!shopId) {
    return (
      <Screen center>
        <EmptyState title="Boutique introuvable" actionLabel="Retour" onActionPress={() => router.back()} />
      </Screen>
    );
  }

  if (status === 'signedOut') {
    return (
      <Screen center>
        <EmptyState
          icon="flag"
          title="Connectez-vous pour signaler une boutique"
          description="Un signalement est rattaché à votre compte et reste privé."
          actionLabel="Se connecter"
          onActionPress={() => router.push('/sign-in')}
        />
      </Screen>
    );
  }

  return <ReportForm shopId={shopId} />;
}

function ReportForm({ shopId }: { shopId: string }) {
  const [reason, setReason] = useState<ShopReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<'sent' | 'already_reported' | null>(null);
  /** One report at a time: a double tap sends once. */
  const [runOnce] = useState(() => singleFlight<ReportOutcome>());

  const send = async () => {
    const checked = validateReport(shopId, reason, details);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    const pending = runOnce(() => reportShop(checked.insert));
    if (pending === null) {
      return;
    }
    setSending(true);
    setError(null);
    const outcome = await pending.catch((): ReportOutcome => 'failed');
    setSending(false);
    if (outcome === 'sent' || outcome === 'already_reported') {
      setDone(outcome);
    } else {
      setError(REPORT_MESSAGES[outcome]);
    }
  };

  if (done) {
    return (
      <Screen center>
        <View style={styles.done}>
          <View style={styles.check}>
            <Icon name="check" size="lg" color={colors.icon} />
          </View>
          <Text variant="sectionTitle" align="center" accessibilityRole="header">
            Signalement envoyé
          </Text>
          <Text variant="body" tone="secondary" align="center">
            {REPORT_MESSAGES[done]}
          </Text>
          <Button label="Retour" size="lg" fullWidth onPress={() => router.back()} style={styles.doneAction} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <BackButton />

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Text variant="title">Signaler cette boutique</Text>
        <Text variant="body" tone="secondary" style={styles.subtitle}>
          Votre signalement reste privé. Notre équipe l’examine avant toute décision.
        </Text>

        <View style={styles.form}>
          <FieldBlock label="Motif">
            <ChoiceChips<ShopReportReason>
              options={REASON_OPTIONS}
              selected={reason ? [reason] : []}
              onToggle={(value) => {
                setReason(reason === value ? null : value);
                setError(null);
              }}
            />
          </FieldBlock>

          <TextField
            label="Précisions"
            value={details}
            onChangeText={(value) => {
              setDetails(value);
              setError(null);
            }}
            multiline
            maxLength={SHOP_REPORT_DESCRIPTION_MAX}
            placeholder={reason === 'other' ? 'Décrivez le problème' : 'Facultatif'}
          />
        </View>

        <View style={styles.footer}>
          {error ? (
            <Text variant="meta" tone="danger" accessibilityRole="alert">
              {error}
            </Text>
          ) : null}
          <Button
            label="Envoyer le signalement"
            size="lg"
            fullWidth
            loading={sending}
            disabled={sending}
            onPress={() => void send()}
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  subtitle: {
    marginTop: spacing.sm,
  },
  form: {
    gap: spacing.xl,
    marginTop: layout.sectionGap,
  },
  footer: {
    gap: spacing.sm,
    marginTop: spacing.huge,
  },
  done: {
    alignSelf: 'stretch',
    alignItems: 'center',
    gap: spacing.sm,
  },
  check: {
    width: layout.controlHeight.lg,
    height: layout.controlHeight.lg,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceSecondary,
    marginBottom: spacing.md,
  },
  doneAction: {
    marginTop: spacing.xxl,
  },
});
