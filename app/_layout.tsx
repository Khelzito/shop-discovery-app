import { DefaultTheme, ThemeProvider, type Theme } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { FavoritesProvider } from '@/state/favorites';
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
      <FavoritesProvider>
        <Stack
          screenOptions={{
            contentStyle: { backgroundColor: colors.background },
          }}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        </Stack>
      </FavoritesProvider>
      <StatusBar style="dark" />
    </ThemeProvider>
  );
}
