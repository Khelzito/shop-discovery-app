import type {
  Audience,
  Confidence,
  CountryCode,
  CurrencyCode,
  PricePositioning,
  Slug,
} from './common.ts';
import type { ModelMetadata } from './model.ts';

/**
 * Shop Analyzer contract, version 2.
 *
 * Version 1 (./shop-analysis.ts) stays exported and unchanged: it is the
 * inferred-only shape the existing service, validator and persistence mapper
 * are written against. Version 2 is what the ai-shop-analysis Edge Function
 * will return, and it adds what v1 could not express — the difference between
 * what a site SAYS and what a model THINKS.
 *
 * Three categories, kept structurally apart:
 *
 *   OBSERVED   read deterministically from the site. Carries provenance, never
 *              a confidence: a value is either present on the page or absent.
 *   INFERRED   a model's interpretation. Carries a confidence, never a
 *              provenance: it is an opinion, not something that was read.
 *   FORBIDDEN  has NO field anywhere in this file. Verification, trust,
 *              reliability, legal or business status, certification and
 *              publication cannot be represented, so no code path — model
 *              output, a hostile page, a crafted request — can carry them.
 *
 * The validator (ai/server/shop-analysis-v2.ts) rejects unknown keys at every
 * level, so "cannot be represented" holds at runtime, not only in the types.
 */

export const SHOP_ANALYSIS_V2_CONTRACT = 'shop-analysis/2' as const;

// ---------------------------------------------------------------------------
// Limits — one place, mirrored by the database where a column exists
// ---------------------------------------------------------------------------

export const SHOP_ANALYSIS_V2_LIMITS = {
  url: 2048,
  domain: 253,
  maxRedirects: 3,
  /** shops.name CHECK (1..120). */
  name: 120,
  observedDescription: 500,
  language: 16,
  imageUrls: 6,
  socialLinks: 10,
  siteSectionLabels: 12,
  siteSectionLabel: 60,
  provenanceToken: 64,
  provenancePath: 128,
  /** shops.short_description CHECK (<= 280). */
  shortDescription: 280,
  secondaryCategories: 3,
  /** docs/DATABASE.md: roughly five primary tags. */
  tags: 5,
  freeTextItems: 8,
  freeTextItem: 40,
  summary: 1000,
} as const;

// ---------------------------------------------------------------------------
// Provenance — OBSERVED only
// ---------------------------------------------------------------------------

export const PROVENANCE_KINDS = ['url', 'html_meta', 'html_link', 'json_ld', 'page_text'] as const;
export type ProvenanceKind = (typeof PROVENANCE_KINDS)[number];

/** Where an observed value was read. */
export type Provenance =
  /** Derived from the URL itself. */
  | { kind: 'url' }
  /** A meta tag: `{ key: 'og:site_name' }`, `{ key: 'description' }`. */
  | { kind: 'html_meta'; key: string }
  /** A link element: `{ rel: 'icon' }`, `{ rel: 'apple-touch-icon' }`. */
  | { kind: 'html_link'; rel: string }
  /** Structured data: `{ type: 'Organization', path: 'address.addressCountry' }`. */
  | { kind: 'json_ld'; type: string; path: string }
  /** Visible text. */
  | { kind: 'page_text' };

/** A fact read on the site. No confidence: it was read, or it was not. */
export type Observed<T> = { value: T; source: Provenance };

/** A model's interpretation. Always carries its confidence. */
export type Inferred<T> = { value: T; confidence: Confidence };

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

export const SOCIAL_NETWORKS = [
  'instagram',
  'tiktok',
  'facebook',
  'pinterest',
  'youtube',
  'x',
  'linkedin',
] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];

export type SocialLink = { network: SocialNetwork; url: string };

/** Why an analysis is partial. Closed: an unknown warning is a validation error. */
export const ANALYSIS_WARNINGS = [
  /** D5: robots.txt forbids the page. Nothing was fetched; manual entry. */
  'robots_disallowed',
  'redirect_limit',
  'fetch_blocked',
  'timeout',
  'content_too_large',
  'non_html_content',
  /** Almost no text: a client-rendered site. */
  'little_text_js_rendered',
  'no_structured_data',
  'language_not_french',
  'model_unavailable',
  'low_confidence',
  /** The page contained text addressed to a model. It was treated as data. */
  'possible_prompt_injection',
] as const;
export type AnalysisWarning = (typeof ANALYSIS_WARNINGS)[number];

