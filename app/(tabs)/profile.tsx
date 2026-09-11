import { router } from 'expo-router';
import { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';

import { StatusRow } from '@/components/merchant';
import { Button, ImageFrame, ListRowGroup, Screen, Skeleton, Text } from '@/components/ui';
import { getMyShops, getMySubmissions } from '@/lib/api/merchant';
import { isAppModerator } from '@/lib/api/moderation';
import { SHOP_STATUS_LABELS } from '@/lib/merchant/management';
import { submissionStatusView, submissionTitle } from '@/lib/merchant/submissions';
import { useFocusResource } from '@/lib/use-focus-resource';
import { useAuth } from '@/state/auth';
import { layout, spacing } from '@/theme';

const AVATAR_SIZE = 72;
const MAX_REQUESTS_SHOWN = 5;

/**
 * Profil — the consumer's account, kept deliberately bare.
 *
 * Signed in: identity from the session, three quiet entries, sign out. A
 * merchant also finds their shops and the state of their requests here, in
 * words — no dashboard, no numbers. Signed out: a calm way in, nothing else.
 */
export default function ProfileScreen() {
  const { status, user, signOut } = useAuth();

  return (
    <Screen scroll>
      <Text variant="title">Profil</Text>

      {status === 'loading' ? <IdentitySkeleton /> : null}

      {status === 'signedIn' && user ? (
        <>
          <View style={styles.identity}>
            {/* No avatar upload in V1: the neutral initial is the avatar. */}
            <ImageFrame
              name={user.name}
              source={null}
              ratio="square"
              width={AVATAR_SIZE}
              radius="pill"
            />
            <View style={styles.identityText}>
              <Text variant="sectionTitle" numberOfLines={1}>
                {user.name}
              </Text>
              <Text variant="meta" tone="secondary" numberOfLines={1}>
                {user.email}
              </Text>
            </View>
          </View>

          <View style={styles.entries}>
            <ListRowGroup
              rows={[
                { icon: 'profile', label: 'Compte', onPress: () => router.push('/account') },
                {
                  icon: 'settings',
                  label: 'Préférences',
                  onPress: () => router.push('/preferences'),
                },
                { icon: 'help', label: 'Aide', onPress: () => router.push('/help') },
              ]}
            />
          </View>

          <MerchantActivity />

          <Button
            variant="text"
            label="Se déconnecter"
            onPress={() => void signOut()}
            style={styles.signOut}
          />
        </>
      ) : null}

      {status === 'signedOut' ? (
        <View style={styles.signedOut}>
          <Text variant="body" tone="secondary">
            Connecte-toi pour retrouver tes boutiques sur tous tes appareils.
          </Text>
          <Button
            label="Se connecter"
            size="lg"
            fullWidth
            onPress={() => router.push('/sign-in')}
            style={styles.signIn}
          />
          <Button
            variant="text"
            label="Créer un compte"
            onPress={() => router.push('/sign-up')}
          />
        </View>
      ) : null}

      <View style={styles.merchant}>
        <Text variant="meta" tone="secondary">
          Vous avez une boutique ?
        </Text>
        <Button
          variant="text"
          label="Référencer ma boutique"
          iconRight="chevronRight"
          onPress={() => router.push('/merchant')}
        />
      </View>
    </Screen>
  );
}

/**
 * The merchant's shops and requests, refreshed each time the profile is shown.
 * Quiet by design: nothing while loading, nothing on failure, nothing when the
 * user has no shop and no request.
 */
function MerchantActivity() {
  const load = useCallback(async () => {
    const [submissions, shops, moderator] = await Promise.all([getMySubmissions(), getMyShops(), isAppModerator()]);
    return { submissions, shops, moderator };
  }, []);
  const resource = useFocusResource(load);

  if (resource.status !== 'ready') {
    return null;
  }

  const { shops, moderator } = resource.data;
  const managed = new Set(shops.map((shop) => shop.shopId));
  // An approved request is represented by its shop once the shop is listed.
  const requests = resource.data.submissions
    .filter((submission) => !(submission.status === 'approved' && submission.shopId !== null && managed.has(submission.shopId)))
    .slice(0, MAX_REQUESTS_SHOWN);

  return (
    <>
      {shops.length > 0 ? (
        <View style={styles.section}>
          <Text variant="sectionTitle">Mes boutiques</Text>
          <View>
            {shops.map((shop, index) => (
              <StatusRow
                key={shop.shopId}
                title={shop.name}
                meta={shop.host}
                status={SHOP_STATUS_LABELS[shop.status] ?? null}
                separator={index < shops.length - 1}
                onPress={() => router.push({ pathname: '/merchant/shop/[shopId]', params: { shopId: shop.shopId } })}
              />
            ))}
          </View>
        </View>
      ) : null}

      {requests.length > 0 ? (
        <View style={styles.section}>
          <Text variant="sectionTitle">Mes demandes</Text>
          <View>
            {requests.map((request, index) => (
              <StatusRow
                key={request.id}
                title={submissionTitle(request)}
                meta={request.proposedName ? request.host : null}
                status={submissionStatusView(request.status)?.label ?? null}
                separator={index < requests.length - 1}
                onPress={() => router.push({ pathname: '/merchant/submissions/[id]', params: { id: request.id } })}
              />
            ))}
          </View>
        </View>
      ) : null}

      {moderator ? (
        <View style={styles.section}>
          <ListRowGroup rows={[{ icon: 'shield', label: 'Modération', onPress: () => router.push('/admin/submissions') }]} />
        </View>
      ) : null}
    </>
  );
}

function IdentitySkeleton() {
  return (
    <View style={styles.identity}>
      <Skeleton width={AVATAR_SIZE} height={AVATAR_SIZE} radius="pill" />
      <View style={styles.identityText}>
        <Skeleton width="55%" height={20} />
        <Skeleton width="70%" height={13} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.xl,
  },
  identityText: {
    flex: 1,
    gap: spacing.xxs,
  },
  entries: {
    marginTop: layout.sectionGap,
  },
  section: {
    gap: spacing.xs,
    marginTop: layout.sectionGap,
  },
  signOut: {
    alignSelf: 'flex-start',
    marginTop: spacing.xl,
  },
  signedOut: {
    alignItems: 'flex-start',
    marginTop: spacing.xl,
    gap: spacing.md,
  },
  signIn: {
    marginTop: spacing.xs,
  },
  merchant: {
    alignItems: 'flex-start',
    gap: spacing.xxs,
    marginTop: spacing.huge,
  },
});
