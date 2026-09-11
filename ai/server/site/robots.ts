/**
 * robots.txt, V1 (RFC 9309) — enough to respect a site, not a crawler engine.
 *
 * Supported: `User-agent` groups, `Allow`, `Disallow`, the `*` wildcard and
 * the `$` end anchor, longest-match precedence with Allow winning a tie.
 * Ignored on purpose: `Crawl-delay`, `Sitemap`, `Host` and anything unknown —
 * we fetch at most one page per analysis, so none of them changes a decision.
 *
 * Group selection follows the RFC: every group naming our product token
 * (`ShopDiscoveryBot`, case-insensitive) is merged; only when there is none do
 * the `*` groups apply; with neither, everything is allowed.
 *
 * What a FETCH outcome means (decided by the analyzer, documented here so the
 * rule lives next to the parser):
 *
 *   2xx               parse and obey
 *   4xx (incl. 404)   no robots.txt — allowed          (RFC 9309 §2.3.1.3)
 *   5xx, unreachable  undefined — COMPLETE DISALLOW     (RFC 9309 §2.3.1.4)
 *
 * The last line is the prudent choice asked for: when we cannot read the
 * site's rules we do not guess them, the automatic analysis stops, and the
 * merchant fills the form by hand.
 */

export const ROBOTS_PRODUCT_TOKEN = 'shopdiscoverybot';

/** RFC 9309 §2.5: parse at least 500 KiB. Anything beyond is ignored. */
export const MAX_ROBOTS_BYTES = 500 * 1024;

const MAX_RULES = 2_000;
const MAX_PATTERN_LENGTH = 2_048;

export type RobotsRule = { allow: boolean; pattern: string };

export type RobotsPolicy = {
  /** Which group applied — for tests and logs, never for the client. */
  matched: 'product_token' | 'wildcard' | 'none';
  rules: readonly RobotsRule[];
};

type Group = { agents: string[]; rules: RobotsRule[] };

export function parseRobots(text: string, productToken: string = ROBOTS_PRODUCT_TOKEN): RobotsPolicy {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.slice(0, MAX_ROBOTS_BYTES).split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const colon = line.indexOf(':');
    if (colon <= 0) {
      continue;
    }
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === 'user-agent') {
      // Consecutive User-agent lines share one group; one after a rule starts
      // a new group.
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(agentToken(value));
      lastWasAgent = true;
      continue;
    }

    if (key === 'allow' || key === 'disallow') {
      lastWasAgent = false;
      // A rule before any User-agent line belongs to no group.
      if (!current || value.length === 0 || value.length > MAX_PATTERN_LENGTH) {
        // An empty Disallow means "nothing is disallowed": no rule at all.
        continue;
      }
      if (current.rules.length < MAX_RULES) {
        current.rules.push({ allow: key === 'allow', pattern: value });
      }
      continue;
    }

    lastWasAgent = false;
  }

  const token = productToken.toLowerCase();
  const named = groups.filter((group) => group.agents.includes(token));
  if (named.length > 0) {
    return { matched: 'product_token', rules: named.flatMap((group) => group.rules) };
  }
  const wildcard = groups.filter((group) => group.agents.includes('*'));
  if (wildcard.length > 0) {
    return { matched: 'wildcard', rules: wildcard.flatMap((group) => group.rules) };
  }
  return { matched: 'none', rules: [] };
}

/** `ShopDiscoveryBot/1.0 (+info)` → `shopdiscoverybot`. */
function agentToken(value: string): string {
  const token = value.split(/[\s/]/)[0] ?? '';
  return token.toLowerCase();
}

/**
 * Whether a path (with its query) may be fetched.
 *
 * The longest matching pattern wins, Allow wins a tie, and no match means
 * allowed. `/robots.txt` itself is always allowed (RFC 9309 §2.2.2).
 */
export function isPathAllowed(policy: RobotsPolicy, pathWithQuery: string): boolean {
  const path = normalizePath(pathWithQuery);
  if (path === '/robots.txt') {
    return true;
  }

  let best: { allow: boolean; length: number } | null = null;
  for (const rule of policy.rules) {
    const pattern = normalizePath(rule.pattern);
    if (!matches(pattern, path)) {
      continue;
    }
    const length = pattern.length;
    if (
      best === null ||
      length > best.length ||
      (length === best.length && rule.allow && !best.allow)
    ) {
      best = { allow: rule.allow, length };
    }
  }
  return best === null ? true : best.allow;
}

/** Uppercases percent-escapes so `%2f` and `%2F` compare equal. */
function normalizePath(value: string): string {
  const withSlash = value.startsWith('/') || value.startsWith('*') ? value : `/${value}`;
  return withSlash.replace(/%[0-9a-f]{2}/gi, (escape) => escape.toUpperCase());
}

const compiled = new Map<string, RegExp>();

function matches(pattern: string, path: string): boolean {
  let regex = compiled.get(pattern);
  if (!regex) {
    const anchored = pattern.endsWith('$');
    const body = anchored ? pattern.slice(0, -1) : pattern;
    const source = body
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, (char) => `\\${char}`))
      .join('.*');
    regex = new RegExp(`^${source}${anchored ? '$' : ''}`);
    if (compiled.size > 5_000) {
      compiled.clear();
    }
    compiled.set(pattern, regex);
  }
  return regex.test(path);
}
