import { MERCHANT_PROPOSAL_KEY } from '../contracts/shop-analysis-endpoint.ts';
import type { MerchantProposal } from '../contracts/shop-analysis-endpoint.ts';
import { SHOP_ANALYSIS_V2_CONTRACT } from '../contracts/shop-analysis-v2.ts';
import type { AnalysisWarning, ShopAnalysisV2 } from '../contracts/shop-analysis-v2.ts';
import { meanConfidence } from './shop-analyzer.ts';
import type { ExtractionSummary } from './shop-analyzer.ts';

/**
 * Persistence for ai-shop-analysis, through three SECURITY DEFINER functions
 * (supabase/migrations/20260911120000_shop_analyzer.sql) that only service_role
 * may execute:
 *
 *   begin_shop_analysis     quota, ownership, duplicate check, `running` row
 *   complete_shop_analysis  the analysis row + the merchant's proposal copy
 *   fail_shop_analysis      a blocked or failed attempt, still counted
 *
 * No table grant is involved. This module only shapes parameters and reads
 * results; it never builds SQL.
 *
 * WHAT IS WRITTEN
 *   shop_ai_analyses.raw_extraction   the validated analysis + page-level
 *                                     diagnostics (counts, title, canonical,
 *                                     favicon). Never HTML, headers, addresses,
 *                                     provider payloads or secrets.
 *   merchant_submissions.submitted_data.aiProposal
 *                                     what the merchant reviews and edits:
 *                                     observed (with provenance), inferred
 *                                     (with confidence), warnings. Other keys
 *                                     of submitted_data — the merchant's own
 *                                     edits — are left untouched.
 */

export { MERCHANT_PROPOSAL_KEY };

/**
 * Key names that must never reach a persisted document. Mirrors the SQL guard
 * in complete_shop_analysis and fail_shop_analysis: a key, not a value, so a
 * warning or an "unsupported: verification" entry is fine.
 */
export const FORBIDDEN_PERSISTED_KEY = /"[A-Za-z_]*(?:verif|trust|certif|publish|approv|owner|member|status)[A-Za-z_]*"\s*:/i;

export function hasForbiddenPersistedKey(value: unknown): boolean {
  return FORBIDDEN_PERSISTED_KEY.test(JSON.stringify(value));
}

/** Defined in ai/contracts so the app reads exactly what the server writes. */
export type { MerchantProposal };

export function buildMerchantProposal(analysis: ShopAnalysisV2, analyzedAt: string): MerchantProposal {
  return {
    proposalVersion: SHOP_ANALYSIS_V2_CONTRACT,
    analyzedAt,
    websiteUrl: analysis.target.finalUrl,
    domain: analysis.target.domain,
    observed: analysis.observed,
    inferred: analysis.inferred,
    warnings: analysis.warnings,
    unsupported: analysis.unsupported,
    degraded: analysis.degraded,
  };
}

export type CompleteShopAnalysisParams = {
  p_analysis_id: string;
  p_user_id: string;
  p_summary: string | null;
  p_detected_styles: string[];
  p_detected_audience: string[];
  p_detected_products: string[];
  p_detected_values: string[];
  p_detected_price_positioning: string | null;
  p_suggested_categories: { slug: string; confidence: number; primary: boolean }[];
  p_suggested_tags: { slug: string; confidence: number }[];
  p_confidence_score: number | null;
  p_model_provider: string | null;
  p_model_name: string | null;
  p_source_hash: string;
  p_raw_extraction: Record<string, unknown>;
  p_proposal: MerchantProposal;
};

export function toCompleteShopAnalysisParams(input: {
  analysisId: string;
  userId: string;
  analysis: ShopAnalysisV2;
  sourceHash: string;
  summary: ExtractionSummary;
  analyzedAt: string;
}): CompleteShopAnalysisParams {
  const { analysis } = input;
  const inferred = analysis.inferred;

  return {
    p_analysis_id: input.analysisId,
    p_user_id: input.userId,
    p_summary: inferred.summary?.value ?? null,
    p_detected_styles: inferred.styles.map((entry) => entry.value),
    p_detected_audience: inferred.audience?.value ?? [],
    p_detected_products: inferred.productTypes.map((entry) => entry.value),
    p_detected_values: inferred.values.map((entry) => entry.value),
    p_detected_price_positioning: inferred.pricePositioning?.value ?? null,
    p_suggested_categories: [
      ...(inferred.primaryCategory
        ? [{ slug: inferred.primaryCategory.value, confidence: inferred.primaryCategory.confidence, primary: true }]
        : []),
      ...inferred.secondaryCategories.map((entry) => ({
        slug: entry.value,
        confidence: entry.confidence,
        primary: false,
      })),
    ],
    p_suggested_tags: inferred.tags.map((entry) => ({ slug: entry.value, confidence: entry.confidence })),
    p_confidence_score: meanConfidence(inferred),
    p_model_provider: analysis.model?.provider ?? null,
    p_model_name: analysis.model?.model ?? null,
    p_source_hash: input.sourceHash,
    p_raw_extraction: {
      contractVersion: analysis.contractVersion,
      target: analysis.target,
      model: analysis.model,
      degraded: analysis.degraded,
      warnings: analysis.warnings,
      unsupported: analysis.unsupported,
      observed: analysis.observed,
      inferred: analysis.inferred,
      extraction: input.summary,
    },
    p_proposal: buildMerchantProposal(analysis, input.analyzedAt),
  };
}

