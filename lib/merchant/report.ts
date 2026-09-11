import { SHOP_REPORT_DESCRIPTION_MAX, SHOP_REPORT_REASONS } from '../../ai/contracts/merchant-trust';
import type { ShopReportReason } from '../../ai/contracts/merchant-trust';

/**
 * "Signaler cette boutique" — a private message to moderation.
 *
 * A report is never public, never counted into a score and never suspends a
 * shop by itself. The database fills in the reporter from the session and
 * refuses a second open report on the same shop.
 */

export const REPORT_REASON_LABELS: Record<ShopReportReason, string> = {
  misleading_information: 'Contenu trompeur',
  website_unavailable: 'Boutique inaccessible',
  impersonation: 'Usurpation',
  other: 'Autre',
};

export const REPORT_MESSAGES = {
  reasonRequired: 'Choisissez un motif.',
  detailsRequired: 'Précisez le problème en quelques mots.',
  tooLong: `${SHOP_REPORT_DESCRIPTION_MAX} caractères maximum.`,
  sent: 'Merci. Votre signalement a été transmis à notre équipe.',
  already_reported: 'Vous avez déjà signalé cette boutique. Notre équipe l’examine.',
  session_expired: 'Votre session a expiré. Reconnectez-vous pour continuer.',
  failed: 'L’envoi a échoué. Réessayez dans un instant.',
} as const;

export type ReportInsert = { shop_id: string; reason: ShopReportReason; description: string | null };

export function validateReport(
  shopId: string,
  reason: ShopReportReason | null,
  details: string
): { ok: true; insert: ReportInsert } | { ok: false; error: string } {
  if (reason === null || !(SHOP_REPORT_REASONS as readonly string[]).includes(reason)) {
    return { ok: false, error: REPORT_MESSAGES.reasonRequired };
  }
  const description = details.replace(/\s+/g, ' ').trim();
  if (description.length > SHOP_REPORT_DESCRIPTION_MAX) {
    return { ok: false, error: REPORT_MESSAGES.tooLong };
  }
  if (reason === 'other' && description.length === 0) {
    return { ok: false, error: REPORT_MESSAGES.detailsRequired };
  }
  // Exactly the three columns the client may write. No user id, no status.
  return { ok: true, insert: { shop_id: shopId, reason, description: description.length > 0 ? description : null } };
}

export type ReportOutcome = 'sent' | 'already_reported' | 'session_expired' | 'failed';

export function reportOutcomeOf(error: { code?: string | null } | null): ReportOutcome {
  if (!error) return 'sent';
  const code = error.code ?? '';
  if (code === '23505') return 'already_reported';
  if (code === 'PGRST301' || code === 'PGRST302' || code === 'PGRST303') return 'session_expired';
  return 'failed';
}
