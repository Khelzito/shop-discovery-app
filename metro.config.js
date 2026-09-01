// Learn more https://docs.expo.dev/guides/customizing-metro/
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

/**
 * Physical client/server boundary.
 *
 * `ai/server` is where AI provider adapters and their credentials will live.
 * Blocking it in the resolver means Metro cannot include those files in the
 * app bundle at all — not through `@/ai/server`, not through a relative path,
 * not through a barrel that re-exports them, and not through a dependency we
 * did not anticipate. An import simply fails to resolve at build time.
 *
 * ESLint already forbids the import, but a lint rule can be disabled inline
 * and only covers files ESLint runs on. This is the layer that does not
 * depend on anyone remembering.
 *
 * Metro tests this against absolute paths, so the separator class covers both
 * POSIX and Windows. Edge Functions run on Deno and are unaffected.
 */
const SERVER_ONLY_AI = /[\\/]ai[\\/]server[\\/]/;

const existingBlockList = config.resolver.blockList;
config.resolver.blockList = [
  ...(Array.isArray(existingBlockList)
    ? existingBlockList
    : existingBlockList
      ? [existingBlockList]
      : []),
  SERVER_ONLY_AI,
];

module.exports = config;