export type FailShopAnalysisParams = {
  p_analysis_id: string;
  p_user_id: string;
  p_error_code: string;
  p_raw_extraction: { warnings: AnalysisWarning[] };
};

export function toFailShopAnalysisParams(input: {
  analysisId: string;
  userId: string;
  code: string;
  warnings: readonly AnalysisWarning[];
}): FailShopAnalysisParams {
  const code = /^[a-z][a-z0-9_]{0,63}$/.test(input.code) ? input.code : 'internal_error';
  return {
    p_analysis_id: input.analysisId,
    p_user_id: input.userId,
    p_error_code: code,
    p_raw_extraction: { warnings: [...input.warnings] },
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type BeginOutcome =
  | { outcome: 'started'; analysisId: string; submissionId: string }
  | { outcome: 'rate_limited' | 'already_running'; retryAfterSeconds: number }
  | { outcome: 'shop_exists'; existingShopId: string }
  | { outcome: 'submission_not_found' }
  | { outcome: 'submission_locked'; submissionId: string };

export interface ShopAnalysisStore {
  begin(input: {
    userId: string;
    submissionId: string | null;
    sourceUrl: string;
    domain: string;
  }): Promise<BeginOutcome>;
  /** True when the proposal was copied into the submission. */
  complete(params: CompleteShopAnalysisParams): Promise<boolean>;
  fail(params: FailShopAnalysisParams): Promise<void>;
}

export type RpcResult = { data: unknown; error: { code?: string } | null };
export type RpcCaller = (fn: string, params: Record<string, unknown>) => PromiseLike<RpcResult>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The error carries the SQLSTATE only: a database message can quote a value. */
export class ShopAnalysisStoreError extends Error {
  constructor(operation: string, readonly sqlState: string | null) {
    super(`${operation} failed${sqlState ? ` (${sqlState})` : ''}`);
    this.name = 'ShopAnalysisStoreError';
  }
}

export function createRpcShopAnalysisStore(rpc: RpcCaller): ShopAnalysisStore {
  return {
    async begin(input) {
      const { data, error } = await rpc('begin_shop_analysis', {
        p_user_id: input.userId,
        p_submission_id: input.submissionId,
        p_source_url: input.sourceUrl,
        p_domain: input.domain,
      });
      if (error) throw new ShopAnalysisStoreError('begin_shop_analysis', error.code ?? null);
      return parseBeginRow(Array.isArray(data) ? data[0] : data);
    },

    async complete(params) {
      const { data, error } = await rpc('complete_shop_analysis', params);
      if (error) throw new ShopAnalysisStoreError('complete_shop_analysis', error.code ?? null);
      return data === true;
    },

    async fail(params) {
      const { error } = await rpc('fail_shop_analysis', params);
      if (error) throw new ShopAnalysisStoreError('fail_shop_analysis', error.code ?? null);
    },
  };
}

export function parseBeginRow(row: unknown): BeginOutcome {
  if (typeof row !== 'object' || row === null) {
    throw new ShopAnalysisStoreError('begin_shop_analysis result', null);
  }
  const record = row as Record<string, unknown>;
  const uuid = (value: unknown) => (typeof value === 'string' && UUID.test(value) ? value : null);
  const retry =
    typeof record.retry_after_seconds === 'number' &&
    Number.isInteger(record.retry_after_seconds) &&
    record.retry_after_seconds > 0
      ? Math.min(record.retry_after_seconds, 86_400)
      : 60;

  switch (record.outcome) {
    case 'started': {
      const analysisId = uuid(record.analysis_id);
      const submissionId = uuid(record.target_submission_id);
      if (analysisId && submissionId) return { outcome: 'started', analysisId, submissionId };
      break;
    }
    case 'rate_limited':
    case 'already_running':
      return { outcome: record.outcome, retryAfterSeconds: retry };
    case 'shop_exists': {
      const existingShopId = uuid(record.existing_shop_id);
      if (existingShopId) return { outcome: 'shop_exists', existingShopId };
      break;
    }
    case 'submission_not_found':
      return { outcome: 'submission_not_found' };
    case 'submission_locked': {
      const submissionId = uuid(record.target_submission_id);
      if (submissionId) return { outcome: 'submission_locked', submissionId };
      break;
    }
  }
  throw new ShopAnalysisStoreError('begin_shop_analysis result', null);
}
