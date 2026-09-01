import type { AiResult } from '../contracts/model';
import type { SearchIntentRequest } from '../contracts/endpoints';
import { emptySearchIntent } from '../contracts/search-intent';
import type { SearchIntent } from '../contracts/search-intent';
import type { AiRequestOptions, SearchIntentProvider } from './providers';

/**
 * Vocabulary the parser matches against, supplied by the caller.
 *
 * Injected rather than imported so this module stays free of application data
 * and of the database: the server builds it from `categories` and the country
 * list it already has, and tests build a fixture.
 */
export type IntentVocabulary = {
  categories: readonly { slug: string; terms: readonly string[] }[];
  countries: readonly { code: string; terms: readonly string[] }[];
};

const CONTRACT_VERSION = 'search-intent/1';

/**
 * The cheap tier: structured intent with no model, no network and no cost.
 *
 * Two reasons it exists before any AI does. First, docs/MASTER_SPEC.md §8
 * requires simple queries to work without AI and forbids an AI outage from
 * taking search down — this is that floor. Second, it is a working
 * implementation of `SearchIntentProvider`, which is how we know the
 * interface is usable before committing to a vendor.
 *
 * It is deliberately conservative. It only recognises phrasings with one
 * reading: "moins de 100 EUR" is a ceiling, but "autour de 100" is a
 * judgement, so it is left in the semantic query for a model tier to
 * interpret rather than guessed at here. A hard filter invented from an
 * ambiguous phrase silently hides shops, which is the one failure this
 * architecture is built to avoid.
 */
export class DeterministicSearchIntentProvider implements SearchIntentProvider {
  readonly id = 'deterministic';

  constructor(private readonly vocabulary: IntentVocabulary) {}

  async parseSearchIntent(
    request: SearchIntentRequest,
    _options?: AiRequestOptions
  ): Promise<AiResult<SearchIntent>> {
    const startedAt = Date.now();
    const intent = this.parse(request);

    return {
      data: intent,
      model: {
        provider: this.id,
        model: 'rule-based',
        modelVersion: null,
        contractVersion: CONTRACT_VERSION,
      },
      telemetry: {
        operation: 'search_intent',
        provider: this.id,
        model: 'rule-based',
        latencyMs: Date.now() - startedAt,
        outcome: 'success',
      },
    };
  }

  private parse(request: SearchIntentRequest): SearchIntent {
    const intent = emptySearchIntent(request.query, 'deterministic');
    const normalized = normalize(request.query);
    let matched = 0;

    // The app already knows where the user wants delivery; that is a fact,
    // not something to infer from the text.
    if (request.shippingCountryCode) {
      intent.hard.shippingCountryCodes = [request.shippingCountryCode.toUpperCase()];
    }
    if (request.locale) {
      intent.language = request.locale;
    }

    const price = parsePrice(normalized);
    if (price.min !== null || price.max !== null) {
      intent.hard.priceMin = price.min;
      intent.hard.priceMax = price.max;
      intent.hard.currency = price.currency;
      matched += 1;
    }

    for (const category of this.vocabulary.categories) {
      if (category.terms.some((term) => containsTerm(normalized, normalize(term)))) {
        intent.hard.categorySlugs.push(category.slug);
        matched += 1;
      }
    }

    for (const country of this.vocabulary.countries) {
      if (country.terms.some((term) => containsTerm(normalized, normalize(term)))) {
        intent.hard.countryCodes.push(country.code.toUpperCase());
        matched += 1;
      }
    }

    if (containsAny(normalized, ['verifiee', 'verifiees', 'verifie', 'verifies'])) {
      intent.hard.verifiedOnly = true;
      matched += 1;
    }

    if (containsAny(normalized, ['peu connue', 'peu connues', 'moins connue', 'confidentielle'])) {
      intent.soft.popularity = 'prefer_lesser_known';
      matched += 1;
    }

    // The whole query stays as the semantic text. Stripping the matched
    // fragments would lose the phrasing an embedding depends on, and the
    // filters are applied separately anyway.
    intent.semanticQuery = request.query.trim();

    // Confidence reflects how much was actually recognised, and stays low:
    // this tier is a floor, and a caller may reasonably escalate to a model.
    intent.confidence = matched === 0 ? 0.1 : Math.min(0.6, 0.2 + matched * 0.1);

    return intent;
  }
}

/** Lowercase, strip accents, collapse whitespace. */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Word-boundary match, so "art" does not match "partenaire". */
function containsTerm(haystack: string, term: string): boolean {
  if (term.length === 0) {
    return false;
  }
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(haystack);
}

function containsAny(haystack: string, terms: readonly string[]): boolean {
  return terms.some((term) => containsTerm(haystack, term));
}

type ParsedPrice = { min: number | null; max: number | null; currency: string | null };

/**
 * Only unambiguous budget phrasings. Anything hedged is left alone.
 */
function parsePrice(normalized: string): ParsedPrice {
  const currency = /(euros?|eur|€)/.test(normalized) ? 'EUR' : null;
  const number = '(\\d+(?:[.,]\\d+)?)';

  const between = new RegExp(`entre ${number}\\s*(?:euros?|eur|€)?\\s*et ${number}`).exec(
    normalized
  );
  if (between) {
    const min = toNumber(between[1]);
    const max = toNumber(between[2]);
    if (min !== null && max !== null && max >= min) {
      return { min, max, currency };
    }
  }

  const ceiling = new RegExp(
    `(?:moins de|max(?:imum)?|jusqu'?a|sous|en dessous de|pas plus de)\\s*${number}`
  ).exec(normalized);
  if (ceiling) {
    return { min: null, max: toNumber(ceiling[1]), currency };
  }

  const floor = new RegExp(`(?:plus de|a partir de|au moins|minimum)\\s*${number}`).exec(
    normalized
  );
  if (floor) {
    return { min: toNumber(floor[1]), max: null, currency };
  }

  return { min: null, max: null, currency: null };
}

function toNumber(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null;
  }
  const value = Number.parseFloat(raw.replace(',', '.'));
  return Number.isFinite(value) && value >= 0 ? value : null;
}
