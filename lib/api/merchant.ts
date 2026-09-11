import { FunctionsHttpError } from '@supabase/supabase-js';

import {
  interpretShopAnalysisResponse,
  type MerchantAnalysisResult,
} from '@/lib/merchant/analysis-response';
import {
  claimFailureOf,
  openClaimOf,
  readClaimToken,
  type ClaimFailure,
  type ClaimToken,
  type OpenClaim,
} from '@/lib/merchant/claim';
import type { MerchantSubmissionUpdate, MerchantTaxonomy } from '@/lib/merchant/profile';
import { submitOutcomeOf, type SubmitOutcome } from '@/lib/merchant/submit';
import { hostOfUrl } from '@/lib/merchant/url';
import { supabase } from '@/lib/supabase';

/**
 * The merchant flow's only access to the backend.
 *
 * Everything runs as the signed-in user: the Edge Function call carries the
 * session JWT, and every table read or write goes through RLS and the column
 * grants deployed in Prompt 16. There is no elevated credential here and there
 * can be none — only the publishable key ships in the app.
 *
 * What this module can write: `merchant_submissions.submitted_data` and
 * `status` (to `submitted`), and a pending claim through request_shop_claim.
 * It cannot set a reviewer, a shop, a membership, a verification or a
 * publication — the grants do not allow it and no function here tries.
 */

const ANALYSIS_FUNCTION = 'ai-shop-analysis';

/** Network budget (10 s) + model (25 s) + database, with margin. */
const ANALYSIS_TIMEOUT_MS = 75_000;

export class MerchantApiError extends Error {
  readonly code: string | null;
  constructor(operation: string, code: string | null) {
    super(`Merchant request failed: ${operation}`);
    this.name = 'MerchantApiError';
    this.code = code;
  }
}

function client() {
  if (!supabase) {
    throw new MerchantApiError('client', 'not_configured');
  }
  return supabase;
}

function logFailure(operation: string, code: string | null | undefined): void {
  if (__DEV__) {
    console.warn(`[merchant] ${operation} failed`, { code: code ?? null });
  }
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/**
 * Asks the server to analyse a shop site.
 *
 * The URL was already checked locally; the server checks it again, resolves
 * and pins the address, respects robots.txt, and applies the quota. The user
 * id is never sent — the server reads it from the token.
 */
export async function analyzeShopWebsite(
  websiteUrl: string,
  submissionId: string | null
): Promise<MerchantAnalysisResult> {
  if (!supabase) {
    return interpretShopAnalysisResponse({ status: 503, body: null, retryAfter: null });
  }

  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session) {
    return interpretShopAnalysisResponse({ status: 401, body: null, retryAfter: null });
  }

  try {
    const { data, error } = await supabase.functions.invoke(ANALYSIS_FUNCTION, {
      body: { websiteUrl, locale: 'fr', ...(submissionId ? { submissionId } : {}) },
      timeout: ANALYSIS_TIMEOUT_MS,
    });

    if (!error) {
      return interpretShopAnalysisResponse({ status: 200, body: data, retryAfter: null });
    }

    if (error instanceof FunctionsHttpError) {
      const response = error.context as Response;
      const body: unknown = await response
        .clone()
        .json()
        .catch(() => null);
      return interpretShopAnalysisResponse({
        status: response.status,
        body,
        retryAfter: response.headers.get('retry-after'),
      });
    }

    logFailure('analyzeShopWebsite', error.name);
    return interpretShopAnalysisResponse({ status: null, body: null, retryAfter: null });
  } catch (caught) {
    logFailure('analyzeShopWebsite', caught instanceof Error ? caught.name : null);
    return interpretShopAnalysisResponse({ status: null, body: null, retryAfter: null });
  }
}

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

export type MerchantSubmission = {
  id: string;
  websiteUrl: string;
  status: string;
  submittedData: unknown;
  /** submitted_data.aiProposal, as stored. Read defensively by the form. */
  proposal: unknown;
};

/** Editable by the merchant: the statuses the update policy lets them change. */
export const EDITABLE_SUBMISSION_STATUSES = ['draft', 'needs_changes'] as const;

export function isEditableSubmission(submission: Pick<MerchantSubmission, 'status'>): boolean {
  return (EDITABLE_SUBMISSION_STATUSES as readonly string[]).includes(submission.status);
}

/** The caller's own submission, or null. RLS hides everyone else's. */
export async function getMerchantSubmission(id: string): Promise<MerchantSubmission | null> {
  const { data, error } = await client()
    .from('merchant_submissions')
    .select('id, website_url, status, submitted_data')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    logFailure('getMerchantSubmission', error.code);
    throw new MerchantApiError('getMerchantSubmission', error.code ?? null);
  }
  if (!data) {
    return null;
  }

  const row = data as { id: string; website_url: string; status: string; submitted_data: unknown };
  const submittedData = row.submitted_data;
  const proposal =
    typeof submittedData === 'object' && submittedData !== null && !Array.isArray(submittedData)
      ? (submittedData as Record<string, unknown>).aiProposal ?? null
      : null;

  return {
    id: row.id,
    websiteUrl: row.website_url,
    status: row.status,
    submittedData,
    proposal,
  };
}

export type { SubmitOutcome };

/**
 * Sends the request: submitted_data and status, nothing else.
 *
 * An UPDATE of the submission the analysis created — never an INSERT — and
 * filtered on the editable statuses, so a request already sent is never
 * rewritten; the RLS update policy enforces the same rule server-side.
 */
