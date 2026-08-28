import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';

import { Button, IconButton, Screen, Text, TextField } from '@/components/ui';
import { useAuth } from '@/state/auth';
import { layout, spacing } from '@/theme';

/**
 * Connexion — email and password only for V1.
 */
export default function SignInScreen() {
  const { signIn, isConfigured } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = email.trim().length > 0 && password.length > 0 && !submitting;

  const submit = async () => {
    setSubmitting(true);
    setError(null);

    const result = await signIn(email, password);

    if (result.error) {
      setError(result.error);
      setSubmitting(false);
      return;
    }

    setSubmitting(false);
    router.back();
  };

  return (
    <Screen scroll>
      <IconButton
        icon="back"
        variant="bare"
        onPress={() => router.back()}
        accessibilityLabel="Retour"
        style={styles.back}
      />

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Text variant="title">Connexion</Text>

        <View style={styles.form}>
          <TextField
            label="Email"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
            autoCorrect={false}
            textContentType="emailAddress"
          />
          <TextField
            label="Mot de passe"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            autoComplete="current-password"
            textContentType="password"
            returnKeyType="go"
            onSubmitEditing={() => {
              if (canSubmit) {
                void submit();
              }
            }}
          />

          {error ? (
            <Text variant="meta" tone="danger">
              {error}
            </Text>
          ) : null}

          {!isConfigured ? (
            <Text variant="meta" tone="secondary">
              La connexion sera disponible une fois le projet Supabase configuré.
            </Text>
          ) : null}

          <Button
            label="Se connecter"
            size="lg"
            fullWidth
            loading={submitting}
            disabled={!canSubmit}
            onPress={() => void submit()}
            style={styles.submit}
          />
        </View>

        <View style={styles.actions}>
          <Button
            variant="text"
            label="Créer un compte"
            onPress={() => router.replace('/sign-up')}
          />
          <Button
            variant="text"
            label="Mot de passe oublié"
            onPress={() => setError('La récupération de mot de passe arrive bientôt.')}
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  back: {
    marginBottom: spacing.lg,
  },
  form: {
    gap: spacing.md,
    marginTop: layout.sectionGap,
  },
  submit: {
    marginTop: spacing.xs,
  },
  actions: {
    alignItems: 'flex-start',
    gap: spacing.xxs,
    marginTop: spacing.xl,
  },
});