/**
 * What an analysis deliberately never produces, returned so the UI can say
 * "à renseigner par vous" instead of leaving a silent gap.
 *
 * Listing a field here is not the same as forbidding it in the schema: these
 * are the things a merchant may still need to state, and none of them can be
 * stated by a model.
 */
export const UNSUPPORTED_FIELDS = [
  'verification',
  'trust_score',
  'legal_entity',
  'shipping_countries',
  'return_policy',
  'certifications',
] as const;
export type UnsupportedField = (typeof UNSUPPORTED_FIELDS)[number];

/** A known price band. "Unknown" is expressed as `null`, never as a value. */
export type KnownPricePositioning = Exclude<PricePositioning, 'unknown'>;

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

export type ShopAnalysisTarget = {
  requestedUrl: string;
  /** After redirects, each re-validated. */
  finalUrl: string;
  /** Exact host of `finalUrl`, punycode. */
  domain: string;
  redirectCount: number;
};

/** CATEGORY 1 — deterministic extraction. No model is involved. */
export type ShopObserved = {
  name: Observed<string> | null;
  /** Verbatim. A quote from the site, not a claim by us. */
  description: Observed<string> | null;
  language: Observed<string> | null;
  countryCode: Observed<CountryCode> | null;
  currency: Observed<CurrencyCode> | null;
  logoUrl: Observed<string> | null;
  imageUrls: Observed<string>[];
  socialLinks: Observed<SocialLink>[];
  siteSectionLabels: Observed<string>[];
};

/** CATEGORY 2 — model interpretation. Suggestions until the merchant accepts. */
export type ShopInferred = {
  shortDescription: Inferred<string> | null;
  /** A slug from `categories`. Whitelisted against the live taxonomy. */
  primaryCategory: Inferred<Slug> | null;
  secondaryCategories: Inferred<Slug>[];
  audience: Inferred<Audience[]> | null;
  pricePositioning: Inferred<KnownPricePositioning> | null;
  styles: Inferred<string>[];
  values: Inferred<string>[];
  productTypes: Inferred<string>[];
  /** Slugs from `tags`. */
  tags: Inferred<Slug>[];
  summary: Inferred<string> | null;
};

export type ShopAnalysisV2 = {
  contractVersion: typeof SHOP_ANALYSIS_V2_CONTRACT;
  target: ShopAnalysisTarget;
  observed: ShopObserved;
  inferred: ShopInferred;
  warnings: AnalysisWarning[];
  unsupported: UnsupportedField[];
  /** Null when no model ran: then `inferred` must be empty. */
  model: ModelMetadata | null;
  /** True when the model tier did not contribute. */
  degraded: boolean;
};

// ---------------------------------------------------------------------------
// Wire
// ---------------------------------------------------------------------------

/**
 * POST /ai/shop-analysis — v2.
 *
 * Deliberately carries NO verification, status or trust field. Authorization
 * comes from the JWT, never from the body, and an unknown key is a 400.
 */
export type ShopAnalysisRequestV2 = {
  websiteUrl: string;
  /** Must belong to the caller; checked server-side against the JWT. */
  submissionId?: string;
  locale?: 'fr';
};

export type ShopAnalysisResponseV2 = {
  analysis: ShopAnalysisV2;
  /** The `shop_ai_analyses` row, when persistence succeeded. */
  analysisId: string | null;
};

/** An analysis that says nothing: the safe starting point for a builder. */
export function emptyShopAnalysisV2(target: ShopAnalysisTarget): ShopAnalysisV2 {
  return {
    contractVersion: SHOP_ANALYSIS_V2_CONTRACT,
    target,
    observed: {
      name: null,
      description: null,
      language: null,
      countryCode: null,
      currency: null,
      logoUrl: null,
      imageUrls: [],
      socialLinks: [],
      siteSectionLabels: [],
    },
    inferred: {
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
    },
    warnings: [],
    unsupported: [...UNSUPPORTED_FIELDS],
    model: null,
    degraded: true,
  };
}
