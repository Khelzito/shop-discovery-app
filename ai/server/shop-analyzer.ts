import {
  ANALYSIS_WARNINGS,
  emptyShopAnalysisV2,
  SHOP_ANALYSIS_V2_CONTRACT,
  SHOP_ANALYSIS_V2_LIMITS as LIMITS,
  UNSUPPORTED_FIELDS,
} from '../contracts/shop-analysis-v2.ts';
import type {
  AnalysisWarning,
  Inferred,
  ShopAnalysisTarget,
  ShopAnalysisV2,
  ShopInferred,
  ShopObserved,
} from '../contracts/shop-analysis-v2.ts';
import type { AiCallTelemetry, ModelMetadata } from '../contracts/model.ts';
import type { ShopAnalysisModelInput, ShopAnalysisV2Provider, TaxonomyEntry } from './providers.ts';
import { classifyEmbeddingFailure } from './semantic-arm.ts';
import { validateShopAnalysisV2 } from './shop-analysis-v2.ts';
import { extractSite, looksLikePromptInjection } from './site/extract.ts';
import { isPathAllowed, MAX_ROBOTS_BYTES, parseRobots } from './site/robots.ts';
import type { RobotsPolicy } from './site/robots.ts';
import { SAFE_FETCH_LIMITS, SafeFetchError } from './site/safe-fetch.ts';
import type { Clock, SafeFetcher, SafeFetchErrorCode, SafeFetchResponse } from './site/safe-fetch.ts';
import type { AcceptedUrl } from './site/url-policy.ts';

/**
 * The Shop Analyzer pipeline, without transport or persistence:
 *
 *   robots.txt (per origin, every hop) → safe-fetch → deterministic extraction
 *   → provider (optional) → content rules → full shop-analysis/2 validation
 *
 * It never throws for a site that cannot be analysed. A blocked site, an
 * unreachable robots.txt, a provider outage or an unusable model answer all
 * produce a VALID analysis — degraded, empty where it must be, with a warning
 * saying why — so the merchant always gets a form to fill.
 *
 * ROBOTS POLICY, fail-closed:
 *   robots.txt 2xx          parsed and obeyed; an explicit Disallow for the
 *                           page → `robots_disallowed`
 *   robots.txt 4xx / 404    no rules — the page may be fetched
 *   anything else           5xx, timeout, TLS or DNS failure, oversized or
 *                           unreadable file → `fetch_blocked`. We could not read
 *                           the site's rules, so we do not fetch its pages.
 * `robots_disallowed` means "the site said no"; `fetch_blocked` means "we
 * could not establish that it said yes".
 */

export const SHOP_ANALYZER_LIMITS = {
  /** Shared by the robots.txt fetches and the page fetch. */
  networkTimeoutMs: SAFE_FETCH_LIMITS.timeoutMs,
  /** Below this mean confidence the analysis carries `low_confidence`. */
  lowConfidence: 0.4,
} as const;

export type ShopTaxonomy = { categories: TaxonomyEntry[]; tags: TaxonomyEntry[] };

export type ModelOutcome = 'success' | 'no_provider' | 'provider_failed' | 'validation_failed';

/**
 * Internal diagnostics kept with the analysis row. Page-level facts and counts
 * only: no HTML, no header, no address, no provider payload.
 */
export type ExtractionSummary = {
  mediaType: string | null;
  byteLength: number;
  redirectCount: number;
  title: string | null;
  canonicalUrl: string | null;
  faviconUrl: string | null;
  htmlLang: string | null;
  headings: number;
  modelTextChars: number;
  jsonLdBlocks: number;
  droppedInjectionLines: number;
  removedInferredItems: number;
  modelOutcome: ModelOutcome;
  providerFailure: { category: string; code: string | null; providerHttpCode: number | null } | null;
};

export type ShopAnalyzerOutcome =
  | {
      kind: 'analyzed';
      analysis: ShopAnalysisV2;
      sourceHash: string;
      summary: ExtractionSummary;
      telemetry: AiCallTelemetry[];
    }
  | {
      kind: 'blocked';
      analysis: ShopAnalysisV2;
      reason: AnalysisWarning;
      /** Internal, closed vocabulary: stored with the failed row, never shown. */
      code: string;
    };

export type ShopAnalyzerDeps = {
  fetcher: SafeFetcher;
  provider: ShopAnalysisV2Provider | null;
  clock?: Clock;
  hash?: (text: string) => Promise<string>;
  providerTimeoutMs?: number;
};

export type ShopAnalyzerInput = {
  /** Already accepted by the url policy, https. */
  url: AcceptedUrl;
  taxonomy: ShopTaxonomy;
  signal?: AbortSignal;
};

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

