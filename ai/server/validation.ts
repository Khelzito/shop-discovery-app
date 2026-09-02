import { AUDIENCES, POPULARITY_PREFERENCES, PRICE_POSITIONINGS } from '../contracts/common.ts';
import type { Audience, PopularityPreference, PricePositioning } from '../contracts/common.ts';
import { EMBEDDING_SOURCE_KINDS } from '../contracts/embedding.ts';
import type { EmbeddingResult } from '../contracts/embedding.ts';
import type { HelpAnswer, HelpSource } from '../contracts/help.ts';
import { HELP_REFUSAL_REASONS } from '../contracts/help.ts';
import type { ModelMetadata } from '../contracts/model.ts';
import type { RerankResult } from '../contracts/rerank.ts';
import type { SearchIntentRequest } from '../contracts/endpoints.ts';
import { INTENT_SOURCES } from '../contracts/search-intent.ts';
import type { SearchIntent } from '../contracts/search-intent.ts';
import type {
  ShopAnalysis,
  ShopAnalysisField,
  SuggestedCategory,
  SuggestedTag,
} from '../contracts/shop-analysis.ts';
import { SHOP_ANALYSIS_FIELDS } from '../contracts/shop-analysis.ts';

/**
 * Runtime validation of model output.
 *
 * TypeScript vanishes at build time, so a model returning `{"priceMax":
 * "cheap"}` or a confidence of 7 would otherwise flow straight into SQL. Every
 * structured AI response passes through here first, and anything that does not
 * match is rejected rather than repaired into something plausible.
 *
 * Written by hand rather than with a schema library, on purpose:
 *
 *   * It runs server-side only, so a library would buy the client nothing.
 *   * It has zero dependencies, so the exact same file runs unchanged under
 *     Node, Metro and the Deno runtime Edge Functions use — no import map, no
 *     duplicated schema, no version skew between two runtimes.
 *   * There are five schemas and they are stable. The cost of a dependency is
 *     paid forever; the cost of these ~400 lines is paid once.
 *
 * If the schema count grows substantially, or per-field error paths become
 * important to a merchant-facing UI, Zod becomes the better trade and this
 * file is small enough to replace wholesale.
 */

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: string[] };

function ok<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

function fail<T>(issues: string[]): ValidationResult<T> {
  return { ok: false, issues };
}

// ---------------------------------------------------------------------------
// Primitive readers
//
// Each returns a usable value and pushes a path-prefixed issue when the input
// is wrong, so one pass collects every problem instead of stopping at the
// first.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(
  source: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[],
  options: { maxLength?: number } = {}
): string {
  const value = source[key];
  if (typeof value !== 'string') {
    issues.push(`${path}: expected string, received ${describe(value)}`);
    return '';
  }
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    issues.push(`${path}: longer than ${options.maxLength} characters`);
    return value.slice(0, options.maxLength);
  }
  return value;
}

function readNullableString(
  source: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[]
): string | null {
  const value = source[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    issues.push(`${path}: expected string or null, received ${describe(value)}`);
    return null;
  }
  return value;
}

function readBoolean(
  source: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[]
): boolean {
  const value = source[key];
  if (typeof value !== 'boolean') {
    issues.push(`${path}: expected boolean, received ${describe(value)}`);
    return false;
  }
  return value;
}

/** Rejects NaN and Infinity, which JSON.parse happily produces via strings. */
function readNullableNumber(
  source: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[],
  options: { min?: number } = {}
): number | null {
  const value = source[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push(`${path}: expected finite number or null, received ${describe(value)}`);
    return null;
  }
  if (options.min !== undefined && value < options.min) {
    issues.push(`${path}: must be >= ${options.min}`);
    return null;
  }
  return value;
}

function readConfidence(
  source: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[]
): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push(`${path}: expected number, received ${describe(value)}`);
    return 0;
  }
  if (value < 0 || value > 1) {
    issues.push(`${path}: confidence must be within [0, 1], received ${value}`);
    return 0;
  }
  return value;
}

function readStringArray(
  source: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[],
  options: { maxItems?: number } = {}
): string[] {
  const value = source[key];
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    issues.push(`${path}: expected array, received ${describe(value)}`);
    return [];
  }
  const result: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== 'string') {
      issues.push(`${path}[${index}]: expected string, received ${describe(item)}`);
      return;
    }
    const trimmed = item.trim();
    if (trimmed.length > 0) {
      result.push(trimmed);
    }
  });
  if (options.maxItems !== undefined && result.length > options.maxItems) {
    issues.push(`${path}: at most ${options.maxItems} items, received ${result.length}`);
    return result.slice(0, options.maxItems);
  }
  return result;
}

