import { router, Stack } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { MerchantAuthGate } from '@/components/merchant';
import { Button, Icon, Screen, Text } from '@/components/ui';
import { colors, layout, radii, spacing } from '@/theme';

export default function MerchantSubmittedScreen() {
  return (
    <MerchantAuthGate>
      {/* The request is sent: swiping back to an editable form would mislead. */}
      <Stack.Screen options={{ gestureEnabled: false }} />
      <Screen center>
        <View style={styles.content}>
          <View style={styles.check}>
            <Icon name="check" size="lg" color={colors.icon} />
          </View>
          <Text variant="sectionTitle" align="center" accessibilityRole="header">
            Votre boutique a bien été envoyée
          </Text>
          <Text variant="body" tone="secondary" align="center">
            Nous allons vérifier les informations avant sa publication.
          </Text>
          <Button
            label="Retour au profil"
            size="lg"
            fullWidth
            onPress={() => router.dismissTo('/profile')}
            style={styles.action}
          />
        </View>
      </Screen>
    </MerchantAuthGate>
  );
}

const styles = StyleSheet.create({
  content: {
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
  action: {
    marginTop: spacing.xxl,
  },
});
