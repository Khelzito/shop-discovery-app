import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Share, StyleSheet, View } from 'react-native';

import { PUBLIC_VERIFICATION_LABELS } from '@/ai/contracts/merchant-trust';
import { BackButton, MerchantAuthGate, Notice, NumberedSteps } from '@/components/merchant';
import { Button, EmptyState, Icon, Screen, Text } from '@/components/ui';
import {
  getMyOpenClaim,
  getPublishedShopSummary,
  isMemberOfShop,
  requestShopClaim,
  verifyShopClaim,
} from '@/lib/api/merchant';
import { retryHint } from '@/lib/merchant/analysis-response';
import {
  CLAIM_MESSAGES,
  claimMetaTag,
  formatClaimDate,
  type ClaimFailure,
  type ClaimToken,
} from '@/lib/merchant/claim';
import type { ClaimCheckResult } from '@/lib/merchant/claim-verification';
import { uuidParam } from '@/lib/merchant/routes';
import { singleFlight } from '@/lib/merchant/submit';
import { hostOfUrl } from '@/lib/merchant/url';
import { useAsyncResource } from '@/lib/use-async-resource';
import { colors, layout, radii, spacing } from '@/theme';

const STEPS = [
  'Générez votre balise',
  'Ajoutez-la dans la page d’accueil de votre site',
  'Lancez la vérification depuis cette page',
] as const;

/** A new tag is the way forward from these. */
const NEEDS_NEW_TAG = new Set(['claim_expired', 'claim_closed', 'claim_not_found']);

