import { CLAIM_META_NAME, CLAIM_TOKEN_PATTERN, CLAIM_VERIFICATION_LIMITS } from '../../contracts/merchant-trust.ts';
import { decodeEntities } from '../site/extract.ts';

/**
 * Finds `<meta name="shop-discovery-verification" content="…">` in a home page.
 *
 * DETERMINISTIC AND LINEAR. No DOM, no script, no model. Comments and the
 * contents of elements that are never markup (script, style, template,
 * textarea, title…) are removed first, so a token quoted inside them does not
 * count. Each `<meta` is read up to its closing `>` with quotes respected and
 * a length cap, and scanning always resumes after the tag just read — a
 * hostile page cannot make the scan quadratic.
 *
 * It only READS candidates. Whether one of them is the claim's token is
 * decided in the database, by hashing each candidate and comparing with the
 * stored hash: the expected token never exists outside the claimant's hands.
 */

const IGNORED_ELEMENTS = ['script', 'style', 'template', 'textarea', 'title', 'svg', 'math', 'iframe', 'object', 'xmp', 'noembed', 'noframes'] as const;

/** A real meta tag is far shorter; anything longer is skipped. */
const MAX_TAG_CHARS = 4096;

/** Stops after this many matching tags: a page is not a list of tokens. */
const MAX_MATCHING_TAGS = 64;

const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

export type ClaimMetaScan = {
  /** Tags carrying the verification name, valid content or not. */
  metaTags: number;
  /** Distinct well-formed tokens, in document order. */
  tokens: string[];
};

export function scanClaimMeta(document: string): ClaimMetaScan {
  let html = document.replace(/<!--[\s\S]*?(?:-->|$)/g, ' ');
  for (const tag of IGNORED_ELEMENTS) {
    html = html.replace(new RegExp(`<${tag}\\b[\\s\\S]*?(?:<\\/${tag}\\s*>|$)`, 'gi'), ' ');
  }

  const tokens: string[] = [];
  let metaTags = 0;

  for (const attributes of metaAttributeStrings(html)) {
    const parsed = parseAttributes(attributes);
    if ((parsed.get('name') ?? '').trim().toLowerCase() !== CLAIM_META_NAME) {
      continue;
    }
    metaTags += 1;
    const content = decodeEntities(parsed.get('content') ?? '').trim();
    if (CLAIM_TOKEN_PATTERN.test(content) && !tokens.includes(content) && tokens.length < CLAIM_VERIFICATION_LIMITS.maxCandidates) {
      tokens.push(content);
    }
    if (metaTags >= MAX_MATCHING_TAGS) {
      break;
    }
  }

  return { metaTags, tokens };
}

/** The raw attribute text of each complete `<meta …>` tag. */
function* metaAttributeStrings(html: string): Generator<string> {
  // A fresh stateful expression per scan: lastIndex is never shared.
  const metaStart = /<meta(?=[\s/>])/gi;
  let match: RegExpExecArray | null;
  while ((match = metaStart.exec(html)) !== null) {
    const start = match.index + 5;
    const limit = Math.min(html.length, start + MAX_TAG_CHARS);
    let quote: string | null = null;
    let index = start;
    for (; index < limit; index += 1) {
      const character = html[index];
      if (quote !== null) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        break;
      }
    }
    if (index < limit && html[index] === '>') {
      yield html.slice(start, index);
    }
    // Always forward, past what was just read.
    metaStart.lastIndex = Math.max(index, start);
  }
}

function parseAttributes(raw: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of raw.matchAll(ATTRIBUTE)) {
    const name = match[1]!.toLowerCase();
    if (!attributes.has(name)) {
      attributes.set(name, match[2] ?? match[3] ?? match[4] ?? '');
    }
  }
  return attributes;
}
