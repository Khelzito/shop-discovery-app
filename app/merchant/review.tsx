import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';

import type { MerchantProfileField } from '@/ai/contracts/shop-analysis-endpoint';
import { MERCHANT_PROFILE_LIMITS as LIMITS } from '@/ai/contracts/shop-analysis-endpoint';
import { AUDIENCES, type Audience } from '@/ai/contracts/common';
import {
  BackButton,
  ChoiceChips,
  EditableList,
  FieldBlock,
  MerchantAuthGate,
  Notice,
} from '@/components/merchant';
import { Button, EmptyState, IconButton, ImageFrame, Screen, Text, TextField } from '@/components/ui';
import {
  getMerchantSubmission,
  getMerchantTaxonomy,
  isEditableSubmission,
  submitMerchantSubmission,
  type MerchantSubmission,
} from '@/lib/api/merchant';
import { ANALYSIS_MESSAGES } from '@/lib/merchant/analysis-response';
import { AUDIENCE_LABELS, ORIGIN_HINTS, PRICE_LABELS } from '@/lib/merchant/labels';
import {
  KNOWN_PRICES,
  originOf,
  profileDraftFromProposal,
  type MerchantProfileDraft,
  type MerchantTaxonomy,
  type ProfileErrors,
  type ProfileValues,
} from '@/lib/merchant/profile';
import { manualReasonParam, uuidParam, type ManualReason } from '@/lib/merchant/routes';
import {
  MERCHANT_SUBMITTED_PATH,
  singleFlight,
  submitReview,
  type ReviewSubmitResult,
} from '@/lib/merchant/submit';
import { hostOfUrl } from '@/lib/merchant/url';
import { useAsyncResource } from '@/lib/use-async-resource';
import { useMerchantFlow, type LastAnalysis } from '@/state/merchant-flow';
import { colors, layout, radii, spacing } from '@/theme';

export default function MerchantReviewScreen() {
  return (
    <MerchantAuthGate>
      <ReviewLoader />
    </MerchantAuthGate>
  );
}

