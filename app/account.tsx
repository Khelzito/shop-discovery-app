import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { Button, IconButton, Screen, Text, TextField } from '@/components/ui';
import { countryLabel } from '@/lib/format';
import { useAuth } from '@/state/auth';
import { layout, spacing } from '@/theme';

/** The user's own country. Editable once `profiles.country_code` exists. */
const HOME_COUNTRY = 'FR';

/**
 * Compte — identity, and the only field V1 lets the user change.
 *
 * The first name is stored in the auth user's metadata; email is read-only
 * because changing it needs a re-verification flow that V1 does not have.
 */
export default function AccountScreen() {
  const { user, updateFirstName } = useAuth();

  const [firstName, setFirstName] = useState(user?.name ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const trimmed = firstName.trim();
  const hasChanged = trimmed.length > 0 && trimmed !== (user?.name ?? '');

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);

    const result = await updateFirstName(trimmed);

    setSaving(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setSaved(true);
  };

  const confirmDeletion = () => {
    Alert.alert(
      'Suppression indisponible',
      'La suppression de compte n’est pas encore disponible. Elle arrivera dans une prochaine version.',
      [{ text: 'J’ai compris' }]
    );
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

      <Text variant="title">Compte</Text>

      <View style={styles.form}>
        <TextField
          label="Prénom"
          value={firstName}
          onChangeText={(value) => {
            setFirstName(value);
            setSaved(false);
          }}
          autoCapitalize="words"
          autoComplete="given-name"
          textContentType="givenName"
        />

        <View style={styles.readOnly}>
          <Text variant="meta" tone="secondary">
            Email
          </Text>
          <Text variant="body">{user?.email ?? '—'}</Text>
        </View>

        <View style={styles.readOnly}>
          <Text variant="meta" tone="secondary">
            Pays
          </Text>
          <Text variant="body">{countryLabel(HOME_COUNTRY)}</Text>
        </View>

        {error ? (
          <Text variant="meta" tone="danger">
            {error}
          </Text>
        ) : null}

        {saved ? (
          <Text variant="meta" tone="secondary">
            Prénom enregistré.
          </Text>
        ) : null}

        <Button
          label="Enregistrer"
          size="lg"
          fullWidth
          loading={saving}
          disabled={!hasChanged || saving}
          onPress={() => void save()}
          style={styles.save}
        />
      </View>

      <View style={styles.danger}>
        <Button variant="text" label="Supprimer mon compte" onPress={confirmDeletion} />
      </View>
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
  readOnly: {
    gap: spacing.xs,
  },
  save: {
    marginTop: spacing.xs,
  },
  danger: {
    alignItems: 'flex-start',
    marginTop: spacing.huge,
  },
});
