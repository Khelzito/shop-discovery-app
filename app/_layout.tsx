import { DefaultTheme, Stack, ThemeProvider, type Theme } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { AuthProvider } from '@/state/auth';
import { FavoritesProvider } from '@/state/favorites';
import { PreferencesProvider } from '@/state/preferences';
import { colors } from '@/theme';

export const unstable_settings = {
  anchor: '(tabs)',
};

/**
 * V1 is light-mode only (docs/MASTER_SPEC.md §3), so there is a single
 * navigation theme mapped onto the design tokens.
 */
const navigationTheme: Theme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    primary: colors.actionPrimary,
    background: colors.background,
    card: colors.surface,
    text: colors.textPrimary,
    border: colors.border,
    notification: colors.danger,
  },
};

export default function RootLayout() {
  return (
    <ThemeProvider value={navigationTheme}>
      <AuthProvider>
        <PreferencesProvider>
          <FavoritesProvider>
            <Stack
              screenOptions={{
                contentStyle: { backgroundColor: colors.background },
              }}>
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen name="shop/[id]" options={{ headerShown: false }} />
              <Stack.Screen name="sign-in" options={{ headerShown: false }} />
              <Stack.Screen name="sign-up" options={{ headerShown: false }} />
              <Stack.Screen name="account" options={{ headerShown: false }} />
              <Stack.Screen name="preferences" options={{ headerShown: false }} />
              <Stack.Screen name="assistant" options={{ headerShown: false }} />
              <Stack.Screen name="help/index" options={{ headerShown: false }} />
              <Stack.Screen name="help/[topic]" options={{ headerShown: false }} />
              <Stack.Screen name="merchant" options={{ headerShown: false }} />
              <Stack.Screen name="admin" options={{ headerShown: false }} />
              <Stack.Screen name="report/[shopId]" options={{ headerShown: false }} />
            </Stack>
          </FavoritesProvider>
        </PreferencesProvider>
      </AuthProvider>
      <StatusBar style="dark" />
    </ThemeProvider>
  );
}
