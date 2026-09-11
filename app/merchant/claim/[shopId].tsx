import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Share, StyleSheet, View } from 'react-native';

import { BackButton, MerchantAuthGate, Notice, NumberedSteps } from '@/components/merchant';
import { Button, EmptyState, Screen, Text } from '@/components/ui';
import {
  getMyOpenClaim,
  getPublishedShopSummary,
  isMemberOfShop,
  requestShopClaim,
} from '@/lib/api/merchant';
import {
  CLAIM_MESSAGES,
  claimMetaTag,
  formatClaimDate,
  type ClaimFailure,
  type ClaimToken,
} from '@/lib/merchant/claim';
import { uuidParam } from '@/lib/merchant/routes';
import { hostOfUrl } from '@/lib/merchant/url';
import { useAsyncResource } from '@/lib/use-async-resource';
import { colors, layout, radii, spacing } from '@/theme';

const STEPS = [
  'Générez votre balise',
  'Ajoutez-la dans la page d’accueil de votre site',
  'Nous vérifierons sa présence avant de valider votre demande',
] as const;

/**
 * Claim — prove a listed shop is yours.
 *
 * request_shop_claim opens a PENDING claim and returns a one-time token; it
 * never approves, verifies or creates a membership. Checking that the meta tag
 * is on the site is Prompt 17: this screen shows the token and the pending
 * state, and says plainly that the check is not automatic yet.
 */
export default function MerchantClaimScreen() {
  return (
    <MerchantAuthGate>
      <ClaimLoader />
    </MerchantAuthGate>
  );
}

function ClaimLoader() {
  const params = useLocalSearchParams<{ shopId?: string }>();
  const shopId = uuidParam(params.shopId);

  const load = useCallback(async () => {
    if (!shopId) {
      return null;
    }
    const [shop, member, openClaim] = await Promise.all([
      getPublishedShopSummary(shopId),
      isMemberOfShop(shopId),
      getMyOpenClaim(shopId),
    ]);
    return { shop, member, openClaim };
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

  const data = resource.data;
  if (!shopId || !data?.shop) {
    return (
      <Screen center>
        <EmptyState
          title="Boutique introuvable"
          description={CLAIM_MESSAGES.shop_not_found}
          actionLabel="Retour"
          onActionPress={() => router.back()}
        />
      </Screen>
    );
  }

  return (
    <ClaimContent
      shopId={shopId}
      shopName={data.shop.name}
      domain={hostOfUrl(data.shop.websiteUrl)}
      member={data.member}
      openClaimExpiresAt={data.openClaim ? data.openClaim.expiresAt : null}
      hasOpenClaim={data.openClaim !== null}
    />
  );
}

function ClaimContent({
  shopId,
  shopName,
  domain,
  member,
  hasOpenClaim,
  openClaimExpiresAt,
}: {
  shopId: string;
  shopName: string;
  domain: string | null;
  member: boolean;
  hasOpenClaim: boolean;
  openClaimExpiresAt: string | null;
}) {
  const [claim, setClaim] = useState<ClaimToken | null>(null);
  const [failure, setFailure] = useState<ClaimFailure | null>(member ? 'already_member' : null);
  const [requesting, setRequesting] = useState(false);
  const busy = useRef(false);

  const generate = async () => {
    if (busy.current) {
      return;
    }
    busy.current = true;
    setRequesting(true);
    setFailure(null);

    const outcome = await requestShopClaim(shopId).catch(() => ({ ok: false, failure: 'unknown' }) as const);

    busy.current = false;
    setRequesting(false);
    if (outcome.ok) {
      setClaim(outcome.claim);
    } else {
      setFailure(outcome.failure);
    }
  };

  const tag = claim ? claimMetaTag(claim.token) : null;
  const expiry = claim ? formatClaimDate(claim.expiresAt) : openClaimExpiresAt ? formatClaimDate(openClaimExpiresAt) : null;
  const blocked = failure === 'already_member' || failure === 'shop_already_claimed';

  return (
    <Screen scroll>
      <BackButton />

      <Text variant="title">Prouvez que cette boutique vous appartient</Text>
      <View style={styles.shop}>
        <Text variant="shopName" numberOfLines={1}>
          {shopName}
        </Text>
        {domain ? (
          <Text variant="meta" tone="secondary" numberOfLines={1}>
            {domain}
          </Text>
        ) : null}
      </View>

      {blocked ? (
        <View style={styles.section}>
          <Notice icon={failure === 'already_member' ? 'check' : 'info'}>{CLAIM_MESSAGES[failure]}</Notice>
          <Button label="Retour au profil" size="lg" fullWidth onPress={() => router.dismissTo('/profile')} />
        </View>
      ) : (
        <>
          <View style={styles.section}>
            <Text variant="body" tone="secondary">
              Ajoutez cette balise dans la page d’accueil de votre site.
            </Text>
            <NumberedSteps steps={STEPS} />
          </View>

          {hasOpenClaim && !claim ? (
            <View style={styles.section}>
              <Notice>
                {expiry
                  ? `Une demande est déjà en cours jusqu’au ${expiry}. Générer une nouvelle balise remplace la précédente.`
                  : 'Une demande est déjà en cours. Générer une nouvelle balise remplace la précédente.'}
              </Notice>
            </View>
          ) : null}

          {tag ? (
            <View style={styles.section}>
              <View style={styles.tagCard}>
                <Text variant="caption" tone="tertiary">
                  Votre balise
                </Text>
                <Text variant="meta" selectable>
                  {tag}
                </Text>
                {expiry ? (
                  <Text variant="caption" tone="tertiary">
                    Valable jusqu’au {expiry}.
                  </Text>
                ) : null}
              </View>
              <Button
                variant="secondary"
                label="Partager la balise"
                fullWidth
                onPress={() => void Share.share({ message: tag })}
              />
              <Notice>
                La vérification automatique arrive bientôt. Votre demande reste en attente d’examen.
              </Notice>
            </View>
          ) : null}

          {failure ? (
            <Text variant="meta" tone="danger" accessibilityRole="alert" style={styles.error}>
              {CLAIM_MESSAGES[failure]}
            </Text>
          ) : null}

          <Button
            label={claim || hasOpenClaim ? 'Générer une nouvelle balise' : 'Générer ma balise'}
            variant={claim ? 'text' : 'primary'}
            size="lg"
            fullWidth={!claim}
            loading={requesting}
            disabled={requesting}
            onPress={() => void generate()}
            style={styles.generate}
          />
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  shop: {
    gap: spacing.xxs,
    marginTop: spacing.md,
  },
  section: {
    gap: spacing.md,
    marginTop: layout.sectionGap,
  },
  tagCard: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radii.lg,
    borderWidth: layout.borderWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  error: {
    marginTop: spacing.lg,
  },
  generate: {
    alignSelf: 'center',
    marginTop: spacing.xxl,
  },
});
