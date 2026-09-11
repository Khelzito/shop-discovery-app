import { AUDIENCES, PRICE_POSITIONINGS } from '../contracts/common.ts';
import type { Audience } from '../contracts/common.ts';
import {
  ANALYSIS_WARNINGS,
  PROVENANCE_KINDS,
  SHOP_ANALYSIS_V2_CONTRACT,
  SHOP_ANALYSIS_V2_LIMITS as LIMITS,
  SOCIAL_NETWORKS,
  UNSUPPORTED_FIELDS,
} from '../contracts/shop-analysis-v2.ts';
import type {
  AnalysisWarning,
  Inferred,
  KnownPricePositioning,
  Observed,
  Provenance,
  ShopAnalysisRequestV2,
  ShopAnalysisV2,
  ShopInferred,
  ShopObserved,
  SocialLink,
  UnsupportedField,
} from '../contracts/shop-analysis-v2.ts';
import type { ModelMetadata } from '../contracts/model.ts';
import { evaluateUrl } from './site/url-policy.ts';
import type { ValidationResult } from './validation.ts';

/**
 * Strict runtime validation for shop-analysis/2.
 *
 * Its own module rather than more of ./validation.ts, because the rules are
 * the opposite of that file's. The v1 readers are forgiving — a missing array
 * becomes `[]`, blanks are dropped — which suits parsing model output into a
 * best-effort intent. Here forgiveness is the vulnerability: a key this
 * validator silently ignored is a key a hostile page or a drifting model could
 * use to smuggle "verified" into something a merchant then publishes.
 *
 * So:
 *   * every object is checked for UNKNOWN KEYS, at every level;
 *   * every field is REQUIRED to be present, even when null or empty;
 *   * OBSERVED values need a provenance and may not carry a confidence;
 *   * INFERRED values need a confidence and may not carry a provenance;
 *   * inferred free text may not assert trust, verification or certification;
 *   * inferred text and tags may not assert an origin or place of manufacture;
 *   * nothing inferred may exist without a model that inferred it.
 *
 * One pass collects every issue, so a failure explains itself completely.
 */

export type ShopAnalysisV2Options = {
  /** When given, category slugs outside the live taxonomy are rejected. */
  allowedCategorySlugs?: readonly string[];
  /** When given, tag slugs outside the live vocabulary are rejected. */
  allowedTagSlugs?: readonly string[];
};

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Keys that name a forbidden concept. Unknown-key rejection already refuses
 * them; this list exists so the ISSUE says "forbidden" rather than "unknown",
 * which is the difference between a bug report and a security report.
 */
const FORBIDDEN_KEY = /verif|trust|reliab|fiab|legit|certif|legal|business|publish|moderat|score|badge|official|officiel|approved|status/i;

/**
 * Trust claims a model must never make in text that could reach a public
 * profile. Matched on word stems in French and English.
 *
 * Applies to INFERRED text only. An observed description is a verbatim quote
 * from the merchant's own site with its provenance attached; refusing it would
 * make ordinary sites unanalysable, and it only becomes public through the
 * merchant confirming it.
 */
const TRUST_CLAIM = /v[ée]rifi|verified|verification|fiab|trusted|trustworth|reliab|legit|arnaque|\bscam|certifi|garanti[e]? (?:authentique|sans)/i;

/**
 * National origin and place-of-manufacture claims.
 *
 * "Made in France" is a fact about a supply chain, and nothing in a site's
 * copy lets a model establish it — docs/AI_ARCHITECTURE.md lists it among what
 * AI must never assert. So INFERRED text may not state an origin:
 *
 *   * OBSERVED keeps it: the exact words on the merchant's own site, with the
 *     provenance that says where they were read;
 *   * the merchant may later DECLARE it;
 *   * a model never turns it into a fact on its own, and no verification or
 *     trust consequence can follow — the contract has no field to carry one.
 *
 * The line is drawn at the HEAD WORD, not at the nationality. "style japonais",
 * "élégance française", "coupe italienne" describe an aesthetic — Search V2
 * depends on queries like "un style japonais" — and stay allowed. "marque
 * japonaise", "fabriqué au Japon" and "Japanese-made" state where something
 * comes from, and are refused.
 *
 * Matching runs on a folded copy: diacritics stripped, hyphens and underscores
 * turned into spaces, whitespace collapsed. It is a heuristic; the cases it is
 * held to live in the tests.
 */
