import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';

import { AUDIENCES, type Audience } from '@/ai/contracts/common';
import { MERCHANT_PROFILE_LIMITS as LIMITS } from '@/ai/contracts/shop-analysis-endpoint';
import { BackButton, ChoiceChips, FieldBlock, MerchantAuthGate, Notice } from '@/components/merchant';
import { Button, EmptyState, IconButton, Screen, Text, TextField } from '@/components/ui';
import { getManagedShop, getMerchantTaxonomy, updateManagedShop } from '@/lib/api/merchant';
import { AUDIENCE_LABELS, PRICE_LABELS } from '@/lib/merchant/labels';
import {
  canEditShop,
  editValuesOf,
  MANAGEMENT_MESSAGES,
  validateShopEdit,
  type ManagedShop,
  type ManageShopResult,
  type ShopEditErrors,
  type ShopEditValues,
} from '@/lib/merchant/management';
import type { MerchantTaxonomy } from '@/lib/merchant/profile';
import { uuidParam } from '@/lib/merchant/routes';
import { singleFlight } from '@/lib/merchant/submit';
import { useAsyncResource } from '@/lib/use-async-resource';
import { colors, layout, radii, spacing } from '@/theme';

const PRICE_LEVELS = [
  { value: '1', label: PRICE_LABELS.budget },
  { value: '2', label: PRICE_LABELS.mid },
  { value: '3', label: PRICE_LABELS.premium },
  { value: '4', label: PRICE_LABELS.luxury },
] as const;
type PriceValue = (typeof PRICE_LEVELS)[number]['value'];

/** Image tiles: explicit size, as in the review form. */
const IMAGE_TILE = 88;

/**
 * Editing a managed shop's content: name, description, categories, tags,
 * audience, price positioning, and removing images. Saved in one transaction
 * by update_managed_shop, which re-checks the role and every value.
 */
export default function EditManagedShopScreen() {
  return (
    <MerchantAuthGate>
      <EditLoader />
    </MerchantAuthGate>
  );
}

function EditLoader() {
  const params = useLocalSearchParams<{ shopId?: string }>();
  const shopId = uuidParam(params.shopId);

  const load = useCallback(async () => {
    if (!shopId) {
      return null;
    }
    const [shop, taxonomy] = await Promise.all([getManagedShop(shopId), getMerchantTaxonomy()]);
    return shop ? { shop, taxonomy } : null;
  }, [shopId]);
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
          title="Boutique introuvable"
          description="Cette boutique n’est pas associée à votre compte."
          actionLabel="Retour au profil"
          onActionPress={() => router.dismissTo('/profile')}
        />
      </Screen>
    );
  }

  if (!canEditShop(resource.data.shop.role)) {
    return (
      <Screen center>
        <EmptyState
          title="Modification impossible"
          description={MANAGEMENT_MESSAGES.forbidden}
          actionLabel="Retour"
          onActionPress={() => router.back()}
        />
      </Screen>
    );
  }

  return <EditForm shop={resource.data.shop} taxonomy={resource.data.taxonomy} />;
}

