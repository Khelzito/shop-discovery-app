import { router, Stack } from 'expo-router';
import { useCallback } from 'react';
import { ActivityIndicator } from 'react-native';

import { EmptyState, Screen } from '@/components/ui';
import { isAppModerator } from '@/lib/api/moderation';
import { useAsyncResource } from '@/lib/use-async-resource';
import { useAuth } from '@/state/auth';
import { colors } from '@/theme';

/**
 * Moderation. Not in the tab bar, and shown in the profile only to accounts
 * the database recognises as moderators.
 *
 * This guard is a courtesy, not the boundary: every moderation call is checked
 * again by its SECURITY DEFINER function, so a user who reached these screens
 * some other way would see nothing and could change nothing.
 */
export default function AdminLayout() {
  const { status } = useAuth();
  const load = useCallback(() => (status === 'signedIn' ? isAppModerator() : Promise.resolve(false)), [status]);
  const resource = useAsyncResource(load);

  if (status === 'loading' || resource.status === 'loading') {
    return (
      <Screen center>
        <ActivityIndicator color={colors.textSecondary} />
      </Screen>
    );
  }

  if (status === 'signedOut') {
    return (
      <Screen center>
        <EmptyState
          icon="profile"
          title="Connectez-vous pour continuer"
          actionLabel="Se connecter"
          onActionPress={() => router.push('/sign-in')}
        />
      </Screen>
    );
  }

  if (resource.status === 'error' || resource.data !== true) {
    return (
      <Screen center>
        <EmptyState
          icon="shield"
          title="Accès réservé"
          description="Cette section est réservée à l’équipe de modération."
          actionLabel="Retour"
          onActionPress={() => (router.canGoBack() ? router.back() : router.replace('/profile'))}
        />
      </Screen>
    );
  }

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.background },
      }}
    />
  );
}
