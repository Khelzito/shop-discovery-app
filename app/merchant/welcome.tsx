import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { BackButton, MerchantAuthGate, NumberedSteps } from '@/components/merchant';
import { Button, Screen, Text } from '@/components/ui';
import { layout, spacing } from '@/theme';

const STEPS = ['Ajoutez votre site', 'Vérifiez les informations', 'Envoyez votre demande'] as const;

export default function MerchantWelcomeScreen() {
  return (
    <MerchantAuthGate>
      <Screen scroll>
        <BackButton />

        <Text variant="title">Faites découvrir votre boutique</Text>
        <Text variant="body" tone="secondary" style={styles.subtitle}>
          Ajoutez votre site. Notre IA prépare votre fiche, vous gardez le contrôle.
        </Text>

        <View style={styles.steps}>
          <NumberedSteps steps={STEPS} />
        </View>

        <View style={styles.actions}>
          <Button
            label="Ajouter ma boutique"
            size="lg"
            fullWidth
            onPress={() => router.push('/merchant/add')}
          />
          <Button
            variant="text"
            label="Ma boutique est déjà référencée"
            onPress={() => router.push({ pathname: '/merchant/add', params: { mode: 'claim' } })}
          />
        </View>
      </Screen>
    </MerchantAuthGate>
  );
}

const styles = StyleSheet.create({
  subtitle: {
    marginTop: spacing.sm,
  },
  steps: {
    marginTop: layout.sectionGap,
  },
  actions: {
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.huge,
  },
});