function EditForm({ shop, taxonomy }: { shop: ManagedShop; taxonomy: MerchantTaxonomy }) {
  const [values, setValues] = useState<ShopEditValues>(() => editValuesOf(shop));
  const [errors, setErrors] = useState<ShopEditErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** One save at a time: a double tap saves once and navigates once. */
  const [runOnce] = useState(() => singleFlight<ManageShopResult>());

  const update = (patch: Partial<ShopEditValues>, field?: keyof ShopEditErrors) => {
    setValues((current) => ({ ...current, ...patch }));
    if (field && errors[field]) {
      setErrors((current) => ({ ...current, [field]: undefined }));
    }
  };

  const toggle = <T extends string>(list: readonly T[], value: T): T[] =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

  const save = async () => {
    const validated = validateShopEdit(shop.id, values, taxonomy);
    if (!validated.ok) {
      setErrors(validated.errors);
      setSubmitError(MANAGEMENT_MESSAGES.invalid);
      return;
    }
    const pending = runOnce(() => updateManagedShop(validated.params));
    if (pending === null) {
      return;
    }
    setSaving(true);
    setSubmitError(null);
    const result = await pending.catch(
      (): ManageShopResult => ({ ok: false, reason: 'failed', message: MANAGEMENT_MESSAGES.failed })
    );
    setSaving(false);
    if (result.ok) {
      router.back();
      return;
    }
    setSubmitError(result.message);
  };

  const categoryOptions = taxonomy.categories.map((entry) => ({ value: entry.slug, label: entry.name }));
  const tagOptions = taxonomy.tags.map((entry) => ({ value: entry.slug, label: entry.name }));
  const kept = shop.images.filter((image) => !values.removedImageIds.includes(image.id));

  return (
    <Screen scroll>
      <BackButton />

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Text variant="title">Modifier la fiche</Text>
        {shop.host ? (
          <Text variant="meta" tone="secondary" style={styles.host}>
            {shop.host}
          </Text>
        ) : null}

        <View style={styles.form}>
          <TextField
            label="Nom de la boutique"
            value={values.name}
            onChangeText={(name) => update({ name }, 'name')}
            maxLength={LIMITS.name}
            autoCapitalize="words"
            error={errors.name}
          />

          <TextField
            label="Description courte"
            value={values.shortDescription ?? ''}
            onChangeText={(shortDescription) => update({ shortDescription }, 'shortDescription')}
            multiline
            maxLength={LIMITS.shortDescription}
            counter={`${(values.shortDescription ?? '').length}/${LIMITS.shortDescription}`}
            error={errors.shortDescription}
          />

          <FieldBlock label="Catégorie principale" error={errors.primaryCategory}>
            <ChoiceChips
              options={categoryOptions}
              selected={values.primaryCategory ? [values.primaryCategory] : []}
              onToggle={(slug) =>
                update(
                  {
                    primaryCategory: values.primaryCategory === slug ? '' : slug,
                    secondaryCategories: values.secondaryCategories.filter((item) => item !== slug),
                  },
                  'primaryCategory'
                )
              }
            />
          </FieldBlock>

          <FieldBlock label={`Catégories secondaires · ${LIMITS.secondaryCategories} max`} error={errors.secondaryCategories}>
            <ChoiceChips
              options={categoryOptions.filter((option) => option.value !== values.primaryCategory)}
              selected={values.secondaryCategories}
              max={LIMITS.secondaryCategories}
              onToggle={(slug) =>
                update({ secondaryCategories: toggle(values.secondaryCategories, slug) }, 'secondaryCategories')
              }
            />
          </FieldBlock>

          <FieldBlock label="Public">
            <ChoiceChips<Audience>
              options={AUDIENCES.map((audience) => ({ value: audience, label: AUDIENCE_LABELS[audience] }))}
              selected={values.audience ? [values.audience] : []}
              onToggle={(audience) => update({ audience: values.audience === audience ? null : audience })}
            />
          </FieldBlock>

          <FieldBlock label="Positionnement prix">
            <ChoiceChips<PriceValue>
              options={PRICE_LEVELS}
              selected={values.priceLevel ? [String(values.priceLevel) as PriceValue] : []}
              onToggle={(level) => {
                const next = Number(level) as 1 | 2 | 3 | 4;
                update({ priceLevel: values.priceLevel === next ? null : next });
              }}
            />
          </FieldBlock>

          {tagOptions.length > 0 ? (
            <FieldBlock label={`Tags · ${LIMITS.tags} max`} error={errors.tags}>
              <ChoiceChips
                options={tagOptions}
                selected={values.tags}
                max={LIMITS.tags}
                onToggle={(slug) => update({ tags: toggle(values.tags, slug) }, 'tags')}
              />
            </FieldBlock>
          ) : null}

          {shop.images.length > 0 ? (
            <FieldBlock label="Images" hint="Une image retirée n’apparaît plus sur votre fiche.">
              {kept.length > 0 ? (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  keyboardShouldPersistTaps="handled"
                  contentContainerStyle={styles.imageStrip}>
                  {kept.map((image) => (
                    <View key={image.id} style={styles.imageTile}>
                      <Image
                        source={{ uri: image.url }}
                        style={styles.imageFill}
                        contentFit="cover"
                        cachePolicy="memory-disk"
                        accessible
                        accessibilityLabel="Image de la boutique"
                      />
                      <IconButton
                        icon="close"
                        size="sm"
                        accessibilityLabel="Retirer cette image"
                        onPress={() => update({ removedImageIds: [...values.removedImageIds, image.id] })}
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
              {values.removedImageIds.length > 0 ? (
                <Button
                  variant="text"
                  label="Rétablir les images"
                  onPress={() => update({ removedImageIds: [] })}
                  style={styles.restore}
                />
              ) : null}
            </FieldBlock>
          ) : null}
        </View>

        <View style={styles.footer}>
          <Notice>L’adresse du site, la publication et les vérifications ne se modifient pas ici.</Notice>
          {submitError ? (
            <Text variant="meta" tone="danger" accessibilityRole="alert">
              {submitError}
            </Text>
          ) : null}
          <Button
            label="Enregistrer"
            size="lg"
            fullWidth
            loading={saving}
            disabled={saving}
            onPress={() => void save()}
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  host: {
    marginTop: spacing.xxs,
  },
  form: {
    gap: spacing.xl,
    marginTop: layout.sectionGap,
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
  removeImage: {
    position: 'absolute',
    top: spacing.xxs,
    right: spacing.xxs,
  },
  restore: {
    alignSelf: 'flex-start',
  },
  footer: {
    gap: spacing.sm,
    marginTop: spacing.huge,
  },
});
