import { StyleSheet, View } from 'react-native';

import { Button, ImageFrame, ListRowGroup, Screen, Text } from '@/components/ui';
import { MOCK_USER } from '@/data/mock-user';
import { layout, spacing } from '@/theme';

const AVATAR_SIZE = 72;

/**
 * Profil — the consumer's account, kept deliberately bare.
 *
 * Identity, three quiet entries, a sign-out action and a secondary way into
 * the merchant experience. No statistics, no dashboard, no settings surface:
 * Shop Discovery is not a marketplace.
 *
 * The three entries and the merchant entry are pressable but lead nowhere
 * yet — their screens arrive in later phases.
 */
export default function ProfileScreen() {
  return (
    <Screen scroll>
      <Text variant="title">Profil</Text>

      <View style={styles.identity}>
        {/* No avatar upload in V1: the neutral initial is the avatar. */}
        <ImageFrame
          name={MOCK_USER.name}
          source={null}
          ratio="square"
          width={AVATAR_SIZE}
          radius="pill"
        />
        <View style={styles.identityText}>
          <Text variant="sectionTitle" numberOfLines={1}>
            {MOCK_USER.name}
          </Text>
          <Text variant="meta" tone="secondary" numberOfLines={1}>
            {MOCK_USER.email}
          </Text>
        </View>
      </View>

      <View style={styles.entries}>
        <ListRowGroup
          rows={[
            { icon: 'profile', label: 'Compte' },
            { icon: 'settings', label: 'Préférences' },
            { icon: 'help', label: 'Aide' },
          ]}
        />
      </View>

      <Button variant="text" label="Se déconnecter" style={styles.signOut} />

      <View style={styles.merchant}>
        <Text variant="meta" tone="secondary">
          Vous avez une boutique ?
        </Text>
        <Button variant="text" label="Référencer ma boutique" iconRight="chevronRight" />
      </View>
    </Screen>
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
  merchant: {
    alignItems: 'flex-start',
    gap: spacing.xxs,
    marginTop: spacing.huge,
  },
});
