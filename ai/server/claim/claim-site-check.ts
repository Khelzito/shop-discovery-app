import type { ClaimVerificationOutcome } from '../../contracts/merchant-trust.ts';
import { isPathAllowed, MAX_ROBOTS_BYTES, parseRobots } from '../site/robots.ts';
import type { RobotsPolicy } from '../site/robots.ts';
import { SAFE_FETCH_LIMITS, SafeFetchError } from '../site/safe-fetch.ts';
import type { Clock, SafeFetcher, SafeFetchErrorCode } from '../site/safe-fetch.ts';
import type { AcceptedUrl } from '../site/url-policy.ts';
import { isClaimHost } from './claim-domain.ts';
import type { ClaimTarget } from './claim-domain.ts';
import { scanClaimMeta } from './meta-token.ts';

/**
 * Reads a claimed shop's home page and returns the verification tokens on it.
 *
 * The page is fetched with the Prompt 16 safe-fetch only — pinned address,
 * runtime TLS validation, every redirect revalidated, size and time limits —
 * never with fetch(). Two rules are added on top, before EVERY hop:
 *
 *   * the hop's host must be the shop's host or its www sibling
 *     (claim-domain.ts). A redirect anywhere else stops the check: a proof
 *     served by another domain proves nothing about this one;
 *   * robots.txt is obeyed with the analyzer's fail-closed policy — an
 *     explicit Disallow is `robots_disallowed`; a robots.txt that cannot be
 *     read (5xx, timeout, TLS…) stops the check; 4xx means no rules.
 *
 * Nothing here decides whether the claim is proven: the candidates go to the
 * database, which alone knows the token's hash.
 */

export type ClaimSiteFailure = Extract<
  ClaimVerificationOutcome,
  'redirect_off_domain' | 'robots_disallowed' | 'site_unreachable' | 'timeout' | 'tls_failed' | 'too_large' | 'not_html'
>;

export type ClaimSiteCheck =
  | { kind: 'read'; finalHost: string; metaTags: number; tokens: string[] }
  /** `code` is internal and closed-vocabulary: stored with the attempt, never shown. */
  | { kind: 'failed'; outcome: ClaimSiteFailure; code: string };

export type ClaimSiteCheckDeps = { fetcher: SafeFetcher; clock?: Clock };

class OffDomainError extends Error {
  constructor() {
    super('redirect outside the claimed host');
    this.name = 'OffDomainError';
  }
}

class RobotsDisallowedError extends Error {
  constructor() {
    super('robots.txt disallows this path');
    this.name = 'RobotsDisallowedError';
  }
}

class RobotsUnavailableError extends Error {
  constructor(readonly code: SafeFetchErrorCode) {
    super(`robots.txt unavailable: ${code}`);
    this.name = 'RobotsUnavailableError';
  }
}

export async function checkClaimOnSite(
  input: { target: ClaimTarget; signal?: AbortSignal },
  deps: ClaimSiteCheckDeps
): Promise<ClaimSiteCheck> {
  const clock = deps.clock ?? { now: () => Date.now() };
  const deadline = clock.now() + SAFE_FETCH_LIMITS.timeoutMs;
  const robotsByOrigin = new Map<string, RobotsPolicy>();

  const beforeHop = async (hop: AcceptedUrl) => {
    if (hop.scheme !== 'https' || !isClaimHost(input.target, hop.hostname)) {
      throw new OffDomainError();
    }
    let policy = robotsByOrigin.get(hop.origin);
    if (policy === undefined) {
      policy = await loadRobots(deps.fetcher, hop, deadline, input.signal);
      robotsByOrigin.set(hop.origin, policy);
    }
    const parsed = new URL(hop.url);
    if (!isPathAllowed(policy, `${parsed.pathname}${parsed.search}`)) {
      throw new RobotsDisallowedError();
    }
  };

  try {
    const page = await deps.fetcher.fetch(input.target.homepageUrl, {
      acceptedMediaTypes: ['text/html'],
      accept: 'text/html',
      deadline,
      signal: input.signal,
      beforeHop,
    });
    if (!isClaimHost(input.target, page.url.hostname)) {
      return failed('redirect_off_domain', 'redirect_off_domain');
    }
    const scan = scanClaimMeta(page.text);
    return { kind: 'read', finalHost: page.url.hostname, metaTags: scan.metaTags, tokens: scan.tokens };
  } catch (error) {
    if (error instanceof OffDomainError) {
      return failed('redirect_off_domain', 'redirect_off_domain');
    }
    if (error instanceof RobotsDisallowedError) {
      return failed('robots_disallowed', 'robots_disallowed');
    }
    if (error instanceof RobotsUnavailableError) {
      return failed('site_unreachable', `robots_${error.code}`);
    }
    if (error instanceof SafeFetchError) {
      return failed(outcomeForFetchError(error.code), `fetch_${error.code}`);
    }
    throw error;
  }
}

async function loadRobots(
  fetcher: SafeFetcher,
  hop: AcceptedUrl,
  deadline: number,
  signal: AbortSignal | undefined
): Promise<RobotsPolicy> {
  try {
    const response = await fetcher.fetch(`${hop.origin}/robots.txt`, {
      acceptedMediaTypes: ['text/plain', 'text/html'],
      allowMissingContentType: true,
      accept: 'text/plain',
      maxBodyBytes: MAX_ROBOTS_BYTES,
      deadline,
      signal,
    });
    return parseRobots(response.text);
  } catch (error) {
    if (error instanceof SafeFetchError) {
      if (error.code === 'http_status' && error.status !== null && error.status >= 400 && error.status < 500) {
        return { matched: 'none', rules: [] };
      }
      throw new RobotsUnavailableError(error.code);
    }
    throw error;
  }
}

export function outcomeForFetchError(code: SafeFetchErrorCode): ClaimSiteFailure {
  switch (code) {
    case 'timeout':
    case 'aborted':
      return 'timeout';
    case 'tls_failed':
      return 'tls_failed';
    case 'headers_too_large':
    case 'body_too_large':
      return 'too_large';
    case 'content_type_not_allowed':
      return 'not_html';
    default:
      return 'site_unreachable';
  }
}

function failed(outcome: ClaimSiteFailure, code: string): ClaimSiteCheck {
  return { kind: 'failed', outcome, code };
}
