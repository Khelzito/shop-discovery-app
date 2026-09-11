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
export * from './common.ts';
export * from './embedding.ts';
export * from './endpoints.ts';
export * from './errors.ts';
export * from './help.ts';
export * from './model.ts';
export * from './rerank.ts';
export * from './search-intent.ts';
export * from './shop-analysis.ts';
export * from './shop-analysis-v2.ts';
export * from './shop-analysis-endpoint.ts';
