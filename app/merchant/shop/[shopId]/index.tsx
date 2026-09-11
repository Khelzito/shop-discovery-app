import { router, useLocalSearchParams } from 'expo-router';
import { useCallback } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { BackButton, InfoRow, MerchantAuthGate, Notice } from '@/components/merchant';
import { Button, EmptyState, ImageFrame, Screen, Text, VerifiedMark } from '@/components/ui';
import { getManagedShop } from '@/lib/api/merchant';
import { canEditShop, SHOP_ROLE_LABELS, SHOP_STATUS_LABELS } from '@/lib/merchant/management';
import { uuidParam } from '@/lib/merchant/routes';
import { useFocusResource } from '@/lib/use-focus-resource';
import { colors, layout, spacing } from '@/theme';

/**
 * A shop the merchant manages: what the public sees, where it stands, and the
 * way to edit its content. Status, publication, the domain and verifications
 * are shown as facts — there is no control for them here.
 */
export default function ManagedShopScreen() {
  return (
    <MerchantAuthGate>
      <ManagedShopContent />
    </MerchantAuthGate>
  );
}

function ManagedShopContent() {
  const params = useLocalSearchParams<{ shopId?: string }>();
  const shopId = uuidParam(params.shopId);
  const load = useCallback(async () => (shopId ? getManagedShop(shopId) : null), [shopId]);
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

  const shop = resource.data;
  if (!shop) {
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

  const cover = shop.images.find((image) => image.type === 'cover') ?? shop.images.find((image) => image.type === 'gallery');
  const editable = canEditShop(shop.role);

  return (
    <Screen scroll>
      <BackButton />

      <ImageFrame name={shop.name} source={cover?.url ?? null} ratio="landscape" />

      <View style={styles.heading}>
        <Text variant="title">{shop.name}</Text>
        {shop.host ? (
          <Text variant="meta" tone="secondary">
            {shop.host}
          </Text>
        ) : null}
        {shop.domainVerified ? <VerifiedMark variant="badge" style={styles.badge} /> : null}
      </View>

      <View style={styles.section}>
        <InfoRow label="Statut" value={SHOP_STATUS_LABELS[shop.status] ?? shop.status} />
        <InfoRow label="Votre rôle" value={SHOP_ROLE_LABELS[shop.role]} />
        {shop.shortDescription ? <InfoRow label="Description" value={shop.shortDescription} /> : null}
      </View>

      <View style={styles.actions}>
        {editable ? (
          <Button
            label="Modifier la fiche"
            size="lg"
            fullWidth
            iconLeft="edit"
            onPress={() => router.push({ pathname: '/merchant/shop/[shopId]/edit', params: { shopId: shop.id } })}
          />
        ) : (
          <Notice>Votre rôle ne permet pas de modifier cette fiche.</Notice>
        )}
        {shop.status === 'published' ? (
          <Button
            variant="secondary"
            label="Voir la fiche publique"
            fullWidth
            onPress={() => router.push({ pathname: '/shop/[id]', params: { id: shop.id } })}
          />
        ) : null}
      </View>

      <Text variant="caption" tone="tertiary" style={styles.footnote}>
        L’adresse du site, la publication et les vérifications sont gérées par Shop Discovery.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  heading: {
    gap: spacing.xxs,
    marginTop: spacing.xl,
  },
  badge: {
    marginTop: spacing.xs,
  },
  section: {
    marginTop: spacing.xl,
  },
  actions: {
    gap: spacing.sm,
    marginTop: layout.sectionGap,
  },
  footnote: {
    marginTop: spacing.xl,
  },
});
