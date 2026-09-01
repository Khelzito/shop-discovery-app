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
export * from './deterministic-intent';
export * from './errors';
export * from './persistence';
export * from './providers';
export * from './services';
export * from './validation';