export async function submitMerchantSubmission(
  id: string,
  update: MerchantSubmissionUpdate
): Promise<SubmitOutcome> {
  const { data, error } = await client()
    .from('merchant_submissions')
    .update({ submitted_data: update.submitted_data, status: update.status })
    .eq('id', id)
    .in('status', [...EDITABLE_SUBMISSION_STATUSES])
    .select('id')
    .maybeSingle();

  if (error) {
    logFailure('submitMerchantSubmission', error.code);
  }
  return submitOutcomeOf({ data, error });
}

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

/**
 * The live categories and tags a profile may use.
 *
 * Origin tags (made-in-france) are left out: an origin is declared and then
 * verified, it is not picked from a list during onboarding.
 */
export async function getMerchantTaxonomy(): Promise<MerchantTaxonomy> {
  const db = client();
  const [categories, tags] = await Promise.all([
    db.from('categories').select('slug, name').eq('is_active', true).order('sort_order', { ascending: true }),
    db.from('tags').select('slug, name, kind').order('name', { ascending: true }),
  ]);

  if (categories.error || tags.error) {
    const code = categories.error?.code ?? tags.error?.code ?? null;
    logFailure('getMerchantTaxonomy', code);
    throw new MerchantApiError('getMerchantTaxonomy', code);
  }

  const categoryRows = (categories.data ?? []) as { slug: unknown; name: unknown }[];
  const tagRows = (tags.data ?? []) as { slug: unknown; name: unknown; kind: unknown }[];

  return {
    categories: categoryRows
      .filter((row): row is { slug: string; name: string } => typeof row.slug === 'string' && typeof row.name === 'string')
      .map(({ slug, name }) => ({ slug, name })),
    tags: tagRows
      .filter(
        (row): row is { slug: string; name: string; kind: unknown } =>
          typeof row.slug === 'string' && typeof row.name === 'string' && row.kind !== 'origin'
      )
      .map(({ slug, name }) => ({ slug, name })),
  };
}

// ---------------------------------------------------------------------------
// Existing shops and claims
// ---------------------------------------------------------------------------

export type ShopSummary = { id: string; name: string; websiteUrl: string | null };

/** A published shop by id. Drafts and other statuses are not visible. */
export async function getPublishedShopSummary(shopId: string): Promise<ShopSummary | null> {
  const { data, error } = await client()
    .from('shops')
    .select('id, name, website_url')
    .eq('id', shopId)
    .eq('status', 'published')
    .maybeSingle();

  if (error) {
    logFailure('getPublishedShopSummary', error.code);
    throw new MerchantApiError('getPublishedShopSummary', error.code ?? null);
  }
  if (!data) {
    return null;
  }
  const row = data as { id: string; name: string; website_url: string | null };
  return { id: row.id, name: row.name, websiteUrl: row.website_url };
}

/**
 * A published shop on exactly this host, for "my shop is already listed".
 *
 * Narrowed with ilike, then matched on the exact host: `shop.fr` and
 * `www.shop.fr` are different hosts, as they are for claims.
 */
export async function findPublishedShopByHost(hostname: string): Promise<ShopSummary | null> {
  const { data, error } = await client()
    .from('shops')
    .select('id, name, website_url')
    .eq('status', 'published')
    .ilike('website_url', `%${hostname}%`)
    .limit(20);

  if (error) {
    logFailure('findPublishedShopByHost', error.code);
    throw new MerchantApiError('findPublishedShopByHost', error.code ?? null);
  }

  const rows = (data ?? []) as { id: string; name: string; website_url: string | null }[];
  const match = rows.find((row) => hostOfUrl(row.website_url) === hostname);
  return match ? { id: match.id, name: match.name, websiteUrl: match.website_url } : null;
}

/** Whether the signed-in user already belongs to this shop. RLS shows only their own shops. */
export async function isMemberOfShop(shopId: string): Promise<boolean> {
  const db = client();
  const { data: sessionData } = await db.auth.getSession();
  const userId = sessionData.session?.user.id;
  if (!userId) {
    return false;
  }

  const { data, error } = await db
    .from('shop_members')
    .select('shop_id')
    .eq('shop_id', shopId)
    .eq('user_id', userId)
    .limit(1);

  if (error) {
    logFailure('isMemberOfShop', error.code);
    throw new MerchantApiError('isMemberOfShop', error.code ?? null);
  }
  return (data ?? []).length > 0;
}

/** The caller's own pending, unexpired claim on this shop. */
export async function getMyOpenClaim(shopId: string): Promise<OpenClaim | null> {
  const { data, error } = await client()
    .from('shop_claims')
    .select('id, status, expires_at')
    .eq('shop_id', shopId)
    .order('created_at', { ascending: false })
    .limit(5);

  if (error) {
    logFailure('getMyOpenClaim', error.code);
    throw new MerchantApiError('getMyOpenClaim', error.code ?? null);
  }
  return openClaimOf((data ?? []) as { id?: unknown; status?: unknown; expires_at?: unknown }[]);
}

export type ClaimRequestOutcome = { ok: true; claim: ClaimToken } | { ok: false; failure: ClaimFailure };

/**
 * Opens or rotates the caller's pending claim and returns the one-time token.
 * Never approves, never verifies, never creates a membership.
 */
export async function requestShopClaim(shopId: string): Promise<ClaimRequestOutcome> {
  const { data, error } = await client().rpc('request_shop_claim', { p_shop_id: shopId });

  if (error) {
    logFailure('requestShopClaim', error.code);
    return { ok: false, failure: claimFailureOf(error) };
  }
  const claim = readClaimToken(data);
  return claim ? { ok: true, claim } : { ok: false, failure: 'unknown' };
}
