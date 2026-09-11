/**
 * Where the merchant flow starts and returns, and nothing else.
 *
 * Pure, so the auth guard and the post-sign-in redirect are testable. The
 * redirect after sign-in is an allow-list of one: a route parameter coming
 * back from navigation is data, and must never send a user somewhere
 * arbitrary.
 */

export const MERCHANT_WELCOME_PATH = '/merchant/welcome' as const;

export type AuthStatusLike = 'loading' | 'signedIn' | 'signedOut';

export type MerchantEntry =
  | { kind: 'wait' }
  | { kind: 'go'; pathname: typeof MERCHANT_WELCOME_PATH }
  | { kind: 'sign_in'; pathname: '/sign-in'; params: { redirect: typeof MERCHANT_WELCOME_PATH } };

/** "Référencer ma boutique": signed in goes straight in, signed out signs in first. */
export function merchantEntry(status: AuthStatusLike): MerchantEntry {
  switch (status) {
    case 'loading':
      return { kind: 'wait' };
    case 'signedIn':
      return { kind: 'go', pathname: MERCHANT_WELCOME_PATH };
    case 'signedOut':
      return { kind: 'sign_in', pathname: '/sign-in', params: { redirect: MERCHANT_WELCOME_PATH } };
  }
}

/** The post-sign-in destination, only when it is the merchant welcome screen. */
export function merchantRedirectTarget(value: unknown): typeof MERCHANT_WELCOME_PATH | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate === MERCHANT_WELCOME_PATH ? MERCHANT_WELCOME_PATH : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One route parameter as a uuid, or null. */
export function uuidParam(value: string | string[] | undefined): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === 'string' && UUID.test(candidate) ? candidate : null;
}

export type AddMode = 'analyze' | 'claim';

export function addModeParam(value: string | string[] | undefined): AddMode {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate === 'claim' ? 'claim' : 'analyze';
}

export type ManualReason = 'robots_disallowed' | 'fetch_blocked' | 'timeout' | 'unreadable' | 'not_saved';

const MANUAL_REASONS: readonly ManualReason[] = ['robots_disallowed', 'fetch_blocked', 'timeout', 'unreadable', 'not_saved'];

export function manualReasonParam(value: string | string[] | undefined): ManualReason | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return (MANUAL_REASONS as readonly unknown[]).includes(candidate) ? (candidate as ManualReason) : null;
}