function readEnum<T extends string>(
  source: Record<string, unknown>,
  key: string,
  path: string,
  allowed: readonly T[],
  issues: string[],
  fallback: T
): T {
  const value = source[key];
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    issues.push(`${path}: expected one of ${allowed.join(' | ')}, received ${describe(value)}`);
    return fallback;
  }
  return value as T;
}

function readEnumArray<T extends string>(
  source: Record<string, unknown>,
  key: string,
  path: string,
  allowed: readonly T[],
  issues: string[]
): T[] {
  const raw = readStringArray(source, key, path, issues);
  const result: T[] = [];
  raw.forEach((item, index) => {
    if (!allowed.includes(item as T)) {
      issues.push(`${path}[${index}]: expected one of ${allowed.join(' | ')}, received "${item}"`);
      return;
    }
    result.push(item as T);
  });
  return result;
}

/** Uppercases and checks shape, so the value satisfies the database domain. */
function readCodeArray(
  source: Record<string, unknown>,
  key: string,
  path: string,
  length: number,
  issues: string[]
): string[] {
  const raw = readStringArray(source, key, path, issues);
  const result: string[] = [];
  raw.forEach((item, index) => {
    const upper = item.toUpperCase();
    if (!new RegExp(`^[A-Z]{${length}}$`).test(upper)) {
      issues.push(`${path}[${index}]: expected ${length} letters, received "${item}"`);
      return;
    }
    result.push(upper);
  });
  return result;
}

function readNested(
  source: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[]
): Record<string, unknown> {
  const value = source[key];
  if (!isRecord(value)) {
    issues.push(`${path}: expected object, received ${describe(value)}`);
    return {};
  }
  return value;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function readSuggestions(
  source: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[]
): { slug: string; confidence: number }[] {
  const value = source[key];
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    issues.push(`${path}: expected array, received ${describe(value)}`);
    return [];
  }
  const result: { slug: string; confidence: number }[] = [];
  value.forEach((item, index) => {
    if (!isRecord(item)) {
      issues.push(`${path}[${index}]: expected object, received ${describe(item)}`);
      return;
    }
    const itemIssues: string[] = [];
    const slug = readString(item, 'slug', `${path}[${index}].slug`, itemIssues);
    const confidence = readConfidence(
      item,
      'confidence',
      `${path}[${index}].confidence`,
      itemIssues
    );
    if (itemIssues.length > 0) {
      issues.push(...itemIssues);
      return;
    }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
      issues.push(`${path}[${index}].slug: not a valid slug ("${slug}")`);
      return;
    }
    result.push({ slug, confidence });
  });
  return result;
}

// ---------------------------------------------------------------------------
// Inbound request
// ---------------------------------------------------------------------------

/** Matches the `searches.query_text` CHECK constraint, so a stored row cannot fail. */
export const MAX_SEARCH_QUERY_LENGTH = 500;

/**
 * Validates what a client sent, before anything else happens.
 *
 * Lives here rather than in the Edge Function so the rules are exercised by
 * the Node test suite: an Edge Function needs Deno to run, and untested input
 * validation on a public endpoint is exactly the wrong thing to leave
 * unverified.
 */
export function validateSearchIntentRequest(input: unknown): ValidationResult<SearchIntentRequest> {
  if (!isRecord(input)) {
    return fail([`request: expected a JSON object, received ${describe(input)}`]);
  }

  const rawQuery = input.query;
  if (typeof rawQuery !== 'string') {
    return fail([`request.query: expected string, received ${describe(rawQuery)}`]);
  }

  const query = rawQuery.trim();
  if (query.length === 0) {
    return fail(['request.query: must not be empty']);
  }
  if (rawQuery.length > MAX_SEARCH_QUERY_LENGTH) {
    return fail([`request.query: longer than ${MAX_SEARCH_QUERY_LENGTH} characters`]);
  }

  const issues: string[] = [];
  const request: SearchIntentRequest = { query };

  if (input.locale !== undefined && input.locale !== null) {
    const locale = readString(input, 'locale', 'request.locale', issues);
    if (!/^[a-z]{2}$/.test(locale)) {
      issues.push('request.locale: expected a two-letter language code');
    } else {
      request.locale = locale;
    }
  }

  if (input.shippingCountryCode !== undefined && input.shippingCountryCode !== null) {
    const code = readString(input, 'shippingCountryCode', 'request.shippingCountryCode', issues);
    if (!/^[A-Za-z]{2}$/.test(code)) {
      issues.push('request.shippingCountryCode: expected a two-letter country code');
    } else {
      request.shippingCountryCode = code.toUpperCase();
    }
  }

  if (issues.length > 0) {
    return fail(issues);
  }
  return ok(request);
}

