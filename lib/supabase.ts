// Installs a `localStorage` global backed by expo-sqlite. Must run before the
// client is created — this is the storage Supabase persists the session into.
import 'expo-sqlite/localStorage/install';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';

/**
 * Supabase client.
 *
 * Only public client configuration lives in EXPO_PUBLIC_ variables, which are
 * bundled into the app. A service-role key, an AI provider key or any other
 * privileged credential must never appear here (docs/MASTER_SPEC.md §14).
 *
 * Both key names are accepted: Supabase used to call it the anon key and now
 * shows it as the publishable key in the dashboard.
 */
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseKey =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

/**
 * Whether credentials are present. When false the app still runs — discovery
 * is entirely local — but every auth action is unavailable and says so.
 */
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseKey);

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(supabaseUrl as string, supabaseKey as string, {
      auth: {
        storage: localStorage,
        autoRefreshToken: true,
        persistSession: true,
        // No URL-based session detection: this is a native app, not a web
        // client handling an OAuth redirect.
        detectSessionInUrl: false,
      },
    })
  : null;

// Refresh tokens only while the app is in the foreground.
if (supabase) {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      void supabase.auth.startAutoRefresh();
    } else {
      void supabase.auth.stopAutoRefresh();
    }
  });
}
