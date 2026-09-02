// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    // Build output and Expo-generated types (e.g. typed routes).
    // supabase/functions is Deno, not React Native: it uses Deno globals and
    // npm:/jsr: specifiers this config cannot resolve. It is linted and
    // type-checked by Deno's own tooling at deploy time.
    ignores: ['dist/*', '.expo/*', 'dist-test/*', 'supabase/functions/**'],
  },
  {
    // The client/server AI boundary, enforced rather than documented.
    //
    // Applied to EVERY file and then lifted only for server-side trees, so a
    // new top-level directory is covered the day it is created. Listing the
    // app directories instead would silently exempt anything added later.
    //
    // This is the second of three layers: metro.config.js blocks resolution
    // outright, and ai/server/boundary.test.ts fails the test suite if either
    // is bypassed.
    files: ['**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/ai/server', '@/ai/server/*', '**/ai/server', '**/ai/server/*'],
              message:
                'ai/server is server-only. The app must import @/ai/contracts and call the backend over HTTP.',
            },
          ],
        },
      ],
    },
  },
  {
    // Inside ai/contracts the sibling is reached as '../server', which the
    // patterns above would not match.
    files: ['ai/contracts/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../server', '../server/*', '**/ai/server', '**/ai/server/*'],
              message:
                'ai/contracts is client-safe and must never reach into ai/server.',
            },
          ],
        },
      ],
    },
  },
  {
    // The server tree is allowed to be the server tree. (supabase/functions is
    // ignored above, so it needs no exemption here.)
    files: ['ai/server/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
]);
