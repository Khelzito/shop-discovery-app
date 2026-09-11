import { evaluateUrl } from '../site/url-policy.ts';

/**
 * Which host a claim's proof must be served from.
 *
 * THE RULE, explicit:
 *
 *   * the shop's host, exactly as the URL policy canonicalises it — lowercase,
 *     punycode, no trailing dot, no port, no credentials;
 *   * plus its `www` sibling: `shop.fr` ↔ `www.shop.fr`. Whoever controls the
 *     zone of one controls the other, and redirecting between the two is the
 *     most common home-page setup. The sibling of `www.x` exists only when `x`
 *     still has a dot, so `www.fr` never yields `fr`;
 *   * nothing else — not the parent domain, not another subdomain, not a
 *     look-alike. A redirect anywhere outside the pair stops the check.
 *
 * The home page is always fetched over https at `/`, whatever scheme or path
 * the catalogue stores. The database applies the same rule again before it
 * accepts a proof.
 */

export type ClaimTarget = {
  /** The shop's exact host. */
  hostname: string;
  /** https://<host>/ */
  homepageUrl: string;
  allowedHosts: readonly string[];
};

export function claimTargetFor(shopWebsiteUrl: unknown): ClaimTarget | null {
  const shop = evaluateUrl(shopWebsiteUrl);
  if (!shop.ok) {
    return null;
  }
  const home = evaluateUrl(`https://${shop.hostname}/`);
  if (!home.ok) {
    return null;
  }
  return { hostname: shop.hostname, homepageUrl: home.url, allowedHosts: claimHostsOf(shop.hostname) };
}

export function claimHostsOf(hostname: string): string[] {
  if (hostname.startsWith('www.')) {
    const apex = hostname.slice(4);
    return apex.includes('.') ? [hostname, apex] : [hostname];
  }
  return [hostname, `www.${hostname}`];
}

export function isClaimHost(target: Pick<ClaimTarget, 'allowedHosts'>, hostname: string): boolean {
  return target.allowedHosts.includes(hostname);
}