// ---------------------------------------------------------------------------
// SearchIntent
// ---------------------------------------------------------------------------

export function validateSearchIntent(input: unknown): ValidationResult<SearchIntent> {
  if (!isRecord(input)) {
    return fail([`intent: expected object, received ${describe(input)}`]);
  }
  const issues: string[] = [];

  const originalQuery = readString(input, 'originalQuery', 'intent.originalQuery', issues, {
    maxLength: 500,
  });
  const language = readNullableString(input, 'language', 'intent.language', issues);
  const semanticQuery = readString(input, 'semanticQuery', 'intent.semanticQuery', issues, {
    maxLength: 500,
  });

  const hardRaw = readNested(input, 'hard', 'intent.hard', issues);
  const priceMin = readNullableNumber(hardRaw, 'priceMin', 'intent.hard.priceMin', issues, {
    min: 0,
  });
  const priceMax = readNullableNumber(hardRaw, 'priceMax', 'intent.hard.priceMax', issues, {
    min: 0,
  });
  if (priceMin !== null && priceMax !== null && priceMax < priceMin) {
    issues.push('intent.hard: priceMax must be >= priceMin');
  }
  const currencyList = readCodeArray(
    { currency: hardRaw.currency === null || hardRaw.currency === undefined ? [] : [hardRaw.currency] },
    'currency',
    'intent.hard.currency',
    3,
    issues
  );

  const hard = {
    categorySlugs: readStringArray(hardRaw, 'categorySlugs', 'intent.hard.categorySlugs', issues, {
      maxItems: 10,
    }),
    audiences: readEnumArray<Audience>(
      hardRaw,
      'audiences',
      'intent.hard.audiences',
      AUDIENCES,
      issues
    ),
    countryCodes: readCodeArray(hardRaw, 'countryCodes', 'intent.hard.countryCodes', 2, issues),
    shippingCountryCodes: readCodeArray(
      hardRaw,
      'shippingCountryCodes',
      'intent.hard.shippingCountryCodes',
      2,
      issues
    ),
    priceMin,
    priceMax,
    currency: currencyList[0] ?? null,
    verifiedOnly: readBoolean(hardRaw, 'verifiedOnly', 'intent.hard.verifiedOnly', issues),
  };

  const softRaw = readNested(input, 'soft', 'intent.soft', issues);
  const brandPositioningRaw = softRaw.brandPositioning;
  const soft = {
    styles: readStringArray(softRaw, 'styles', 'intent.soft.styles', issues, { maxItems: 10 }),
    productTypes: readStringArray(softRaw, 'productTypes', 'intent.soft.productTypes', issues, {
      maxItems: 10,
    }),
    values: readStringArray(softRaw, 'values', 'intent.soft.values', issues, { maxItems: 10 }),
    brandPositioning:
      brandPositioningRaw === null || brandPositioningRaw === undefined
        ? null
        : readEnum<PricePositioning>(
            softRaw,
            'brandPositioning',
            'intent.soft.brandPositioning',
            PRICE_POSITIONINGS,
            issues,
            'unknown'
          ),
    popularity: readEnum<PopularityPreference>(
      softRaw,
      'popularity',
      'intent.soft.popularity',
      POPULARITY_PREFERENCES,
      issues,
      'any'
    ),
  };

  const confidence = readConfidence(input, 'confidence', 'intent.confidence', issues);
  const source = readEnum(input, 'source', 'intent.source', INTENT_SOURCES, issues, 'model');

  if (issues.length > 0) {
    return fail(issues);
  }

  return ok({ originalQuery, language, semanticQuery, hard, soft, confidence, source });
}

// ---------------------------------------------------------------------------
// ShopAnalysis
// ---------------------------------------------------------------------------