const COUNTRY_NAMES = [
  'france', 'italie', 'italy', 'portugal', 'espagne', 'spain', 'allemagne', 'germany',
  'belgique', 'belgium', 'suisse', 'switzerland', 'royaume uni', 'angleterre', 'england',
  'ecosse', 'scotland', 'uk', 'grande bretagne', 'britain', 'irlande', 'ireland',
  'pays bas', 'netherlands', 'hollande', 'holland', 'danemark', 'denmark', 'sweden',
  'norvege', 'norway', 'finlande', 'finland', 'pologne', 'poland', 'grece', 'greece',
  'turquie', 'turkey', 'maroc', 'morocco', 'tunisie', 'tunisia', 'inde', 'india',
  'chine', 'china', 'japon', 'japan', 'coree', 'korea', 'vietnam', 'viet nam',
  'bangladesh', 'pakistan', 'cambodge', 'cambodia', 'indonesie', 'indonesia',
  'thailande', 'thailand', 'etats unis', 'usa', 'us', 'amerique', 'america', 'canada',
  'mexique', 'mexico', 'bresil', 'brazil', 'perou', 'peru', 'australie', 'australia',
  'europe', 'ue', 'eu', 'afrique', 'africa', 'asie', 'asia',
] as const;

// "suede" is deliberately absent from the country names: "fabriqué en suède"
// far more often means suede leather than Sweden.
const NATIONALITY_STEMS = [
  'francais', 'italien', 'portugais', 'espagnol', 'allemand', 'belge', 'suisse',
  'britannique', 'anglais', 'ecossais', 'irlandais', 'neerlandais', 'hollandais',
  'danois', 'suedois', 'norvegien', 'polonais', 'grec', 'turc', 'turque', 'marocain',
  'tunisien', 'indien', 'chinois', 'japonais', 'coreen', 'vietnamien', 'americain',
  'canadien', 'mexicain', 'bresilien', 'australien', 'europeen', 'africain',
  'asiatique', 'local', 'locaux',
  'french', 'italian', 'portuguese', 'spanish', 'german', 'belgian', 'swiss', 'british',
  'english', 'scottish', 'irish', 'dutch', 'danish', 'swedish', 'norwegian', 'polish',
  'greek', 'turkish', 'moroccan', 'indian', 'chinese', 'japanese', 'korean',
  'vietnamese', 'american', 'canadian', 'mexican', 'brazilian', 'australian',
  'european', 'african', 'asian',
] as const;

// Assembled from strings with no backslash, so the patterns read the same in
// the source as at runtime: whitespace is already collapsed to single spaces.
const LEFT = '(?:^|[^a-z0-9])';
const RIGHT = '(?![a-z0-9])';
const COUNTRY = `(?:${COUNTRY_NAMES.join('|')})`;
const NATIONALITY = `(?:${NATIONALITY_STEMS.join('|')})(?:e|es|s|ne|nes|que|ques)?`;
const PREPOSITION = '(?:en|au|aux|a|dans|in|from)';
const ARTICLE = "(?:(?:le|la|les|the) |l' ?)?";
const MAKE_VERB =
  '(?:fabriqu|confectionn|assembl|produi|cousu|tiss|tann|faconn|brod|tricot|concu|manufactur|made|crafted|produced|assembled|designed|sewn|sourced|handmade)[a-z]*';
const ORIGIN_NOUN =
  '(?:fabrication|production|confection|manufacture|manufacturing|assemblage|origine|provenance|artisanat)';
const BRAND_NOUN =
  '(?:marque|maison|label|entreprise|societe|atelier|createur|creatrice|designer|fabricant|brand|company|maker|manufacturer)';