/**
 * Claim — prove a listed shop is yours.
 *
 * request_shop_claim opens a PENDING claim and returns a one-time token. The
 * merchant publishes it in a meta tag, then asks verify-shop-claim to look for
 * it. The app never concludes anything itself: only the database's answer
 * turns a claim into ownership, and what it certifies is control of the
 * domain — nothing more.
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
      openClaimId={data.openClaim ? data.openClaim.id : null}
      openClaimExpiresAt={data.openClaim ? data.openClaim.expiresAt : null}
    />
  );
}

function ClaimContent({
  shopId,
  shopName,
  domain,
  member,
  openClaimId,
  openClaimExpiresAt,
}: {
  shopId: string;
  shopName: string;
  domain: string | null;
  member: boolean;
  openClaimId: string | null;
  openClaimExpiresAt: string | null;
}) {
  const [claim, setClaim] = useState<ClaimToken | null>(null);
  const [failure, setFailure] = useState<ClaimFailure | null>(member ? 'already_member' : null);
  const [requesting, setRequesting] = useState(false);
  const [check, setCheck] = useState<ClaimCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  /** One check at a time: a double tap asks the server once. */
  const [runCheck] = useState(() => singleFlight<ClaimCheckResult>());
  const busy = useRef(false);

  const claimId = claim?.claimId ?? openClaimId;

  const generate = async () => {
    if (busy.current) {
      return;
    }
    busy.current = true;
    setRequesting(true);
    setFailure(null);
    setCheck(null);

    const outcome = await requestShopClaim(shopId).catch(() => ({ ok: false, failure: 'unknown' }) as const);

    busy.current = false;
    setRequesting(false);
    if (outcome.ok) {
      setClaim(outcome.claim);
    } else {
      setFailure(outcome.failure);
    }
  };

  const verify = async () => {
    if (!claimId) {
      return;
    }
    const pending = runCheck(() => verifyShopClaim(claimId));
    if (pending === null) {
      return;
    }
    setChecking(true);
    setCheck(null);
    const result = await pending;
    setChecking(false);
    setCheck(result);
  };

  const manage = () => router.replace({ pathname: '/merchant/shop/[shopId]', params: { shopId } });

  if (check?.kind === 'verified') {
    return (
      <Screen center>
        <View style={styles.success}>
          <View style={styles.check}>
            <Icon name="check" size="lg" color={colors.icon} />
          </View>
          <Text variant="sectionTitle" align="center" accessibilityRole="header">
            {PUBLIC_VERIFICATION_LABELS.domain}
          </Text>
          <Text variant="body" tone="secondary" align="center">
            Vous gérez maintenant {shopName} sur Shop Discovery.
          </Text>
          <Button label="Gérer ma boutique" size="lg" fullWidth onPress={manage} style={styles.successAction} />
        </View>
      </Screen>
    );
  }

  const tag = claim ? claimMetaTag(claim.token) : null;
  const expiry = claim ? formatClaimDate(claim.expiresAt) : openClaimExpiresAt ? formatClaimDate(openClaimExpiresAt) : null;
  const blocked = failure === 'already_member' || failure === 'shop_already_claimed';
  const checkFailure = check?.kind === 'failed' ? check : null;

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
          {failure === 'already_member' ? (
            <Button label="Gérer ma boutique" size="lg" fullWidth onPress={manage} />
          ) : (
            <Button label="Retour au profil" size="lg" fullWidth onPress={() => router.dismissTo('/profile')} />
          )}
        </View>
      ) : (
        <>
          <View style={styles.section}>
            <Text variant="body" tone="secondary">
              Ajoutez cette balise dans la page d’accueil de votre site, puis lancez la vérification.
            </Text>
            <NumberedSteps steps={STEPS} />
          </View>

          {openClaimId && !claim ? (
            <View style={styles.section}>
              <Notice>
                {expiry
                  ? `Une demande est en cours jusqu’au ${expiry}. Si votre balise est déjà publiée, lancez la vérification. Générer une nouvelle balise remplace la précédente.`
                  : 'Une demande est en cours. Si votre balise est déjà publiée, lancez la vérification. Générer une nouvelle balise remplace la précédente.'}
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
            </View>
          ) : null}

          {claimId ? (
            <View style={styles.section}>
              <Button
                label="Vérifier ma boutique"
                size="lg"
                fullWidth
                loading={checking}
                disabled={checking || requesting}
                onPress={() => void verify()}
              />
              <Text variant="caption" tone="tertiary" align="center">
                Nous vérifions uniquement la présence de la balise sur votre domaine.
              </Text>
              {checkFailure ? (
                <View style={styles.checkFailure}>
                  <Text variant="meta" tone="danger" accessibilityRole="alert">
                    {[checkFailure.message, retryHint(checkFailure.retryAfterSeconds)].filter(Boolean).join(' ')}
                  </Text>
                  {checkFailure.reason === 'already_member' ? (
                    <Button variant="text" label="Gérer ma boutique" onPress={manage} />
                  ) : null}
                  {checkFailure.reason === 'session_expired' ? (
                    <Button variant="text" label="Se reconnecter" onPress={() => router.push('/sign-in')} />
                  ) : null}
                </View>
              ) : null}
            </View>
          ) : null}

          {failure ? (
            <Text variant="meta" tone="danger" accessibilityRole="alert" style={styles.error}>
              {CLAIM_MESSAGES[failure]}
            </Text>
          ) : null}

          <Button
            label={claimId ? 'Générer une nouvelle balise' : 'Générer ma balise'}
            variant={claimId ? 'text' : 'primary'}
            size="lg"
            fullWidth={!claimId}
            loading={requesting}
            disabled={requesting || checking}
            onPress={() => void generate()}
            style={[styles.generate, checkFailure && NEEDS_NEW_TAG.has(checkFailure.reason) ? styles.generateEmphasis : null]}
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
  checkFailure: {
    alignItems: 'flex-start',
    gap: spacing.xxs,
  },
  error: {
    marginTop: spacing.lg,
  },
  generate: {
    alignSelf: 'center',
    marginTop: spacing.xxl,
  },
  generateEmphasis: {
    marginTop: spacing.lg,
  },
  success: {
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
  successAction: {
    marginTop: spacing.xxl,
  },
});