export function validateShopAnalysis(input: unknown): ValidationResult<ShopAnalysis> {
  if (!isRecord(input)) {
    return fail([`analysis: expected object, received ${describe(input)}`]);
  }
  const issues: string[] = [];

  const summary = readNullableString(input, 'summary', 'analysis.summary', issues);
  if (summary !== null && summary.length > 2000) {
    issues.push('analysis.summary: longer than 2000 characters');
  }

  const suggestedCategories = readSuggestions(
    input,
    'suggestedCategories',
    'analysis.suggestedCategories',
    issues
  ) as SuggestedCategory[];
  const suggestedTags = readSuggestions(
    input,
    'suggestedTags',
    'analysis.suggestedTags',
    issues
  ) as SuggestedTag[];

  const visualIdentityRaw = input.visualIdentity;
  let visualIdentity: ShopAnalysis['visualIdentity'] = null;
  if (visualIdentityRaw !== null && visualIdentityRaw !== undefined) {
    const nested = readNested(input, 'visualIdentity', 'analysis.visualIdentity', issues);
    visualIdentity = {
      dominantColors: readStringArray(
        nested,
        'dominantColors',
        'analysis.visualIdentity.dominantColors',
        issues,
        { maxItems: 8 }
      ),
      descriptors: readStringArray(
        nested,
        'descriptors',
        'analysis.visualIdentity.descriptors',
        issues,
        { maxItems: 8 }
      ),
    };
  }

  const fieldConfidence: Partial<Record<ShopAnalysisField, number>> = {};
  const fieldConfidenceRaw = input.fieldConfidence;
  if (fieldConfidenceRaw !== null && fieldConfidenceRaw !== undefined) {
    const nested = readNested(input, 'fieldConfidence', 'analysis.fieldConfidence', issues);
    for (const [key, value] of Object.entries(nested)) {
      if (!SHOP_ANALYSIS_FIELDS.includes(key as ShopAnalysisField)) {
        issues.push(`analysis.fieldConfidence.${key}: unknown field`);
        continue;
      }
      const confidence = readConfidence(
        nested,
        key,
        `analysis.fieldConfidence.${key}`,
        issues
      );
      if (typeof value === 'number') {
        fieldConfidence[key as ShopAnalysisField] = confidence;
      }
    }
  }

  const analysis: ShopAnalysis = {
    summary,
    suggestedCategories,
    suggestedTags,
    detectedStyles: readStringArray(input, 'detectedStyles', 'analysis.detectedStyles', issues, {
      maxItems: 12,
    }),
    detectedAudience: readEnumArray<Audience>(
      input,
      'detectedAudience',
      'analysis.detectedAudience',
      AUDIENCES,
      issues
    ),
    detectedProducts: readStringArray(
      input,
      'detectedProducts',
      'analysis.detectedProducts',
      issues,
      { maxItems: 20 }
    ),
    detectedValues: readStringArray(input, 'detectedValues', 'analysis.detectedValues', issues, {
      maxItems: 12,
    }),
    pricePositioning: readEnum<PricePositioning>(
      input,
      'pricePositioning',
      'analysis.pricePositioning',
      PRICE_POSITIONINGS,
      issues,
      'unknown'
    ),
    keywords: readStringArray(input, 'keywords', 'analysis.keywords', issues, { maxItems: 30 }),
    visualIdentity,
    confidence: readConfidence(input, 'confidence', 'analysis.confidence', issues),
    fieldConfidence,
  };

  if (issues.length > 0) {
    return fail(issues);
  }
  return ok(analysis);
}

// ---------------------------------------------------------------------------
// EmbeddingResult
// ---------------------------------------------------------------------------

/**
 * No expected dimension is passed in and none is hardcoded: the vector's own
 * length is the truth, and `dimensions` must simply agree with it. A caller
 * that needs consistency across a corpus compares reported dimensions between
 * results rather than against a constant.
 */
export function validateEmbeddingResult(
  input: unknown,
  model: ModelMetadata
): ValidationResult<EmbeddingResult> {
  if (!isRecord(input)) {
    return fail([`embedding: expected object, received ${describe(input)}`]);
  }
  const issues: string[] = [];

  const rawVector = input.vector;
  const vector: number[] = [];
  if (!Array.isArray(rawVector)) {
    issues.push(`embedding.vector: expected array, received ${describe(rawVector)}`);
  } else if (rawVector.length === 0) {
    issues.push('embedding.vector: must not be empty');
  } else {
    rawVector.forEach((component, index) => {
      if (typeof component !== 'number' || !Number.isFinite(component)) {
        issues.push(`embedding.vector[${index}]: expected finite number`);
        return;
      }
      vector.push(component);
    });
  }

  const declared = readNullableNumber(input, 'dimensions', 'embedding.dimensions', issues, {
    min: 1,
  });
  if (declared !== null && vector.length > 0 && declared !== vector.length) {
    issues.push(
      `embedding.dimensions: declared ${declared} but vector has ${vector.length} components`
    );
  }

  const sourceHash = readNullableString(input, 'sourceHash', 'embedding.sourceHash', issues);

  if (issues.length > 0) {
    return fail(issues);
  }
  return ok({ vector, dimensions: declared ?? vector.length, model, sourceHash });
}