const ORIGIN_PATTERNS: readonly RegExp[] = [
  // fabriqué en France · made in the USA · cousu au Portugal
  new RegExp(`${LEFT}${MAKE_VERB} ${PREPOSITION} ${ARTICLE}${COUNTRY}${RIGHT}`),
  // fabrication française · d'origine italienne · production locale
  new RegExp(`${LEFT}${ORIGIN_NOUN} (?:de |d' ?)?${NATIONALITY}${RIGHT}`),
  // provenance d'Italie · origine du Japon
  new RegExp(`${LEFT}${ORIGIN_NOUN} (?:de |d' ?|du |des )${COUNTRY}${RIGHT}`),
  // French made · italian-made
  new RegExp(`${LEFT}${NATIONALITY} made${RIGHT}`),
  // marque française · maison italienne
  new RegExp(`${LEFT}${BRAND_NOUN} ${NATIONALITY}${RIGHT}`),
  // French brand · local label
  new RegExp(`${LEFT}${NATIONALITY} ${BRAND_NOUN}${RIGHT}`),
  // 100 % français
  new RegExp(`${LEFT}100 ?% ?${NATIONALITY}${RIGHT}`),
  // made locally · locally sourced · fabriqué localement
  new RegExp(
    `${LEFT}(?:made locally|locally (?:made|produced|manufactured|crafted|sourced)|${MAKE_VERB} localement)${RIGHT}`
  ),
];

// fabriqué à Roubaix · made in Brooklyn: a place no list can name, recognised
// by its capital letter. "made in small batches" stays allowed.
const MAKE_THEN_PLACE = new RegExp(`${LEFT}${MAKE_VERB} ${PREPOSITION} ${ARTICLE}([a-z])`, 'gi');

