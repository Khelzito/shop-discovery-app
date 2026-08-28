import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';

import { Button, IconButton, Screen, Text, TextField } from '@/components/ui';
import { useAuth } from '@/state/auth';
import { layout, spacing } from '@/theme';

/**
 * Créer un compte — first name, email and password.
 *
 * The first name is stored in the auth user's metadata so Profil can greet the
 * user before the `profiles` table exists.
 */
export default function SignUpScreen() {
  const { signUp, isConfigured } = useAuth();
  const [firstName, setFirstName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const canSubmit =
    firstName.trim().length > 0 && email.trim().length > 0 && password.length > 0 && !submitting;

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    setNotice(null);

    const result = await signUp(firstName, email, password);

    if (result.error) {
      setError(result.error);
      setSubmitting(false);
      return;
    }

    setSubmitting(false);

    if (result.needsEmailConfirmation) {
      setNotice('Compte créé. Confirme ton email, puis connecte-toi.');
      return;
    }

    // The session is live; the auth listener has already updated the app.
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
        <Text variant="title">Créer un compte</Text>

        <View style={styles.form}>
          <TextField
            label="Prénom"
            value={firstName}
            onChangeText={setFirstName}
            autoCapitalize="words"
            autoComplete="given-name"
            textContentType="givenName"
          />
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
            autoComplete="new-password"
            textContentType="newPassword"
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

          {notice ? (
            <Text variant="meta" tone="secondary">
              {notice}
            </Text>
          ) : null}

          {!isConfigured ? (
            <Text variant="meta" tone="secondary">
              La création de compte sera disponible une fois le projet Supabase configuré.
            </Text>
          ) : null}

          <Button
            label="Créer mon compte"
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
            label="J’ai déjà un compte"
            onPress={() => router.replace('/sign-in')}
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
    marginTop: spacing.xl,
  },
});
