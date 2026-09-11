/**
 * Trust, verification, moderation and shop management — Prompt 17.
 *
 * Client-safe: types and constants only, shared by the verify-shop-claim Edge
 * Function, the SQL functions' callers and the app.
 *
 * THE TRUST MODEL, in one place:
 *
 *   merchant data   what a merchant wrote (merchant_submissions.submitted_data,
 *                   shop content they edit). Untrusted until reviewed.
 *   observed data   what the server read on the site (shop_ai_analyses).
 *   AI suggestions  proposals only; never evidence of anything.
 *   verifications   issued by the server or an administrator only, in
 *                   shop_verifications. A client can never write one.
 *   moderation      a submission's review status, decided by a moderator
 *                   through a SECURITY DEFINER function.
 *
 * There is no score. A verification states one precise fact — "this account
 * controls this domain" — and nothing about legality, quality or safety.
 */

// ---------------------------------------------------------------------------
// Domain-control verification of a claim
// ---------------------------------------------------------------------------

/** `<meta name="shop-discovery-verification" content="TOKEN">` on the home page. */
export const CLAIM_META_NAME = 'shop-discovery-verification' as const;

/** The token request_shop_claim returns once. Only its SHA-256 is stored. */
export const CLAIM_TOKEN_PATTERN = /^sd-claim-[0-9a-f]{64}$/;

export const CLAIM_VERIFICATION_LIMITS = {
  /** Mirrors begin_claim_verification. */
  attemptsPerClaimPerHour: 5,
  attemptsPerUserPerHour: 15,
  /** Distinct candidate tokens read from one page. */
  maxCandidates: 8,
  /** A domain-control verification is valid for a year, then expires. */
  validityDays: 365,
} as const;

export const CLAIM_VERIFICATION_OUTCOMES = [
  'verified',
  'token_absent',
  'token_mismatch',
  'claim_expired',
  'claim_not_found',
  'claim_closed',
  'already_member',
  'shop_already_claimed',
  'shop_unavailable',
  'domain_mismatch',
  'redirect_off_domain',
  'robots_disallowed',
  'site_unreachable',
  'timeout',
  'tls_failed',
  'too_large',
  'not_html',
  'rate_limited',
  'already_running',
] as const;
export type ClaimVerificationOutcome = (typeof CLAIM_VERIFICATION_OUTCOMES)[number];

/**
 * The only thing POST /verify-shop-claim returns on success. No host, address,
 * token, hash, redirect chain or network detail.
 */
export type ClaimVerificationResult = {
  outcome: ClaimVerificationOutcome;
  /** Set only when `verified`: the shop now managed by the caller. */
  shopId: string | null;
  retryAfterSeconds: number | null;
};

/** What a successful claim verification certifies. Nothing more. */
export const DOMAIN_CONTROL_VERIFICATION = 'domain' as const;

/** Public wording. Deliberately narrow: never "safe", "trusted" or "certified". */
export const PUBLIC_VERIFICATION_LABELS = {
  domain: 'Domaine vérifié',
} as const;

// ---------------------------------------------------------------------------
// Submissions and moderation
// ---------------------------------------------------------------------------

export const MERCHANT_SUBMISSION_STATUSES = [
  'draft',
  'submitted',
  'processing',
  'needs_changes',
  'approved',
  'rejected',
] as const;
export type MerchantSubmissionStatus = (typeof MERCHANT_SUBMISSION_STATUSES)[number];

export const MODERATION_ACTIONS = ['approve', 'needs_changes', 'reject'] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

export const MODERATION_OUTCOMES = [
  'approved',
  'needs_changes',
  'rejected',
  'submission_not_found',
  'already_reviewed',
  'not_submitted',
  'own_submission',
  'note_required',
  'invalid_note',
  'invalid_profile',
  'duplicate_shop',
  'slug_unavailable',
  'conflict',
] as const;
export type ModerationOutcome = (typeof MODERATION_OUTCOMES)[number];

export const MODERATION_NOTE_MAX = 500;

/** Future notifications (none in V1): the state is visible in the profile. */
export type SubmissionNotificationKind = 'submission_approved' | 'submission_needs_changes' | 'submission_rejected';

// ---------------------------------------------------------------------------
// Shop management
// ---------------------------------------------------------------------------

export const SHOP_MEMBER_ROLES = ['owner', 'admin', 'editor'] as const;
export type ShopMemberRole = (typeof SHOP_MEMBER_ROLES)[number];

/** The roles the existing shops_update_by_members policy lets edit content. */
export const SHOP_CONTENT_EDITOR_ROLES: readonly ShopMemberRole[] = ['owner', 'admin'];

/**
 * What a merchant may change on a shop they manage. Never the id, slug,
 * domain, status, publication, claim, verification, reviewer or membership.
 */
export type MerchantShopManagement = {
  shopId: string;
  name: string;
  shortDescription: string | null;
  primaryCategory: string;
  secondaryCategories: string[];
  tags: string[];
  audience: 'women' | 'men' | 'kids' | 'unisex' | 'all' | null;
  priceLevel: 1 | 2 | 3 | 4 | null;
  removedImageIds: string[];
};

export const MANAGE_SHOP_OUTCOMES = ['updated', 'shop_locked', 'invalid'] as const;
export type ManageShopOutcome = (typeof MANAGE_SHOP_OUTCOMES)[number];

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/** Offered in the app. `scam_suspected` and `counterfeit` stay in the schema. */
export const SHOP_REPORT_REASONS = ['misleading_information', 'website_unavailable', 'impersonation', 'other'] as const;
export type ShopReportReason = (typeof SHOP_REPORT_REASONS)[number];

export const SHOP_REPORT_DESCRIPTION_MAX = 2000;