/** True when the text states where something is made or comes from. */
export function assertsOrigin(text: string): boolean {
  const folded = text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[’‘`´]/g, "'")
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const lower = folded.toLowerCase();

  if (ORIGIN_PATTERNS.some((pattern) => pattern.test(lower))) {
    return true;
  }
  for (const match of folded.matchAll(MAKE_THEN_PLACE)) {
    const initial = match[1]!;
    if (initial !== initial.toLowerCase()) {
      return true;
    }
  }
  return false;
}

const ORIGIN_ISSUE =
  'forbidden origin or manufacturing claim — it may only be observed on the site or declared by the merchant';

type Issues = string[];

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export function validateShopAnalysisRequestV2(input: unknown): ValidationResult<ShopAnalysisRequestV2> {
  const issues: Issues = [];
  if (!isRecord(input)) {
    return { ok: false, issues: [`request: expected object, received ${describe(input)}`] };
  }
  checkKeys(input, ['websiteUrl', 'submissionId', 'locale'], 'request', issues);

  const websiteUrl = input.websiteUrl;
  if (typeof websiteUrl !== 'string') {
    issues.push(`request.websiteUrl: expected string, received ${describe(websiteUrl)}`);
  } else {
    // Refused at the boundary so an internal URL never reaches a fetcher —
    // not a substitute for Phase B's DNS checks, a first filter before them.
    const policy = evaluateUrl(websiteUrl, { allowSchemeless: true });
    if (!policy.ok) {
      issues.push(`request.websiteUrl: rejected by url policy (${policy.reason})`);
    }
  }

  if (input.submissionId !== undefined) {
    if (typeof input.submissionId !== 'string' || !UUID.test(input.submissionId)) {
      issues.push('request.submissionId: expected uuid');
    }
  }
  if (input.locale !== undefined && input.locale !== 'fr') {
    issues.push('request.locale: only "fr" is supported');
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  const value: ShopAnalysisRequestV2 = { websiteUrl: websiteUrl as string };
  if (input.submissionId !== undefined) value.submissionId = input.submissionId as string;
  if (input.locale !== undefined) value.locale = 'fr';
  return { ok: true, value };
}

export function validateShopAnalysisV2(
  input: unknown,
  options: ShopAnalysisV2Options = {}
): ValidationResult<ShopAnalysisV2> {
  const issues: Issues = [];
  if (!isRecord(input)) {
    return { ok: false, issues: [`analysis: expected object, received ${describe(input)}`] };
  }

  checkKeys(
    input,
    ['contractVersion', 'target', 'observed', 'inferred', 'warnings', 'unsupported', 'model', 'degraded'],
    'analysis',
    issues
  );

  if (input.contractVersion !== SHOP_ANALYSIS_V2_CONTRACT) {
    issues.push(`analysis.contractVersion: expected "${SHOP_ANALYSIS_V2_CONTRACT}"`);
  }

  const target = readTarget(input.target, issues);
  const observed = readObserved(input.observed, issues);
  const inferred = readInferred(input.inferred, options, issues);
  const warnings = readEnumList(input.warnings, ANALYSIS_WARNINGS, 'analysis.warnings', issues) as AnalysisWarning[];
  const unsupported = readEnumList(
    input.unsupported,
    UNSUPPORTED_FIELDS,
    'analysis.unsupported',
    issues
  ) as UnsupportedField[];
  const model = readModel(input.model, issues);

  if (typeof input.degraded !== 'boolean') {
    issues.push(`analysis.degraded: expected boolean, received ${describe(input.degraded)}`);
  }
  const degraded = input.degraded === true;

  // Coherence. An interpretation needs an interpreter: inferred content with
  // no model is fabricated by construction, and a non-degraded answer with no
  // model contradicts itself.
  if (model === null && inferredHasContent(inferred)) {
    issues.push('analysis.inferred: must be empty when model is null');
  }
  if (model === null && !degraded) {
    issues.push('analysis.degraded: must be true when model is null');
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    value: {
      contractVersion: SHOP_ANALYSIS_V2_CONTRACT,
      target: target!,
      observed,
      inferred,
      warnings,
      unsupported,
      model,
      degraded,
    },
  };
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function readTarget(value: unknown, issues: Issues): ShopAnalysisV2['target'] | null {
  const path = 'analysis.target';
  if (!isRecord(value)) {
    issues.push(`${path}: expected object, received ${describe(value)}`);
    return null;
  }
  checkKeys(value, ['requestedUrl', 'finalUrl', 'domain', 'redirectCount'], path, issues);

  const requestedUrl = readUrl(value.requestedUrl, `${path}.requestedUrl`, issues);
  const finalUrl = readUrl(value.finalUrl, `${path}.finalUrl`, issues);
  const domain = readString(value.domain, `${path}.domain`, LIMITS.domain, issues);

  // The domain must be the exact host of finalUrl, or claims (D2) could be
  // matched against a host the analysis never actually reached.
  if (finalUrl !== null && domain !== null) {
    const policy = evaluateUrl(finalUrl);
    if (policy.ok && policy.hostname !== domain) {
      issues.push(`${path}.domain: must equal the host of finalUrl`);
    }
  }

  const redirectCount = value.redirectCount;
  if (
    typeof redirectCount !== 'number' ||
    !Number.isInteger(redirectCount) ||
    redirectCount < 0 ||
    redirectCount > LIMITS.maxRedirects
  ) {
    issues.push(`${path}.redirectCount: expected integer in [0, ${LIMITS.maxRedirects}]`);
  }

  return {
    requestedUrl: requestedUrl ?? '',
    finalUrl: finalUrl ?? '',
    domain: domain ?? '',
    redirectCount: typeof redirectCount === 'number' ? redirectCount : 0,
  };
}

const OBSERVED_KEYS = [
  'name',
  'description',
  'language',
  'countryCode',
  'currency',
  'logoUrl',
  'imageUrls',
  'socialLinks',
  'siteSectionLabels',
] as const;

function readObserved(value: unknown, issues: Issues): ShopObserved {
  const path = 'analysis.observed';
  const empty: ShopObserved = {
    name: null,
    description: null,
    language: null,
    countryCode: null,
    currency: null,
    logoUrl: null,
    imageUrls: [],
    socialLinks: [],
    siteSectionLabels: [],
  };
  if (!isRecord(value)) {
    issues.push(`${path}: expected object, received ${describe(value)}`);
    return empty;
  }
  checkKeys(value, OBSERVED_KEYS, path, issues);

  const text = (max: number) => (raw: unknown, at: string) => readString(raw, at, max, issues);
  const pattern = (re: RegExp, label: string, max: number) => (raw: unknown, at: string) => {
    const s = readString(raw, at, max, issues);
    if (s !== null && !re.test(s)) {
      issues.push(`${at}: not a valid ${label}`);
      return null;
    }
    return s;
  };
  const url = (raw: unknown, at: string) => readUrl(raw, at, issues);

  return {
    name: readObservedNullable(value, 'name', path, text(LIMITS.name), issues),
    description: readObservedNullable(value, 'description', path, text(LIMITS.observedDescription), issues),
    language: readObservedNullable(value, 'language', path, pattern(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'language tag', LIMITS.language), issues),
    countryCode: readObservedNullable(value, 'countryCode', path, pattern(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2 code', 2), issues),
    currency: readObservedNullable(value, 'currency', path, pattern(/^[A-Z]{3}$/, 'ISO 4217 code', 3), issues),
    logoUrl: readObservedNullable(value, 'logoUrl', path, url, issues),
    imageUrls: readObservedList(value, 'imageUrls', path, LIMITS.imageUrls, url, issues),
    socialLinks: readObservedList(value, 'socialLinks', path, LIMITS.socialLinks, (raw, at) => readSocialLink(raw, at, issues), issues),
    siteSectionLabels: readObservedList(value, 'siteSectionLabels', path, LIMITS.siteSectionLabels, text(LIMITS.siteSectionLabel), issues),
  };
}

const INFERRED_KEYS = [
  'shortDescription',
  'primaryCategory',
  'secondaryCategories',
  'audience',
  'pricePositioning',
  'styles',
  'values',
  'productTypes',
  'tags',
  'summary',
] as const;

function readInferred(value: unknown, options: ShopAnalysisV2Options, issues: Issues): ShopInferred {
  const path = 'analysis.inferred';
  const empty: ShopInferred = {
    shortDescription: null,
    primaryCategory: null,
    secondaryCategories: [],
    audience: null,
    pricePositioning: null,
    styles: [],
    values: [],
    productTypes: [],
    tags: [],
    summary: null,
  };
  if (!isRecord(value)) {
    issues.push(`${path}: expected object, received ${describe(value)}`);
    return empty;
  }
  checkKeys(value, INFERRED_KEYS, path, issues);

  const claimFreeText = (max: number) => (raw: unknown, at: string) => {
    const s = readString(raw, at, max, issues);
    if (s !== null && TRUST_CLAIM.test(s)) {
      issues.push(`${at}: forbidden trust or verification claim`);
      return null;
    }
    if (s !== null && assertsOrigin(s)) {
      issues.push(`${at}: ${ORIGIN_ISSUE}`);
      return null;
    }
    return s;
  };
  const slug = (allowed: readonly string[] | undefined, label: string) => (raw: unknown, at: string) => {
    const s = readString(raw, at, 64, issues);
    if (s === null) return null;
    if (!SLUG.test(s)) {
      issues.push(`${at}: not a valid slug`);
      return null;
    }
    if (TRUST_CLAIM.test(s.replace(/-/g, ' '))) {
      issues.push(`${at}: forbidden trust or verification claim`);
      return null;
    }
    // A tag like "made-in-france" would become a public label on acceptance.
    if (assertsOrigin(s)) {
      issues.push(`${at}: ${ORIGIN_ISSUE}`);
      return null;
    }
    if (allowed !== undefined && !allowed.includes(s)) {
      issues.push(`${at}: "${s}" is not in the ${label} taxonomy`);
      return null;
    }
    return s;
  };

  const primaryCategory = readInferredNullable(value, 'primaryCategory', path, slug(options.allowedCategorySlugs, 'category'), issues);
  const secondaryCategories = readInferredList(value, 'secondaryCategories', path, LIMITS.secondaryCategories, slug(options.allowedCategorySlugs, 'category'), issues);

  if (primaryCategory !== null && secondaryCategories.some((entry) => entry.value === primaryCategory.value)) {
    issues.push(`${path}.secondaryCategories: must not repeat primaryCategory`);
  }

  return {
    shortDescription: readInferredNullable(value, 'shortDescription', path, claimFreeText(LIMITS.shortDescription), issues),
    primaryCategory,
    secondaryCategories,
    audience: readInferredNullable(value, 'audience', path, (raw, at) => readAudience(raw, at, issues), issues),
    pricePositioning: readInferredNullable(value, 'pricePositioning', path, (raw, at) => readPrice(raw, at, issues), issues),
    styles: readInferredList(value, 'styles', path, LIMITS.freeTextItems, claimFreeText(LIMITS.freeTextItem), issues),
    values: readInferredList(value, 'values', path, LIMITS.freeTextItems, claimFreeText(LIMITS.freeTextItem), issues),
    productTypes: readInferredList(value, 'productTypes', path, LIMITS.freeTextItems, claimFreeText(LIMITS.freeTextItem), issues),
    tags: readInferredList(value, 'tags', path, LIMITS.tags, slug(options.allowedTagSlugs, 'tag'), issues),
    summary: readInferredNullable(value, 'summary', path, claimFreeText(LIMITS.summary), issues),
  };
}

function inferredHasContent(inferred: ShopInferred): boolean {
  return (
    inferred.shortDescription !== null ||
    inferred.primaryCategory !== null ||
    inferred.secondaryCategories.length > 0 ||
    inferred.audience !== null ||
    inferred.pricePositioning !== null ||
    inferred.styles.length > 0 ||
    inferred.values.length > 0 ||
    inferred.productTypes.length > 0 ||
    inferred.tags.length > 0 ||
    inferred.summary !== null
  );
}

// ---------------------------------------------------------------------------
// Observed / Inferred wrappers
// ---------------------------------------------------------------------------

type Reader<T> = (raw: unknown, path: string) => T | null;

function requirePresent(source: Record<string, unknown>, key: string, path: string, issues: Issues): boolean {
  if (!(key in source)) {
    issues.push(`${path}.${key}: required (use null or [] when absent)`);
    return false;
  }
  return true;
}

function readObservedNullable<T>(
  source: Record<string, unknown>,
  key: string,
  parent: string,
  read: Reader<T>,
  issues: Issues
): Observed<T> | null {
  if (!requirePresent(source, key, parent, issues)) return null;
  const raw = source[key];
  return raw === null ? null : readObservedEntry(raw, `${parent}.${key}`, read, issues);
}

function readObservedList<T>(
  source: Record<string, unknown>,
  key: string,
  parent: string,
  max: number,
  read: Reader<T>,
  issues: Issues
): Observed<T>[] {
  if (!requirePresent(source, key, parent, issues)) return [];
  const raw = source[key];
  const path = `${parent}.${key}`;
  if (!Array.isArray(raw)) {
    issues.push(`${path}: expected array, received ${describe(raw)}`);
    return [];
  }
  if (raw.length > max) {
    issues.push(`${path}: at most ${max} items, received ${raw.length}`);
  }
  const result: Observed<T>[] = [];
  raw.slice(0, max).forEach((item, index) => {
    const entry = readObservedEntry(item, `${path}[${index}]`, read, issues);
    if (entry !== null) result.push(entry);
  });
  return result;
}

function readObservedEntry<T>(raw: unknown, path: string, read: Reader<T>, issues: Issues): Observed<T> | null {
  if (!isRecord(raw)) {
    issues.push(`${path}: expected { value, source }, received ${describe(raw)}`);
    return null;
  }
  // An observed value carrying a confidence is an inference in disguise.
  if ('confidence' in raw) {
    issues.push(`${path}.confidence: observed values carry provenance, not confidence`);
  }
  checkKeys(raw, ['value', 'source'], path, issues, { reportConfidenceSeparately: true });
  if (!('source' in raw)) {
    issues.push(`${path}.source: provenance is required for an observed value`);
    return null;
  }
  const source = readProvenance(raw.source, `${path}.source`, issues);
  const value = read(raw.value, `${path}.value`);
  return source === null || value === null ? null : { value, source };
}

function readInferredNullable<T>(
  source: Record<string, unknown>,
  key: string,
  parent: string,
  read: Reader<T>,
  issues: Issues
): Inferred<T> | null {
  if (!requirePresent(source, key, parent, issues)) return null;
  const raw = source[key];
  return raw === null ? null : readInferredEntry(raw, `${parent}.${key}`, read, issues);
}

function readInferredList<T>(
  source: Record<string, unknown>,
  key: string,
  parent: string,
  max: number,
  read: Reader<T>,
  issues: Issues
): Inferred<T>[] {
  if (!requirePresent(source, key, parent, issues)) return [];
  const raw = source[key];
  const path = `${parent}.${key}`;
  if (!Array.isArray(raw)) {
    issues.push(`${path}: expected array, received ${describe(raw)}`);
    return [];
  }
  if (raw.length > max) {
    issues.push(`${path}: at most ${max} items, received ${raw.length}`);
  }
  const result: Inferred<T>[] = [];
  const seen = new Set<string>();
  raw.slice(0, max).forEach((item, index) => {
    const entry = readInferredEntry(item, `${path}[${index}]`, read, issues);
    if (entry === null) return;
    const identity = JSON.stringify(entry.value);
    if (seen.has(identity)) {
      issues.push(`${path}[${index}]: duplicate value`);
      return;
    }
    seen.add(identity);
    result.push(entry);
  });
  return result;
}

function readInferredEntry<T>(raw: unknown, path: string, read: Reader<T>, issues: Issues): Inferred<T> | null {
  if (!isRecord(raw)) {
    issues.push(`${path}: expected { value, confidence }, received ${describe(raw)}`);
    return null;
  }
  // An inference claiming a source is pretending to be an observation.
  if ('source' in raw) {
    issues.push(`${path}.source: inferred values carry confidence, not provenance`);
  }
  checkKeys(raw, ['value', 'confidence'], path, issues, { reportSourceSeparately: true });
  if (!('confidence' in raw)) {
    issues.push(`${path}.confidence: required for an inferred value`);
    return null;
  }
  const confidence = raw.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    issues.push(`${path}.confidence: expected number in [0, 1]`);
    return null;
  }
  const value = read(raw.value, `${path}.value`);
  return value === null ? null : { value, confidence };
}

// ---------------------------------------------------------------------------
// Leaf readers
// ---------------------------------------------------------------------------

function readProvenance(raw: unknown, path: string, issues: Issues): Provenance | null {
  if (!isRecord(raw)) {
    issues.push(`${path}: expected object, received ${describe(raw)}`);
    return null;
  }
  const kind = raw.kind;
  if (typeof kind !== 'string' || !(PROVENANCE_KINDS as readonly string[]).includes(kind)) {
    issues.push(`${path}.kind: expected one of ${PROVENANCE_KINDS.join(', ')}`);
    return null;
  }
  const token = (key: string, max: number) => {
    const s = readString(raw[key], `${path}.${key}`, max, issues);
    return s;
  };
  switch (kind) {
    case 'url':
    case 'page_text':
      checkKeys(raw, ['kind'], path, issues);
      return { kind };
    case 'html_meta': {
      checkKeys(raw, ['kind', 'key'], path, issues);
      const key = token('key', LIMITS.provenanceToken);
      return key === null ? null : { kind, key };
    }
    case 'html_link': {
      checkKeys(raw, ['kind', 'rel'], path, issues);
      const rel = token('rel', LIMITS.provenanceToken);
      return rel === null ? null : { kind, rel };
    }
    default: {
      checkKeys(raw, ['kind', 'type', 'path'], path, issues);
      const type = token('type', LIMITS.provenanceToken);
      const jsonPath = token('path', LIMITS.provenancePath);
      return type === null || jsonPath === null ? null : { kind: 'json_ld', type, path: jsonPath };
    }
  }
}

function readSocialLink(raw: unknown, path: string, issues: Issues): SocialLink | null {
  if (!isRecord(raw)) {
    issues.push(`${path}: expected object, received ${describe(raw)}`);
    return null;
  }
  checkKeys(raw, ['network', 'url'], path, issues);
  const network = raw.network;
  if (typeof network !== 'string' || !(SOCIAL_NETWORKS as readonly string[]).includes(network)) {
    issues.push(`${path}.network: expected one of ${SOCIAL_NETWORKS.join(', ')}`);
    return null;
  }
  const url = readUrl(raw.url, `${path}.url`, issues);
  return url === null ? null : { network: network as SocialLink['network'], url };
}

function readAudience(raw: unknown, path: string, issues: Issues): Audience[] | null {
  if (!Array.isArray(raw) || raw.length === 0) {
    issues.push(`${path}: expected a non-empty array of audiences`);
    return null;
  }
  const result: Audience[] = [];
  for (const [index, item] of raw.entries()) {
    if (typeof item !== 'string' || !(AUDIENCES as readonly string[]).includes(item)) {
      issues.push(`${path}[${index}]: expected one of ${AUDIENCES.join(', ')}`);
      return null;
    }
    if (result.includes(item as Audience)) {
      issues.push(`${path}[${index}]: duplicate audience`);
      return null;
    }
    result.push(item as Audience);
  }
  return result;
}

function readPrice(raw: unknown, path: string, issues: Issues): KnownPricePositioning | null {
  // "unknown" is null at the wrapper level, never a value.
  if (typeof raw !== 'string' || raw === 'unknown' || !(PRICE_POSITIONINGS as readonly string[]).includes(raw)) {
    issues.push(`${path}: expected budget, mid, premium or luxury (use null for unknown)`);
    return null;
  }
  return raw as KnownPricePositioning;
}

function readModel(raw: unknown, issues: Issues): ModelMetadata | null {
  const path = 'analysis.model';
  if (raw === null) return null;
  if (!isRecord(raw)) {
    issues.push(`${path}: expected object or null, received ${describe(raw)}`);
    return null;
  }
  checkKeys(raw, ['provider', 'model', 'modelVersion', 'contractVersion'], path, issues);
  const provider = readString(raw.provider, `${path}.provider`, 64, issues);
  const model = readString(raw.model, `${path}.model`, 128, issues);
  const contractVersion = readString(raw.contractVersion, `${path}.contractVersion`, 64, issues);
  let modelVersion: string | null = null;
  if (raw.modelVersion !== null) {
    modelVersion = readString(raw.modelVersion, `${path}.modelVersion`, 128, issues);
  }
  if (provider === null || model === null || contractVersion === null) return null;
  return { provider, model, modelVersion, contractVersion };
}

function readEnumList<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  path: string,
  issues: Issues
): T[] {
  if (!Array.isArray(raw)) {
    issues.push(`${path}: expected array, received ${describe(raw)}`);
    return [];
  }
  const result: T[] = [];
  raw.forEach((item, index) => {
    if (typeof item !== 'string' || !(allowed as readonly string[]).includes(item)) {
      issues.push(`${path}[${index}]: unknown value`);
      return;
    }
    if (result.includes(item as T)) {
      issues.push(`${path}[${index}]: duplicate value`);
      return;
    }
    result.push(item as T);
  });
  return result;
}

function readString(raw: unknown, path: string, max: number, issues: Issues): string | null {
  if (typeof raw !== 'string') {
    issues.push(`${path}: expected string, received ${describe(raw)}`);
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    issues.push(`${path}: must not be empty (use null when absent)`);
    return null;
  }
  if (trimmed.length > max) {
    issues.push(`${path}: longer than ${max} characters`);
    return null;
  }
  return trimmed;
}

/** Any URL in an analysis must itself pass the policy a fetch would apply. */
function readUrl(raw: unknown, path: string, issues: Issues): string | null {
  const s = readString(raw, path, LIMITS.url, issues);
  if (s === null) return null;
  const policy = evaluateUrl(s);
  if (!policy.ok) {
    issues.push(`${path}: rejected by url policy (${policy.reason})`);
    return null;
  }
  return policy.url;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

function checkKeys(
  source: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: Issues,
  options: { reportConfidenceSeparately?: boolean; reportSourceSeparately?: boolean } = {}
): void {
  for (const key of Object.keys(source)) {
    if (allowed.includes(key)) continue;
    if (options.reportConfidenceSeparately && key === 'confidence') continue;
    if (options.reportSourceSeparately && key === 'source') continue;
    issues.push(
      FORBIDDEN_KEY.test(key)
        ? `${path}.${key}: forbidden field — verification, trust and status cannot be represented`
        : `${path}.${key}: unknown field`
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
