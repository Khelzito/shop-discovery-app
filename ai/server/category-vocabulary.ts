/**
 * Maps natural category vocabulary onto the catalogue's real slugs.
 *
 * Two problems this solves, both of which silently removed a hard constraint
 * before it existed:
 *
 *   1. A near-miss from the model — the label "Sneakers" instead of the slug
 *      "sneakers", or a plural, or an accent — was dropped by an exact-match
 *      whitelist. The user saw every French shop instead of the one they asked
 *      for, with nothing in any log to say why.
 *   2. A user writing "baskets" or "chaussures" means the `sneakers` category,
 *      and no amount of prompting makes a model guess our slug spelling
 *      reliably.
 *
 * The resolver is built FROM the live taxonomy, so it can only ever return a
 * slug that exists in the database. Aliases for a slug that is not in the
 * catalogue are ignored: this normalises vocabulary, it never invents a
 * category.
 */

/**
 * Natural-language terms per canonical slug.
 *
 * Only entries whose slug exists in the passed taxonomy are used. Terms are
 * matched on word boundaries after accent-stripping, so "basket" does not
 * match inside "basketball-adjacent" prose and "mode" does not match
 * "modelisme".
 */
const CATEGORY_ALIASES: Record<string, readonly string[]> = {
  mode: [
    'mode', 'vetement', 'vetements', 'habillement', 'pret a porter', 'pret-a-porter',
    'fringues', 'clothing', 'clothes', 'apparel', 'fashion', 'garments', 'wear',
  ],
  sneakers: [
    'sneakers', 'sneaker', 'basket', 'baskets', 'chaussure', 'chaussures',
    'souliers', 'soulier', 'trainers', 'shoes', 'footwear', 'kicks',
  ],
  bijoux: [
    'bijoux', 'bijou', 'joaillerie', 'bague', 'bagues', 'collier', 'colliers',
    'bracelet', 'bracelets', 'jewellery', 'jewelry', 'jewels',
  ],
  beaute: [
    'beaute', 'cosmetique', 'cosmetiques', 'maquillage', 'soin', 'soins',
    'parfum', 'parfums', 'beauty', 'skincare', 'makeup', 'cosmetics', 'fragrance',
  ],
  maison: [
    'maison', 'deco', 'decoration', 'interieur', 'mobilier', 'meuble', 'meubles',
    'home', 'homeware', 'furniture', 'interior', 'decor',
  ],
  tech: [
    'tech', 'technologie', 'electronique', 'audio', 'hifi', 'casque', 'casques',
    'gadget', 'gadgets', 'electronics', 'technology', 'headphones',
  ],
  sport: [
    'sport', 'sports', 'sportswear', 'fitness', 'running', 'outdoor',
    'athletique', 'activewear', 'training',
  ],
};

export type CategoryTaxonomy = readonly { slug: string; name: string }[];

export type CategoryResolver = {
  /** Every slug the catalogue actually has. */
  readonly slugs: readonly string[];
  /**
   * Maps candidates — slugs, display names, plurals, aliases — onto real
   * slugs. Anything unrecognised is dropped, so a hallucinated category can
   * never reach a query.
   */
  resolve: (candidates: readonly string[]) => string[];
  /**
   * Finds category terms stated outright in a query.
   *
   * Used only as a rescue when the model returned nothing: a concrete product
   * noun that maps unambiguously to a real category is a factual constraint,
   * not a judgement, so failing to apply it is a bug rather than caution.
   * Subjective words are absent from the alias table by construction, so this
   * cannot promote "chic" or "quiet luxury" into a filter.
   */
  detect: (text: string) => string[];
  /** Terms per slug, for the deterministic tier to share one vocabulary. */
  termsFor: (slug: string) => string[];
};

export function buildCategoryResolver(taxonomy: CategoryTaxonomy): CategoryResolver {
  const slugs = taxonomy.map((category) => category.slug);
  const known = new Set(slugs);

  // term -> slug. Built only from taxonomy entries, so an alias for a category
  // the catalogue does not have is never reachable.
  const byTerm = new Map<string, string>();
  const termsBySlug = new Map<string, string[]>();

  for (const category of taxonomy) {
    const terms = new Set<string>([
      normalizeTerm(category.slug),
      normalizeTerm(category.name),
      ...(CATEGORY_ALIASES[category.slug] ?? []).map(normalizeTerm),
    ]);
    terms.delete('');
    termsBySlug.set(category.slug, [...terms]);
    for (const term of terms) {
      // First taxonomy entry wins, so an alias shared by two categories stays
      // deterministic rather than depending on iteration order.
      if (!byTerm.has(term)) {
        byTerm.set(term, category.slug);
      }
    }
  }

  return {
    slugs,

    resolve(candidates) {
      const resolved: string[] = [];
      for (const candidate of candidates) {
        if (typeof candidate !== 'string') {
          continue;
        }
        // An exact slug is the common case and must stay exact.
        if (known.has(candidate)) {
          pushUnique(resolved, candidate);
          continue;
        }
        const match = byTerm.get(normalizeTerm(candidate));
        if (match !== undefined) {
          pushUnique(resolved, match);
        }
      }
      return resolved;
    },

    detect(text) {
      const haystack = normalizeTerm(text);
      const found: string[] = [];
      for (const [term, slug] of byTerm) {
        if (containsWord(haystack, term)) {
          pushUnique(found, slug);
        }
      }
      // Stable order, independent of Map insertion.
      return found.sort((a, b) => slugs.indexOf(a) - slugs.indexOf(b));
    },

    termsFor(slug) {
      return termsBySlug.get(slug) ?? [];
    },
  };
}

/** Lowercase, strip accents, collapse whitespace, drop a trailing plural. */
export function normalizeTerm(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Word-boundary match, so "mode" does not match inside "modelisme". */
export function containsWord(haystack: string, term: string): boolean {
  if (term.length === 0) {
    return false;
  }
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^| )${escaped}( |$)`).test(haystack);
}

function pushUnique(target: string[], value: string): void {
  if (!target.includes(value)) {
    target.push(value);
  }
}
