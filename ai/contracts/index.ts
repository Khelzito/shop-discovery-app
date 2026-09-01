/**
 * Client-safe AI contracts.
 *
 * Everything exported here is either a type (erased at build time) or a small
 * constant. There is no provider code, no key, no network call and no
 * dependency, so importing this from the Expo app costs nothing and leaks
 * nothing.
 *
 * The server-only half lives in `ai/server` and must never be imported from
 * `app/`, `components/`, `state/`, `lib/` or `data/`. ESLint enforces this.
 */
export * from './common';
export * from './embedding';
export * from './endpoints';
export * from './errors';
export * from './help';
export * from './model';
export * from './rerank';
export * from './search-intent';
export * from './shop-analysis';