function ReviewLoader() {
  const params = useLocalSearchParams<{ submissionId?: string; reason?: string }>();
  const submissionId = uuidParam(params.submissionId);
  const reason = manualReasonParam(params.reason);

  const load = useCallback(async () => {
    if (!submissionId) {
      return null;
    }
    const [submission, taxonomy] = await Promise.all([
      getMerchantSubmission(submissionId),
      getMerchantTaxonomy(),
    ]);
    return { submission, taxonomy };
  }, [submissionId]);

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

  const submission = resource.data?.submission ?? null;
  if (!submission) {
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

  if (!isEditableSubmission(submission)) {
    return (
      <Screen center>
        <EmptyState
          icon="check"
          title="Demande déjà envoyée"
          description="Nous vérifions les informations avant toute publication."
          actionLabel="Retour au profil"
          onActionPress={() => router.dismissTo('/profile')}
        />
      </Screen>
    );
  }

  return <ReviewForm submission={submission} taxonomy={resource.data!.taxonomy} reason={reason} />;
}

/** Detected image tiles: explicit size, never derived from an aspect ratio. */
const IMAGE_TILE = 88;

const MANUAL_MESSAGES: Record<ManualReason, string> = {
  robots_disallowed: ANALYSIS_MESSAGES.robots_disallowed,
  fetch_blocked: ANALYSIS_MESSAGES.fetch_blocked,
  timeout: ANALYSIS_MESSAGES.timeout,
  unreadable: ANALYSIS_MESSAGES.unreadable,
  not_saved: 'La proposition n’a pas pu être enregistrée. Vérifiez et complétez les informations.',
};

function initialDraft(submission: MerchantSubmission, lastAnalysis: LastAnalysis | null): MerchantProfileDraft {
  // The stored proposal first. The in-memory analysis only when the proposal
  // could not be stored for this very submission.
  const fallback =
    submission.proposal == null &&
    lastAnalysis?.submissionId === submission.id &&
    lastAnalysis.analysis !== null
      ? { observed: lastAnalysis.analysis.observed, inferred: lastAnalysis.analysis.inferred }
      : null;
  return profileDraftFromProposal(submission.proposal ?? fallback, submission.websiteUrl);
}

function ReviewForm({
  submission,
  taxonomy,
  reason,
}: {
  submission: MerchantSubmission;
  taxonomy: MerchantTaxonomy;
  reason: ManualReason | null;
}) {
  const flow = useMerchantFlow();
  const [draft, setDraft] = useState<MerchantProfileDraft>(
    () => flow.draftFor(submission.id) ?? initialDraft(submission, flow.lastAnalysis)
  );
  const [errors, setErrors] = useState<ProfileErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** Images whose tile was hidden because they failed to load: never sent. */
  const [unavailableImages, setUnavailableImages] = useState<string[]>([]);
  /** One request at a time: a double tap sends once and navigates once. */
  const [runOnce] = useState(() => singleFlight<ReviewSubmitResult>());

  // flow.saveDraft is stable and ignores a submission already sent, so this
  // cannot resurrect a draft after the request goes out.
  useEffect(() => {
    flow.saveDraft(submission.id, draft);
  }, [draft, flow, submission.id]);

  const update = (patch: Partial<ProfileValues>, field: MerchantProfileField) => {
    setDraft((current) => ({ ...current, values: { ...current.values, ...patch } }));
    if (errors[field]) {
      setErrors((current) => ({ ...current, [field]: undefined }));
    }
  };

  const hint = (field: MerchantProfileField) => ORIGIN_HINTS[originOf(draft, field)];
  const values = draft.values;

  const toggle = <T extends string>(list: readonly T[], value: T): T[] =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

  const submit = async () => {
    const pending = runOnce(() =>
      submitReview({
        submissionId: submission.id,
        submittedData: submission.submittedData,
        draft,
        taxonomy,
        unavailableImageUrls: unavailableImages,
        send: submitMerchantSubmission,
      })
    );
    if (pending === null) {
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    const result = await pending;
    setSubmitting(false);

    if (result.kind === 'sent') {
      flow.markSent(submission.id);
      router.replace(MERCHANT_SUBMITTED_PATH);
      return;
    }
    setErrors(result.kind === 'invalid' ? result.errors : {});
    setSubmitError(result.message);
  };

  const categoryOptions = taxonomy.categories.map((entry) => ({ value: entry.slug, label: entry.name }));
  const tagOptions = taxonomy.tags.map((entry) => ({ value: entry.slug, label: entry.name }));
  const domain = hostOfUrl(submission.websiteUrl);

  return (
    <Screen scroll>
      <BackButton />

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Text variant="title">Vérifiez votre fiche</Text>
        {domain ? (
          <Text variant="meta" tone="secondary" style={styles.domain}>
            {domain}
          </Text>
        ) : null}

        <View style={styles.notices}>
          <Notice icon="shield">
            Ces informations sont une proposition et seront vérifiées avant publication.
          </Notice>
          {reason ? <Notice>{MANUAL_MESSAGES[reason]}</Notice> : null}
        </View>

        <View style={styles.form}>
          {values.logoUrl ? (
            <View style={styles.logoRow}>
              <ImageFrame source={values.logoUrl} name={values.name || 'Logo'} ratio="square" width={64} radius="md" />
              <View style={styles.logoText}>
                <Text variant="label">Logo</Text>
                <Text variant="caption" tone="tertiary">
                  {ORIGIN_HINTS.site}
                </Text>
              </View>
              <Button variant="text" label="Retirer" onPress={() => update({ logoUrl: null }, 'logoUrl')} />
            </View>
          ) : null}

          <TextField
            label="Nom de la boutique"
            value={values.name}
            onChangeText={(name) => update({ name }, 'name')}
            maxLength={LIMITS.name}
            autoCapitalize="words"
            hint={hint('name')}
            error={errors.name}
          />

          <TextField
            label="Description courte"
            value={values.shortDescription}
            onChangeText={(shortDescription) => update({ shortDescription }, 'shortDescription')}
            multiline
            maxLength={LIMITS.shortDescription}
            counter={`${values.shortDescription.length}/${LIMITS.shortDescription}`}
            hint={hint('shortDescription')}
            error={errors.shortDescription}
          />

          <FieldBlock label="Catégorie principale" hint={hint('primaryCategory')} error={errors.primaryCategory}>
            <ChoiceChips
              options={categoryOptions}
              selected={values.primaryCategory ? [values.primaryCategory] : []}
              onToggle={(slug) =>
                update(
                  {
                    primaryCategory: values.primaryCategory === slug ? null : slug,
                    secondaryCategories: values.secondaryCategories.filter((item) => item !== slug),
                  },
                  'primaryCategory'
                )
              }
            />
          </FieldBlock>

          <FieldBlock
            label={`Catégories secondaires · ${LIMITS.secondaryCategories} max`}
            hint={hint('secondaryCategories')}
            error={errors.secondaryCategories}>
            <ChoiceChips
              options={categoryOptions.filter((option) => option.value !== values.primaryCategory)}
              selected={values.secondaryCategories}
              max={LIMITS.secondaryCategories}
              onToggle={(slug) =>
                update({ secondaryCategories: toggle(values.secondaryCategories, slug) }, 'secondaryCategories')
              }
            />
          </FieldBlock>

          <FieldBlock label="Public" hint={hint('audience')} error={errors.audience}>
            <ChoiceChips<Audience>
              options={AUDIENCES.map((audience) => ({ value: audience, label: AUDIENCE_LABELS[audience] }))}
              selected={values.audience}
              onToggle={(audience) => update({ audience: toggle(values.audience, audience) }, 'audience')}
            />
          </FieldBlock>

          <FieldBlock label="Positionnement prix" hint={hint('pricePositioning')} error={errors.pricePositioning}>
            <ChoiceChips
              options={KNOWN_PRICES.map((price) => ({ value: price, label: PRICE_LABELS[price] }))}
              selected={values.pricePositioning ? [values.pricePositioning] : []}
              onToggle={(price) =>
                update(
                  { pricePositioning: values.pricePositioning === price ? null : price },
                  'pricePositioning'
                )
              }
            />
          </FieldBlock>

          <EditableList
            label="Styles"
            items={values.styles}
            onChange={(styles) => update({ styles }, 'styles')}
            placeholder="Ajouter un style"
            maxItems={LIMITS.listItems}
            maxLength={LIMITS.listItem}
            hint={hint('styles')}
            error={errors.styles}
          />

          <EditableList
            label="Valeurs"
            items={values.values}
            onChange={(next) => update({ values: next }, 'values')}
            placeholder="Ajouter une valeur"
            maxItems={LIMITS.listItems}
            maxLength={LIMITS.listItem}
            hint={hint('values')}
            error={errors.values}
          />

          <EditableList
            label="Types de produits"
            items={values.productTypes}
            onChange={(productTypes) => update({ productTypes }, 'productTypes')}
            placeholder="Ajouter un type de produit"
            maxItems={LIMITS.listItems}
            maxLength={LIMITS.listItem}
            hint={hint('productTypes')}
            error={errors.productTypes}
          />

          {tagOptions.length > 0 ? (
            <FieldBlock label={`Tags · ${LIMITS.tags} max`} hint={hint('tags')} error={errors.tags}>
              <ChoiceChips
                options={tagOptions}
                selected={values.tags}
                max={LIMITS.tags}
                onToggle={(slug) => update({ tags: toggle(values.tags, slug) }, 'tags')}
              />
            </FieldBlock>
          ) : null}

          {draft.availableImageUrls.length > 0 ? (
            <DetectedImages
              available={draft.availableImageUrls}
              kept={values.imageUrls}
              onRemove={(imageUrl) =>
                update({ imageUrls: values.imageUrls.filter((item) => item !== imageUrl) }, 'imageUrls')
              }
              onUnavailable={(imageUrl) =>
                setUnavailableImages((current) => (current.includes(imageUrl) ? current : [...current, imageUrl]))
              }
            />
          ) : null}
        </View>

        <View style={styles.footer}>
          {submitError ? (
            <Text variant="meta" tone="danger" accessibilityRole="alert">
              {submitError}
            </Text>
          ) : null}
          <Button
            label="Envoyer ma demande"
            size="lg"
            fullWidth
            loading={submitting}
            disabled={submitting}
            onPress={() => void submit()}
          />
          <Text variant="caption" tone="tertiary" align="center">
            Rien n’est publié sans vérification.
          </Text>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  domain: {
    marginTop: spacing.xxs,
  },
  notices: {
    gap: spacing.sm,
    marginTop: spacing.xl,
  },
  form: {
    gap: spacing.xl,
    marginTop: layout.sectionGap,
  },
  logoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  logoText: {
    flex: 1,
    gap: spacing.xxs,
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
  imageLoading: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceSecondary,
    pointerEvents: 'none',
  },
  removeImage: {
    position: 'absolute',
    top: spacing.xxs,
    right: spacing.xxs,
  },
  footer: {
    gap: spacing.sm,
    marginTop: spacing.huge,
  },
});

type ImageLoadState = 'loaded' | 'failed';

/**
 * Images detected on the merchant's site, in a single horizontal row.
 *
 * Tiles have explicit dimensions, show a spinner until the image paints, and
 * disappear when it cannot load. A failed image is reported to the form, which
 * leaves it out of the request: the merchant could not see it, so it is never
 * sent silently. When no kept image can be shown, the section disappears.
 */
function DetectedImages({
  available,
  kept,
  onRemove,
  onUnavailable,
}: {
  available: readonly string[];
  kept: readonly string[];
  onRemove: (imageUrl: string) => void;
  onUnavailable: (imageUrl: string) => void;
}) {
  const [states, setStates] = useState<Record<string, ImageLoadState>>({});

  const mark = (imageUrl: string, state: ImageLoadState) =>
    setStates((current) => (current[imageUrl] === state ? current : { ...current, [imageUrl]: state }));

  const fail = (imageUrl: string) => {
    mark(imageUrl, 'failed');
    onUnavailable(imageUrl);
  };

  const visible = kept.filter((imageUrl) => states[imageUrl] !== 'failed');
  const displayable = available.filter((imageUrl) => states[imageUrl] !== 'failed');
  const allKeptFailed = kept.length > 0 && visible.length === 0;

  if (allKeptFailed || displayable.length === 0) {
    return null;
  }

  const anyLoaded = visible.some((imageUrl) => states[imageUrl] === 'loaded');

  return (
    <FieldBlock label="Images" hint={anyLoaded ? ORIGIN_HINTS.site : null}>
      {visible.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.imageStrip}>
          {visible.map((imageUrl) => (
            <View key={imageUrl} style={styles.imageTile}>
              <Image
                source={{ uri: imageUrl }}
                style={styles.imageFill}
                contentFit="cover"
                transition={200}
                cachePolicy="memory-disk"
                accessible
                accessibilityLabel="Image détectée sur votre site"
                onLoad={() => mark(imageUrl, 'loaded')}
                onError={() => fail(imageUrl)}
              />
              {states[imageUrl] !== 'loaded' ? (
                <View style={styles.imageLoading}>
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                </View>
              ) : null}
              <IconButton
                icon="close"
                size="sm"
                accessibilityLabel="Retirer cette image"
                onPress={() => onRemove(imageUrl)}
                style={styles.removeImage}
              />
            </View>
          ))}
        </ScrollView>
      ) : (
        <Text variant="meta" tone="tertiary">
          Aucune image conservée.
        </Text>
      )}
    </FieldBlock>
  );
}
