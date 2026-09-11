import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Button, ImageFrame, ListRowGroup, Screen, Skeleton, Text } from '@/components/ui';
import { useAuth } from '@/state/auth';
import { layout, spacing } from '@/theme';

const AVATAR_SIZE = 72;

/**
 * Profil — the consumer's account, kept deliberately bare.
 *
 * Signed in: identity from the session, three quiet entries, sign out.
 * Signed out: a calm way in, nothing else. No statistics, no dashboard, no
 * settings surface — Shop Discovery is not a marketplace.
 *
 * The three entries and the merchant entry lead nowhere yet; their screens
 * arrive in later phases.
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
