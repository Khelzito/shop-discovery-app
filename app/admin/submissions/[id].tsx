import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';

import type { Audience } from '@/ai/contracts/common';
import { MODERATION_NOTE_MAX, type ModerationAction } from '@/ai/contracts/merchant-trust';
import type { KnownPricePositioning } from '@/ai/contracts/shop-analysis-v2';
import { BackButton, InfoRow, Notice } from '@/components/merchant';
import { Button, EmptyState, Screen, Text, TextField } from '@/components/ui';
import { getMerchantTaxonomy } from '@/lib/api/merchant';
import { getSubmissionForModeration, moderateSubmission } from '@/lib/api/moderation';
import { formatClaimDate } from '@/lib/merchant/claim';
import { AUDIENCE_LABELS, PRICE_LABELS } from '@/lib/merchant/labels';
import {
  checkModerationNote,
  MODERATION_ACTION_LABELS,
  MODERATION_MESSAGES,
  type ModerationDetail,
  type ModerationResult,
} from '@/lib/merchant/moderation';
import type { MerchantTaxonomy } from '@/lib/merchant/profile';
import { uuidParam } from '@/lib/merchant/routes';
import { submissionStatusView } from '@/lib/merchant/submissions';
import { singleFlight } from '@/lib/merchant/submit';
import { useAsyncResource } from '@/lib/use-async-resource';
import { colors, layout, radii, spacing } from '@/theme';

const IMAGE_TILE = 88;
const EMPTY_TAXONOMY: MerchantTaxonomy = { categories: [], tags: [] };

/**
 * One request under review: the merchant's profile as submitted, what the
 * server observed on the site, what the model suggested — side by side — and
 * the three decisions. The profile is merchant-written: it is displayed as
 * text, and the approval rebuilds the shop from validated values server-side.
 */
export default function ModerationDetailScreen() {
  const params = useLocalSearchParams<{ id?: string }>();
  const id = uuidParam(params.id);

  const load = useCallback(async () => {
    if (!id) {
      return null;
    }
    const [detail, taxonomy] = await Promise.all([
      getSubmissionForModeration(id),
      getMerchantTaxonomy().catch(() => EMPTY_TAXONOMY),
    ]);
    return detail ? { detail, taxonomy } : null;
  }, [id]);
  const resource = useAsyncResource(load);

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

  if (!resource.data) {
    return (
      <Screen center>
        <EmptyState
          title="Demande introuvable"
          description={MODERATION_MESSAGES.submission_not_found}
          actionLabel="Retour"
          onActionPress={() => router.back()}
        />
      </Screen>
    );
  }

  return <ModerationDetailView detail={resource.data.detail} taxonomy={resource.data.taxonomy} />;
}

