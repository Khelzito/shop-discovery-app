import type { Audience } from './common.ts';
import type {
  AnalysisWarning,
  KnownPricePositioning,
  SHOP_ANALYSIS_V2_CONTRACT,
  ShopAnalysisResponseV2,
  ShopAnalysisV2,
  UnsupportedField,
} from './shop-analysis-v2.ts';

/**
 * The merchant flow's wire and storage contracts, shared by the
 * ai-shop-analysis Edge Function and the app.
 *
 * Client-safe: types and constants only. What deliberately has no field here —
 * internal diagnostics, addresses, DNS answers, headers, source hashes,
 * provider output, verification, trust, publication — cannot reach the app
 * through these types.
 */

// ---------------------------------------------------------------------------
// POST /ai-shop-analysis — success payload
// ---------------------------------------------------------------------------

export const SHOP_ANALYSIS_ENDPOINT_OUTCOMES = ['analyzed', 'blocked', 'shop_exists'] as const;
export type ShopAnalysisEndpointOutcome = (typeof SHOP_ANALYSIS_ENDPOINT_OUTCOMES)[number];

/**
 * `analyzed` — a validated analysis, possibly degraded (no model).
 * `blocked`  — nothing could be read (robots.txt, fetch refused, timeout...);
 *              the analysis is empty and its single warning says why.
 * `shop_exists` — a published shop already lives on this exact host; nothing
 *              was fetched and no submission was created.
 */
export type ShopAnalysisEndpointData =
  | (ShopAnalysisResponseV2 & {
      outcome: 'analyzed' | 'blocked';
      submissionId: string;
      proposalSaved: boolean;
    })
  | { outcome: 'shop_exists'; existingShopId: string };

// ---------------------------------------------------------------------------
// merchant_submissions.submitted_data
// ---------------------------------------------------------------------------

/** Written by the server after an analysis. The app reads it, never writes it. */
export const MERCHANT_PROPOSAL_KEY = 'aiProposal' as const;

export type MerchantProposal = {
  proposalVersion: typeof SHOP_ANALYSIS_V2_CONTRACT;
  analyzedAt: string;
  websiteUrl: string;
  domain: string;
  observed: ShopAnalysisV2['observed'];
  inferred: ShopAnalysisV2['inferred'];
  warnings: AnalysisWarning[];
  unsupported: UnsupportedField[];
  degraded: boolean;
};

/** Written by the merchant when they send their request. */
export const MERCHANT_PROFILE_KEY = 'merchantProfile' as const;
export const MERCHANT_PROFILE_VERSION = 'merchant-profile/1' as const;

/** Mirrors the database and shop-analysis/2 limits. */
export const MERCHANT_PROFILE_LIMITS = {
  /** shops.name CHECK (1..120). */
  name: 120,
  /** shops.short_description CHECK (<= 280). */
  shortDescription: 280,
  secondaryCategories: 3,
  tags: 5,
  listItems: 8,
  listItem: 40,
  imageUrls: 6,
} as const;

export const MERCHANT_PROFILE_FIELDS = [
  'name',
  'shortDescription',
  'primaryCategory',
  'secondaryCategories',
  'audience',
  'pricePositioning',
  'styles',
  'values',
  'productTypes',
  'tags',
  'logoUrl',
  'imageUrls',
] as const;
export type MerchantProfileField = (typeof MERCHANT_PROFILE_FIELDS)[number];

/**
 * Where each submitted value came from, for the reviewer.
 *
 * `site` — detected on the merchant's own site; `ai` — suggested by the model
 * and left as is; `merchant` — written or changed by the merchant. None of
 * these makes anything verified: the review decides.
 */
export type MerchantValueOrigin = 'site' | 'ai' | 'merchant';

/**
 * The merchant's final, edited profile.
 *
 * Holds content only. There is no verification, trust, status, ownership or
 * publication field, and the client is only granted INSERT/UPDATE on
 * `website_url`, `submitted_data` and `status` anyway.
 */
export type MerchantProfile = {
  profileVersion: typeof MERCHANT_PROFILE_VERSION;
  editedAt: string;
  websiteUrl: string;
  name: string;
  shortDescription: string | null;
  /** Category slug from the live taxonomy. */
  primaryCategory: string;
  secondaryCategories: string[];
  audience: Audience[];
  pricePositioning: KnownPricePositioning | null;
  styles: string[];
  values: string[];
  productTypes: string[];
  /** Tag slugs from the live vocabulary. */
  tags: string[];
  /** Only ever one the site exposed. */
  logoUrl: string | null;
  /** A subset of the images the site exposed. */
  imageUrls: string[];
  origins: Record<MerchantProfileField, MerchantValueOrigin>;
};
