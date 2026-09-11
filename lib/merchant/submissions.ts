import { MERCHANT_SUBMISSION_STATUSES } from '../../ai/contracts/merchant-trust';
import type { MerchantSubmissionStatus } from '../../ai/contracts/merchant-trust';
import { hostOfUrl } from './url';

/**
 * What a merchant sees of their own requests.
 *
 * Plain words for each status, and the one action that makes sense from it.
 * No delay is promised: nobody can keep a promise about when a human reviews.
 */

export type SubmissionAction = 'edit' | 'manage' | null;

export type SubmissionStatusView = {
  status: MerchantSubmissionStatus;
  label: string;
  description: string;
  action: SubmissionAction;
  /** Whether the reviewer's note is meant for the merchant in this status. */
  showNote: boolean;
};

const VIEWS: Record<MerchantSubmissionStatus, Omit<SubmissionStatusView, 'status'>> = {
  draft: {
    label: 'Brouillon',
    description: 'Votre fiche n’a pas encore été envoyée.',
    action: 'edit',
    showNote: false,
  },
  submitted: {
    label: 'En cours de vérification',
    description: 'Nous vérifions les informations avant toute publication.',
    action: null,
    showNote: false,
  },
  processing: {
    label: 'Vérification en cours',
    description: 'Votre demande est en cours d’examen.',
    action: null,
    showNote: false,
  },
  needs_changes: {
    label: 'Modifications demandées',
    description: 'Quelques informations sont à revoir avant la publication.',
    action: 'edit',
    showNote: true,
  },
  approved: {
    label: 'Boutique approuvée',
    description: 'Votre boutique est publiée.',
    action: 'manage',
    showNote: false,
  },
  rejected: {
    label: 'Demande refusée',
    description: 'Votre demande n’a pas été retenue.',
    action: null,
    showNote: true,
  },
};

export const SUBMISSION_ACTION_LABELS: Record<Exclude<SubmissionAction, null>, string> = {
  edit: 'Modifier ma fiche',
  manage: 'Gérer ma boutique',
};

export function submissionStatusView(status: unknown): SubmissionStatusView | null {
  return (MERCHANT_SUBMISSION_STATUSES as readonly unknown[]).includes(status)
    ? { status: status as MerchantSubmissionStatus, ...VIEWS[status as MerchantSubmissionStatus] }
    : null;
}

export type MerchantSubmissionSummary = {
  id: string;
  status: MerchantSubmissionStatus;
  websiteUrl: string;
  host: string | null;
  /** From the merchant's own profile, when they reached that step. */
  proposedName: string | null;
  reviewNote: string | null;
  shopId: string | null;
  updatedAt: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rows of the caller's own submissions, newest first; malformed rows dropped. */
export function toSubmissionSummaries(rows: readonly unknown[]): MerchantSubmissionSummary[] {
  const summaries: MerchantSubmissionSummary[] = [];
  for (const raw of rows) {
    const row = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
    if (!row || typeof row.id !== 'string' || !UUID.test(row.id) || typeof row.website_url !== 'string') continue;
    const view = submissionStatusView(row.status);
    if (!view || typeof row.updated_at !== 'string') continue;
    const name = typeof row.proposed_name === 'string' ? row.proposed_name.trim().slice(0, 120) : '';
    const note = typeof row.review_note === 'string' ? row.review_note.trim() : '';
    summaries.push({
      id: row.id,
      status: view.status,
      websiteUrl: row.website_url,
      host: hostOfUrl(row.website_url),
      proposedName: name.length > 0 ? name : null,
      reviewNote: note.length > 0 ? note : null,
      shopId: typeof row.shop_id === 'string' && UUID.test(row.shop_id) ? row.shop_id : null,
      updatedAt: row.updated_at,
    });
  }
  return summaries.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/** The title of a request in a list: the name the merchant gave, else the host. */
export function submissionTitle(summary: Pick<MerchantSubmissionSummary, 'proposedName' | 'host' | 'websiteUrl'>): string {
  return summary.proposedName ?? summary.host ?? summary.websiteUrl;
}