export async function analyzeShopWebsite(
  input: ShopAnalyzerInput,
  deps: ShopAnalyzerDeps
): Promise<ShopAnalyzerOutcome> {
  const clock = deps.clock ?? { now: () => Date.now() };
  const deadline = clock.now() + SHOP_ANALYZER_LIMITS.networkTimeoutMs;
  const requestedTarget: ShopAnalysisTarget = {
    requestedUrl: input.url.url,
    finalUrl: input.url.url,
    domain: input.url.hostname,
    redirectCount: 0,
  };

  const robotsByOrigin = new Map<string, RobotsPolicy>();
  const beforeHop = async (hop: AcceptedUrl) => {
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

  let page: SafeFetchResponse;
  try {
    page = await deps.fetcher.fetch(input.url.url, {
      acceptedMediaTypes: ['text/html', 'text/plain'],
      accept: 'text/html,text/plain;q=0.8',
      deadline,
      signal: input.signal,
      beforeHop,
    });
  } catch (error) {
    if (error instanceof RobotsDisallowedError) {
      return blocked(requestedTarget, 'robots_disallowed', 'robots_disallowed');
    }
    if (error instanceof RobotsUnavailableError) {
      return blocked(requestedTarget, 'fetch_blocked', `robots_${error.code}`);
    }
    if (error instanceof SafeFetchError) {
      return blocked(requestedTarget, warningForFetchError(error.code), error.code);
    }
    throw error;
  }

  const target: ShopAnalysisTarget = {
    requestedUrl: input.url.url,
    finalUrl: page.url.url,
    domain: page.url.hostname,
    redirectCount: page.redirectCount,
  };
  const extraction = extractSite(page.text, page.url.url, page.mediaType);
  const hash = deps.hash ?? sha256Hex;
  const sourceHash = await hash(
    JSON.stringify({
      finalUrl: target.finalUrl,
      observed: extraction.observed,
      title: extraction.title,
      headings: extraction.headings,
      text: extraction.modelText,
    })
  );

  const telemetry: AiCallTelemetry[] = [];
  let modelOutcome: ModelOutcome = deps.provider ? 'success' : 'no_provider';
  let providerFailure: ExtractionSummary['providerFailure'] = null;
  let inferred: ShopInferred | null = null;
  let model: ModelMetadata | null = null;
  let removedInferredItems = 0;

  if (deps.provider) {
    try {
      const result = await deps.provider.inferShopProfile(toModelInput(target, extraction, input.taxonomy), {
        ...(deps.providerTimeoutMs ? { timeoutMs: deps.providerTimeoutMs } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      telemetry.push(result.telemetry);
      model = { ...result.model, contractVersion: SHOP_ANALYSIS_V2_CONTRACT };
      const cleaned = sanitizeInferred(result.data, target, input.taxonomy, model);
      inferred = cleaned.inferred;
      removedInferredItems = cleaned.removed;
    } catch (error) {
      const failure = classifyEmbeddingFailure(error);
      modelOutcome = 'provider_failed';
      providerFailure = { category: failure.category, code: failure.code, providerHttpCode: failure.status };
      model = null;
      inferred = null;
    }
  }

  const baseWarnings = new Set<AnalysisWarning>(extraction.warnings);
  const build = (withModel: boolean): ShopAnalysisV2 => {
    const warnings = new Set(baseWarnings);
    if (!withModel || model === null || inferred === null) {
      warnings.add('model_unavailable');
      return {
        contractVersion: SHOP_ANALYSIS_V2_CONTRACT,
        target,
        observed: extraction.observed,
        inferred: emptyShopAnalysisV2(target).inferred,
        warnings: ordered(warnings),
        unsupported: [...UNSUPPORTED_FIELDS],
        model: null,
        degraded: true,
      };
    }
    const mean = meanConfidence(inferred);
    if (mean === null || mean < SHOP_ANALYZER_LIMITS.lowConfidence) {
      warnings.add('low_confidence');
    }
    return {
      contractVersion: SHOP_ANALYSIS_V2_CONTRACT,
      target,
      observed: extraction.observed,
      inferred,
      warnings: ordered(warnings),
      unsupported: [...UNSUPPORTED_FIELDS],
      model,
      degraded: false,
    };
  };

  const options = allowedSlugs(input.taxonomy);
  let validated = validateShopAnalysisV2(build(true), options);
  if (!validated.ok && model !== null) {
    // Content rules already ran value by value, so this is not expected. If it
    // happens the model contribution is dropped, never patched.
    modelOutcome = 'validation_failed';
    validated = validateShopAnalysisV2(build(false), options);
  }
  if (!validated.ok) {
    // The observed half itself failed: an extraction bug. Fall back to an
    // analysis that says nothing rather than to one that says something wrong.
    const fallback = emptyShopAnalysisV2(target);
    fallback.warnings = ordered(new Set([...baseWarnings, 'model_unavailable' as const]));
    validated = validateShopAnalysisV2(fallback, options);
    if (!validated.ok) {
      throw new Error('shop analysis could not be represented');
    }
  }

  return {
    kind: 'analyzed',
    analysis: validated.value,
    sourceHash,
    telemetry,
    summary: {
      mediaType: page.mediaType,
      byteLength: page.byteLength,
      redirectCount: page.redirectCount,
      title: extraction.title,
      canonicalUrl: extraction.canonicalUrl,
      faviconUrl: extraction.faviconUrl,
      htmlLang: extraction.htmlLang,
      headings: extraction.headings.length,
      modelTextChars: extraction.modelText.length,
      jsonLdBlocks: extraction.stats.jsonLdBlocks,
      droppedInjectionLines: extraction.stats.droppedInjectionLines,
      removedInferredItems,
      modelOutcome,
      providerFailure,
    },
  };
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

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

function warningForFetchError(code: SafeFetchErrorCode): AnalysisWarning {
  switch (code) {
    case 'timeout':
    case 'aborted':
      return 'timeout';
    case 'body_too_large':
    case 'headers_too_large':
      return 'content_too_large';
    case 'content_type_not_allowed':
      return 'non_html_content';
    case 'redirect_limit':
    case 'redirect_loop':
      return 'redirect_limit';
    default:
      return 'fetch_blocked';
  }
}

function blocked(target: ShopAnalysisTarget, reason: AnalysisWarning, code: string): ShopAnalyzerOutcome {
  const analysis = emptyShopAnalysisV2(target);
  analysis.warnings = [reason];
  return { kind: 'blocked', analysis, reason, code };
}

// ---------------------------------------------------------------------------
// Model input and content rules
// ---------------------------------------------------------------------------

function toModelInput(
  target: ShopAnalysisTarget,
  extraction: ReturnType<typeof extractSite>,
  taxonomy: ShopTaxonomy
): ShopAnalysisModelInput {
  // An observed value that addresses a model stays observed — it is what the
  // site says — but it is not handed to the model.
  const observed: ShopObserved = {
    ...extraction.observed,
    name:
      extraction.observed.name && !looksLikePromptInjection(extraction.observed.name.value)
        ? extraction.observed.name
        : null,
    description:
      extraction.observed.description && !looksLikePromptInjection(extraction.observed.description.value)
        ? extraction.observed.description
        : null,
  };
  return {
    target: { domain: target.domain, finalUrl: target.finalUrl },
    observed,
    title: extraction.title,
    headings: extraction.headings,
    pageText: extraction.modelText,
    categories: taxonomy.categories,
    tags: taxonomy.tags,
    locale: 'fr',
  };
}

function allowedSlugs(taxonomy: ShopTaxonomy) {
  return {
    allowedCategorySlugs: taxonomy.categories.map((entry) => entry.slug),
    allowedTagSlugs: taxonomy.tags.map((entry) => entry.slug),
  };
}

/**
 * Keeps each inferred value only if the Phase A validator accepts it on its own.
 *
 * Rather than restating the trust, origin, slug, taxonomy and length rules
 * here — a second copy that could drift from the first — every candidate is
 * validated inside an otherwise empty analysis. What fails is DROPPED, never
 * rewritten: removing a claim cannot invent one.
 */
export function sanitizeInferred(
  raw: ShopInferred,
  target: ShopAnalysisTarget,
  taxonomy: ShopTaxonomy,
  model: ModelMetadata
): { inferred: ShopInferred; removed: number } {
  const options = allowedSlugs(taxonomy);
  let removed = 0;

  const accepts = (patch: Partial<ShopInferred>): boolean => {
    const probe = emptyShopAnalysisV2(target);
    probe.model = model;
    probe.degraded = false;
    probe.inferred = { ...probe.inferred, ...patch };
    return validateShopAnalysisV2(probe, options).ok;
  };

  const round = <T>(entry: Inferred<T>): Inferred<T> => ({
    value: entry.value,
    confidence: Math.round(entry.confidence * 1000) / 1000,
  });

  const keep = <T>(entry: Inferred<T> | null, patch: (value: Inferred<T>) => Partial<ShopInferred>): Inferred<T> | null => {
    if (entry === null) return null;
    const rounded = round(entry);
    if (accepts(patch(rounded))) return rounded;
    removed += 1;
    return null;
  };

  const keepList = <T>(
    entries: readonly Inferred<T>[],
    max: number,
    patch: (value: Inferred<T>[]) => Partial<ShopInferred>,
    exclude: (value: Inferred<T>) => boolean = () => false
  ): Inferred<T>[] => {
    const kept: Inferred<T>[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const rounded = round(entry);
      const identity =
        typeof rounded.value === 'string' ? rounded.value.trim().toLowerCase() : JSON.stringify(rounded.value);
      if (kept.length >= max || seen.has(identity) || exclude(rounded) || !accepts(patch([rounded]))) {
        removed += 1;
        continue;
      }
      seen.add(identity);
      kept.push(rounded);
    }
    return kept;
  };

  const primaryCategory = keep(raw.primaryCategory, (value) => ({ primaryCategory: value }));

  return {
    inferred: {
      shortDescription: keep(raw.shortDescription, (value) => ({ shortDescription: value })),
      primaryCategory,
      secondaryCategories: keepList(
        raw.secondaryCategories,
        LIMITS.secondaryCategories,
        (value) => ({ secondaryCategories: value }),
        (value) => value.value === primaryCategory?.value
      ),
      audience: keep(raw.audience, (value) => ({ audience: value })),
      pricePositioning: keep(raw.pricePositioning, (value) => ({ pricePositioning: value })),
      styles: keepList(raw.styles, LIMITS.freeTextItems, (value) => ({ styles: value })),
      values: keepList(raw.values, LIMITS.freeTextItems, (value) => ({ values: value })),
      productTypes: keepList(raw.productTypes, LIMITS.freeTextItems, (value) => ({ productTypes: value })),
      tags: keepList(raw.tags, LIMITS.tags, (value) => ({ tags: value })),
      summary: keep(raw.summary, (value) => ({ summary: value })),
    },
    removed,
  };
}

/** Mean of every inferred confidence; null when nothing was inferred. */
export function meanConfidence(inferred: ShopInferred): number | null {
  const entries: ({ confidence: number } | null)[] = [
    inferred.shortDescription,
    inferred.primaryCategory,
    inferred.audience,
    inferred.pricePositioning,
    inferred.summary,
    ...inferred.secondaryCategories,
    ...inferred.styles,
    ...inferred.values,
    ...inferred.productTypes,
    ...inferred.tags,
  ];
  const confidences = entries
    .filter((entry): entry is { confidence: number } => entry !== null)
    .map((entry) => entry.confidence);
  if (confidences.length === 0) return null;
  return Math.round((confidences.reduce((sum, value) => sum + value, 0) / confidences.length) * 1000) / 1000;
}

function ordered(warnings: ReadonlySet<AnalysisWarning>): AnalysisWarning[] {
  return ANALYSIS_WARNINGS.filter((warning) => warnings.has(warning));
}

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * The live vocabulary a model may choose from.
 *
 * Tags of kind `origin` (made-in-france) are excluded outright: an origin is
 * declared by a merchant, never proposed by a model. The validator would
 * refuse such a tag anyway; not offering it keeps the model from spending an
 * answer on it.
 */
export function toShopTaxonomy(
  categories: readonly { slug?: unknown; name?: unknown }[],
  tags: readonly { slug?: unknown; name?: unknown; kind?: unknown }[]
): ShopTaxonomy {
  const entry = (row: { slug?: unknown; name?: unknown }): TaxonomyEntry | null =>
    typeof row.slug === 'string' && SLUG.test(row.slug) && row.slug.length <= 64 && typeof row.name === 'string'
      ? { slug: row.slug, name: row.name.slice(0, 60) }
      : null;
  return {
    categories: categories
      .map(entry)
      .filter((value): value is TaxonomyEntry => value !== null)
      .slice(0, 200),
    tags: tags
      .filter((row) => row.kind !== 'origin')
      .map(entry)
      .filter((value): value is TaxonomyEntry => value !== null)
      .slice(0, 200),
  };
}

/**
 * A taxonomy read that failed, carrying only what a log line can act on: which
 * table, the PostgREST or SQLSTATE code, and the HTTP status. Never the message,
 * which can quote the request.
 */
export class TaxonomyUnavailableError extends Error {
  constructor(
    readonly table: 'categories' | 'tags',
    readonly code: string | null,
    readonly httpStatus: number | null
  ) {
    super(`taxonomy read failed: ${table}`);
    this.name = 'TaxonomyUnavailableError';
  }
}

export type TaxonomyReadResult = { data: unknown; error: { code?: unknown } | null; status?: unknown };

/** Turns the two taxonomy reads into a taxonomy, or a diagnosable error. */
export function taxonomyFromResponses(categories: TaxonomyReadResult, tags: TaxonomyReadResult): ShopTaxonomy {
  for (const [table, response] of [['categories', categories], ['tags', tags]] as const) {
    if (response.error || !Array.isArray(response.data)) {
      throw new TaxonomyUnavailableError(
        table,
        typeof response.error?.code === 'string' ? response.error.code : null,
        typeof response.status === 'number' ? response.status : null
      );
    }
  }
  return toShopTaxonomy(
    categories.data as { slug?: unknown; name?: unknown }[],
    tags.data as { slug?: unknown; name?: unknown; kind?: unknown }[]
  );
}

// ---------------------------------------------------------------------------
// Hash
// ---------------------------------------------------------------------------

export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