function ModerationDetailView({ detail, taxonomy }: { detail: ModerationDetail; taxonomy: MerchantTaxonomy }) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ModerationResult | null>(null);
  const [pendingAction, setPendingAction] = useState<ModerationAction | null>(null);
  /** One decision at a time: a double tap sends one request. */
  const [runOnce] = useState(() => singleFlight<ModerationResult>());

  const categoryName = (slug: string) => taxonomy.categories.find((entry) => entry.slug === slug)?.name ?? slug;
  const tagName = (slug: string) => taxonomy.tags.find((entry) => entry.slug === slug)?.name ?? slug;
  const list = (values: readonly string[]) => (values.length > 0 ? values.join(', ') : '—');

  const status = submissionStatusView(detail.status);
  const profile = detail.profile;
  const reviewable = (detail.status === 'submitted' || detail.status === 'processing') && !detail.ownSubmission && result === null;

  const act = (action: ModerationAction) => {
    const noteError = checkModerationNote(action, note);
    if (noteError) {
      setError(noteError);
      return;
    }

    const run = async () => {
      const pending = runOnce(() => moderateSubmission(detail.id, action, note));
      if (pending === null) {
        return;
      }
      setPendingAction(action);
      setError(null);
      const outcome = await pending.catch(
        (): ModerationResult => ({ ok: false, outcome: 'failed', message: MODERATION_MESSAGES.failed })
      );
      setPendingAction(null);
      if (outcome.ok) {
        setResult(outcome);
      } else {
        setError(outcome.message);
      }
    };

    if (action === 'needs_changes') {
      void run();
      return;
    }
    Alert.alert(
      action === 'approve' ? 'Approuver cette boutique ?' : 'Refuser cette demande ?',
      action === 'approve'
        ? 'La fiche sera publiée et le demandeur en deviendra propriétaire. Aucune vérification n’est attribuée.'
        : 'Le marchand verra votre note.',
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: MODERATION_ACTION_LABELS[action],
          style: action === 'reject' ? 'destructive' : 'default',
          onPress: () => void run(),
        },
      ]
    );
  };

  const approvedShopId = result?.ok && result.outcome === 'approved' ? result.shopId : null;

  return (
    <Screen scroll>
      <BackButton />

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Text variant="title">{profile?.name ?? detail.host ?? 'Demande'}</Text>
        <Text variant="meta" tone="secondary" style={styles.meta}>
          {[detail.host, status?.label, detail.updatedAt ? formatClaimDate(detail.updatedAt) : null, detail.submitterRef ? `Demandeur ${detail.submitterRef}` : null]
            .filter(Boolean)
            .join(' · ')}
        </Text>

        <View style={styles.notices}>
          {result ? <Notice icon="check">{result.message}</Notice> : null}
          {detail.ownSubmission ? <Notice>{MODERATION_MESSAGES.own_submission}</Notice> : null}
          {detail.hostAlreadyListed ? <Notice>Une boutique existe déjà pour ce domaine.</Notice> : null}
          {detail.analysisSameHost === false ? (
            <Notice>L’analyse du site ne correspond pas à ce domaine : aucune image ne sera importée.</Notice>
          ) : null}
          {detail.observed === null && detail.suggested === null ? <Notice>Aucune analyse du site n’est disponible.</Notice> : null}
          {detail.status === 'needs_changes' && detail.reviewNote ? (
            <Notice>{`Modifications demandées : ${detail.reviewNote}`}</Notice>
          ) : null}
        </View>

        <View style={styles.section}>
          <Text variant="sectionTitle">Fiche proposée</Text>
          {profile ? (
            <View>
              <InfoRow label="Nom" value={profile.name ?? '—'} />
              <InfoRow label="Description" value={profile.shortDescription ?? '—'} />
              <InfoRow label="Catégorie principale" value={profile.primaryCategory ? categoryName(profile.primaryCategory) : '—'} />
              <InfoRow label="Catégories secondaires" value={list(profile.secondaryCategories.map(categoryName))} />
              <InfoRow label="Public" value={list(profile.audience.map((item) => AUDIENCE_LABELS[item as Audience] ?? item))} />
              <InfoRow
                label="Positionnement prix"
                value={profile.pricePositioning ? (PRICE_LABELS[profile.pricePositioning as KnownPricePositioning] ?? profile.pricePositioning) : '—'}
              />
              <InfoRow label="Styles" value={list(profile.styles)} />
              <InfoRow label="Valeurs" value={list(profile.values)} />
              <InfoRow label="Types de produits" value={list(profile.productTypes)} />
              <InfoRow label="Tags" value={list(profile.tags.map(tagName))} />
            </View>
          ) : (
            <Text variant="meta" tone="tertiary">
              Aucune fiche envoyée.
            </Text>
          )}
          {profile && profile.imageUrls.length > 0 ? (
            <View style={styles.images}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.imageStrip}>
                {profile.imageUrls.map((url) => (
                  <View key={url} style={styles.imageTile}>
                    <Image source={{ uri: url }} style={styles.imageFill} contentFit="cover" cachePolicy="memory-disk" accessible accessibilityLabel="Image proposée" />
                  </View>
                ))}
              </ScrollView>
              <Text variant="caption" tone="tertiary">
                Seules les images observées sur le site par Shop Discovery seront importées.
              </Text>
            </View>
          ) : null}
        </View>

        {detail.observed ? (
          <View style={styles.section}>
            <Text variant="sectionTitle">Observé sur le site</Text>
            <View>
              <InfoRow label="Nom" value={detail.observed.name ?? '—'} />
              <InfoRow label="Description" value={detail.observed.description ?? '—'} />
            </View>
          </View>
        ) : null}

        {detail.suggested ? (
          <View style={styles.section}>
            <Text variant="sectionTitle">Suggestion de l’IA</Text>
            <View>
              <InfoRow label="Description" value={detail.suggested.shortDescription ?? '—'} />
              <InfoRow label="Catégorie" value={detail.suggested.primaryCategory ? categoryName(detail.suggested.primaryCategory) : '—'} />
              <InfoRow label="Tags" value={list(detail.suggested.tags.map(tagName))} />
            </View>
          </View>
        ) : null}

        {reviewable ? (
          <View style={styles.actions}>
            <TextField
              label="Note pour le marchand"
              value={note}
              onChangeText={(value) => {
                setNote(value);
                setError(null);
              }}
              multiline
              maxLength={MODERATION_NOTE_MAX}
              counter={`${note.length}/${MODERATION_NOTE_MAX}`}
              hint="Obligatoire pour demander des modifications ou refuser."
            />
            {error ? (
              <Text variant="meta" tone="danger" accessibilityRole="alert">
                {error}
              </Text>
            ) : null}
            <Button
              label={MODERATION_ACTION_LABELS.approve}
              size="lg"
              fullWidth
              loading={pendingAction === 'approve'}
              disabled={pendingAction !== null}
              onPress={() => act('approve')}
            />
            <Button
              variant="secondary"
              label={MODERATION_ACTION_LABELS.needs_changes}
              fullWidth
              loading={pendingAction === 'needs_changes'}
              disabled={pendingAction !== null}
              onPress={() => act('needs_changes')}
            />
            <Button
              variant="text"
              label={MODERATION_ACTION_LABELS.reject}
              loading={pendingAction === 'reject'}
              disabled={pendingAction !== null}
              onPress={() => act('reject')}
            />
          </View>
        ) : null}

        {approvedShopId ? (
          <Button
            variant="secondary"
            label="Voir la fiche publique"
            fullWidth
            style={styles.actions}
            onPress={() => router.push({ pathname: '/shop/[id]', params: { id: approvedShopId } })}
          />
        ) : null}
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  meta: {
    marginTop: spacing.xxs,
  },
  notices: {
    gap: spacing.sm,
    marginTop: spacing.xl,
  },
  section: {
    gap: spacing.xs,
    marginTop: layout.sectionGap,
  },
  images: {
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  imageStrip: {
    gap: spacing.sm,
  },
  imageTile: {
    width: IMAGE_TILE,
    height: IMAGE_TILE,
    borderRadius: radii.md,
    overflow: 'hidden',
    backgroundColor: colors.surfaceSecondary,
  },
  imageFill: {
    width: IMAGE_TILE,
    height: IMAGE_TILE,
  },
  actions: {
    gap: spacing.sm,
    marginTop: layout.sectionGap,
  },
});
