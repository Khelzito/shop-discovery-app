import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';

import { AnalysisProgress, BackButton, MerchantAuthGate, Notice } from '@/components/merchant';
import { Button, Screen, Text, TextField } from '@/components/ui';
import {
  analyzeShopWebsite,
  findPublishedShopByHost,
  getPublishedShopSummary,
  isMemberOfShop,
  type ShopSummary,
} from '@/lib/api/merchant';
import { retryHint, type AnalysisBlockReason } from '@/lib/merchant/analysis-response';
import { addModeParam, type AddMode } from '@/lib/merchant/routes';
import { checkShopUrl, hostOfUrl } from '@/lib/merchant/url';
import { useMerchantFlow } from '@/state/merchant-flow';
import { layout, spacing } from '@/theme';

type Phase =
  | { kind: 'form' }
  | { kind: 'working' }
  | { kind: 'blocked'; submissionId: string; reason: AnalysisBlockReason; message: string }
  | { kind: 'existing'; shopId: string; shop: ShopSummary | null; member: boolean }
  | { kind: 'not_found' };

type RequestError = { message: string; sessionExpired: boolean };

export default function MerchantAddScreen() {
  return (
    <MerchantAuthGate>
      <AddContent />
    </MerchantAuthGate>
  );
}

function AddContent() {
  const params = useLocalSearchParams<{ mode?: string }>();
  const flow = useMerchantFlow();

  const [mode, setMode] = useState<AddMode>(() => addModeParam(params.mode));
  const [url, setUrl] = useState(() => flow.lastAnalysis?.websiteUrl ?? '');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<RequestError | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const busy = useRef(false);

  const showExisting = async (shopId: string) => {
    const [shop, member] = await Promise.all([
      getPublishedShopSummary(shopId).catch(() => null),
      isMemberOfShop(shopId).catch(() => false),
    ]);
    setPhase({ kind: 'existing', shopId, shop, member });
  };

  const analyze = async (checkedUrl: string, reuseSubmission: boolean) => {
    // Re-analysing inside the same flow reuses its submission rather than
    // creating a second one; the server only accepts it while still editable.
    const previous = reuseSubmission ? flow.submissionToReuse() : null;
    const result = await analyzeShopWebsite(checkedUrl, previous);

    switch (result.kind) {
      case 'analyzed':
        flow.rememberAnalysis({
          submissionId: result.submissionId,
          websiteUrl: checkedUrl,
          analysis: result.analysis,
          proposalSaved: result.proposalSaved,
        });
        setPhase({ kind: 'form' });
        router.push({
          pathname: '/merchant/review',
          params: result.proposalSaved
            ? { submissionId: result.submissionId }
            : { submissionId: result.submissionId, reason: 'not_saved' },
        });
        return;

      case 'blocked':
        flow.rememberAnalysis({
          submissionId: result.submissionId,
          websiteUrl: checkedUrl,
          analysis: null,
          proposalSaved: false,
        });
        setPhase({ kind: 'blocked', submissionId: result.submissionId, reason: result.reason, message: result.message });
        return;

      case 'shop_exists':
        await showExisting(result.shopId);
        return;

      case 'error':
        if (previous && (result.code === 'submission_locked' || result.code === 'submission_not_found')) {
          // The earlier submission was already sent: start a fresh one.
          await analyze(checkedUrl, false);
          return;
        }
        setRequestError({
          message: [result.message, retryHint(result.retryAfterSeconds)].filter(Boolean).join(' '),
          sessionExpired: result.code === 'session_expired',
        });
        setPhase({ kind: 'form' });
        return;
    }
  };

  const submit = async () => {
    if (busy.current) {
      return;
    }
    const checked = checkShopUrl(url);
    if (!checked.ok) {
      setFieldError(checked.error);
      return;
    }

    busy.current = true;
    setUrl(checked.url);
    setFieldError(null);
    setRequestError(null);
    setPhase({ kind: 'working' });

    try {
      if (mode === 'claim') {
        const shop = await findPublishedShopByHost(checked.hostname);
        if (shop) {
          await showExisting(shop.id);
        } else {
          setPhase({ kind: 'not_found' });
        }
      } else {
        await analyze(checked.url, true);
      }
    } catch {
      setRequestError({ message: 'Une erreur est survenue. Réessayez dans un instant.', sessionExpired: false });
      setPhase({ kind: 'form' });
    } finally {
      busy.current = false;
    }
  };

  const reset = () => {
    setPhase({ kind: 'form' });
    setRequestError(null);
  };

  if (phase.kind === 'working' && mode === 'analyze') {
    return (
      <Screen>
        <View style={styles.progress}>
          <AnalysisProgress />
        </View>
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <BackButton />

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Text variant="title">{mode === 'claim' ? 'Retrouvez votre boutique' : 'Ajoutez votre boutique'}</Text>
        <Text variant="body" tone="secondary" style={styles.subtitle}>
          {mode === 'claim'
            ? 'Indiquez l’adresse du site de votre boutique.'
            : 'Indiquez l’adresse de votre site. Nous préparons une proposition de fiche.'}
        </Text>

        {phase.kind === 'form' || phase.kind === 'working' ? (
          <View style={styles.form}>
            <TextField
              label="Adresse de votre site"
              value={url}
              onChangeText={(value) => {
                setUrl(value);
                setFieldError(null);
              }}
              placeholder="https://maboutique.com"
              keyboardType="url"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="url"
              textContentType="URL"
              returnKeyType="go"
              onSubmitEditing={() => void submit()}
              error={fieldError}
              editable={phase.kind === 'form'}
            />

            {requestError ? (
              <View style={styles.requestError}>
                <Text variant="meta" tone="danger">
                  {requestError.message}
                </Text>
                {requestError.sessionExpired ? (
                  <Button variant="text" label="Se reconnecter" onPress={() => router.push('/sign-in')} />
                ) : null}
              </View>
            ) : null}

            <Button
              label={mode === 'claim' ? 'Rechercher ma boutique' : 'Analyser ma boutique'}
              size="lg"
              fullWidth
              loading={phase.kind === 'working'}
              disabled={phase.kind === 'working'}
              onPress={() => void submit()}
              style={styles.submit}
            />
          </View>
        ) : null}

        {phase.kind === 'blocked' ? (
          <View style={styles.result}>
            <Notice>{phase.message}</Notice>
            <Button
              label="Saisir les informations"
              size="lg"
              fullWidth
              onPress={() =>
                router.push({
                  pathname: '/merchant/review',
                  params: { submissionId: phase.submissionId, reason: phase.reason },
                })
              }
            />
            <Button variant="text" label="Essayer une autre adresse" onPress={reset} />
          </View>
        ) : null}

        {phase.kind === 'existing' ? (
          <View style={styles.result}>
            <View style={styles.shopCard}>
              <Text variant="shopName" numberOfLines={1}>
                {phase.shop?.name ?? 'Boutique existante'}
              </Text>
              {phase.shop?.websiteUrl ? (
                <Text variant="meta" tone="secondary" numberOfLines={1}>
                  {hostOfUrl(phase.shop.websiteUrl) ?? phase.shop.websiteUrl}
                </Text>
              ) : null}
            </View>

            {phase.member ? (
              <>
                <Notice icon="check">Cette boutique est déjà associée à votre compte.</Notice>
                <Button
                  label="Retour au profil"
                  size="lg"
                  fullWidth
                  onPress={() => router.dismissTo('/profile')}
                />
              </>
            ) : (
              <>
                <Text variant="sectionTitle">Cette boutique existe déjà</Text>
                <Text variant="body" tone="secondary">
                  Si elle vous appartient, vous pouvez la revendiquer.
                </Text>
                <Button
                  label="Revendiquer cette boutique"
                  size="lg"
                  fullWidth
                  onPress={() =>
                    router.push({ pathname: '/merchant/claim/[shopId]', params: { shopId: phase.shopId } })
                  }
                />
              </>
            )}
            <Button variant="text" label="Essayer une autre adresse" onPress={reset} />
          </View>
        ) : null}

        {phase.kind === 'not_found' ? (
          <View style={styles.result}>
            <Notice>Aucune boutique référencée ne correspond à cette adresse.</Notice>
            <Button
              label="Ajouter ma boutique"
              size="lg"
              fullWidth
              onPress={() => {
                setMode('analyze');
                reset();
              }}
            />
            <Button variant="text" label="Essayer une autre adresse" onPress={reset} />
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  subtitle: {
    marginTop: spacing.sm,
  },
  form: {
    gap: spacing.md,
    marginTop: layout.sectionGap,
  },
  requestError: {
    alignItems: 'flex-start',
    gap: spacing.xxs,
  },
  submit: {
    marginTop: spacing.xs,
  },
  result: {
    alignItems: 'center',
    gap: spacing.md,
    marginTop: layout.sectionGap,
  },
  shopCard: {
    alignSelf: 'stretch',
    gap: spacing.xxs,
  },
  progress: {
    flex: 1,
    justifyContent: 'center',
  },
});
