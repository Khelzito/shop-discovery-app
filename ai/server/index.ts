/**
 * SERVER-ONLY AI implementation.
 *
 * Nothing here may be imported from the Expo app. ESLint enforces that, and
 * the reason is not stylistic: this half is where provider adapters and their
 * credentials will live, and Metro bundles whatever it can reach. A single
 * accidental import would ship an API key inside the app binary.
 *
 * The app imports `@/ai/contracts` and talks to the backend over HTTP.
 */
export * from './deterministic-intent.ts';
export * from './errors.ts';
export * from './persistence.ts';
export * from './providers.ts';
export * from './services.ts';
export * from './validation.ts';