export function isEmbeddingSourceKind(value: string): boolean {
  return (EMBEDDING_SOURCE_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// RerankResult
// ---------------------------------------------------------------------------

/**
 * A reranker must return the candidates it was given: an id it invented would
 * become a shop that does not exist, so unknown ids are an error rather than
 * something to filter out quietly.
 */
export function validateRerankResult(
  input: unknown,
  knownShopIds: readonly string[],
  model: ModelMetadata
): ValidationResult<RerankResult> {
  if (!isRecord(input)) {
    return fail([`rerank: expected object, received ${describe(input)}`]);
  }
  const issues: string[] = [];
  const known = new Set(knownShopIds);
  const seen = new Set<string>();
  const results: RerankResult['results'] = [];

  const rawResults = input.results;
  if (!Array.isArray(rawResults)) {
    issues.push(`rerank.results: expected array, received ${describe(rawResults)}`);
  } else {
    rawResults.forEach((item, index) => {
      if (!isRecord(item)) {
        issues.push(`rerank.results[${index}]: expected object`);
        return;
      }
      const itemIssues: string[] = [];
      const shopId = readString(item, 'shopId', `rerank.results[${index}].shopId`, itemIssues);
      const score = readNullableNumber(item, 'score', `rerank.results[${index}].score`, itemIssues);
      const previousRank = readNullableNumber(
        item,
        'previousRank',
        `rerank.results[${index}].previousRank`,
        itemIssues,
        { min: 0 }
      );
      if (itemIssues.length > 0) {
        issues.push(...itemIssues);
        return;
      }
      if (!known.has(shopId)) {
        issues.push(`rerank.results[${index}].shopId: not among the submitted candidates`);
        return;
      }
      if (seen.has(shopId)) {
        issues.push(`rerank.results[${index}].shopId: duplicated`);
        return;
      }
      seen.add(shopId);
      results.push({
        shopId,
        score: score ?? 0,
        previousRank: previousRank ?? index,
        rank: results.length,
      });
    });
  }

  if (issues.length > 0) {
    return fail(issues);
  }
  return ok({ results, model });
}

// ---------------------------------------------------------------------------
// HelpAnswer
// ---------------------------------------------------------------------------

/**
 * The grounding rule is enforced here rather than trusted to a prompt: an
 * answer with no source is rejected, because an ungrounded sentence about
 * Shop Discovery's rules is exactly the failure this feature exists to avoid.
 */
export function validateHelpAnswer(
  input: unknown,
  availableSources: readonly HelpSource[],
  model: ModelMetadata
): ValidationResult<HelpAnswer> {
  if (!isRecord(input)) {
    return fail([`help: expected object, received ${describe(input)}`]);
  }
  const issues: string[] = [];

  const answered = readBoolean(input, 'answered', 'help.answered', issues);
  const answer = readString(input, 'answer', 'help.answer', issues, { maxLength: 4000 });
  const confidence = readConfidence(input, 'confidence', 'help.confidence', issues);

  const refusalRaw = input.refusalReason;
  const refusalReason =
    refusalRaw === null || refusalRaw === undefined
      ? null
      : readEnum(input, 'refusalReason', 'help.refusalReason', HELP_REFUSAL_REASONS, issues, 'out_of_scope');

  const citedIds = readStringArray(input, 'sourceArticleIds', 'help.sourceArticleIds', issues);
  const byId = new Map(availableSources.map((source) => [source.articleId, source]));
  const sources: HelpSource[] = [];
  citedIds.forEach((id, index) => {
    const source = byId.get(id);
    if (source === undefined) {
      issues.push(`help.sourceArticleIds[${index}]: not among the retrieved sources`);
      return;
    }
    sources.push(source);
  });

  if (answered && sources.length === 0) {
    issues.push('help: an answered response must cite at least one retrieved source');
  }
  if (!answered && answer.trim().length > 0) {
    issues.push('help: a refusal must not carry an answer');
  }
  if (!answered && refusalReason === null) {
    issues.push('help: a refusal must state a reason');
  }

  if (issues.length > 0) {
    return fail(issues);
  }
  return ok({ answered, answer, sources, confidence, refusalReason, model });
}
