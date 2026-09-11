import { Redirect } from 'expo-router';
import { ActivityIndicator } from 'react-native';

import { Screen } from '@/components/ui';
import { merchantEntry } from '@/lib/merchant/routes';
import { useAuth } from '@/state/auth';
import { colors } from '@/theme';

/**
 * Entry point of "Référencer ma boutique".
 *
 * Signed in: straight to the welcome screen. Signed out: sign in first, then
 * the sign-in screen sends the user to the welcome screen. There is no
 * separate merchant account — a user becomes a merchant only once a
 * shop_members row exists, which the app never creates.
 */
export default function MerchantEntryScreen() {
  const { status } = useAuth();
  const entry = merchantEntry(status);

  if (entry.kind === 'wait') {
    return (
      <Screen center>
        <ActivityIndicator color={colors.textSecondary} />
      </Screen>
    );
  }

  if (entry.kind === 'go') {
    return <Redirect href={entry.pathname} />;
  }

  return <Redirect href={{ pathname: entry.pathname, params: entry.params }} />;
}
