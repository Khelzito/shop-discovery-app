import { AUDIENCES } from '../../ai/contracts/common';
import { MODERATION_NOTE_MAX, MODERATION_OUTCOMES } from '../../ai/contracts/merchant-trust';
import type { ModerationAction, ModerationOutcome } from '../../ai/contracts/merchant-trust';
import { hostOfUrl } from './url';

/**
 * The moderation screens, without React and without Supabase.
 *
 * Moderator rights are decided by the database on every call; nothing here
 * grants or assumes them. The submission is merchant-written and untrusted:
 * it is parsed defensively and only ever displayed as text.
 */

export type ModerationFailure = 'not_moderator' | 'failed';

export const MODERATION_MESSAGES: Record<ModerationOutcome | ModerationFailure, string> = {
  approved: 'Boutique approuvée et publiée.',
  needs_changes: 'Modifications demandées au marchand.',
  rejected: 'Demande refusée.',
  submission_not_found: 'Cette demande est introuvable.',
  already_reviewed: 'Cette demande a déjà été traitée.',
  not_submitted: 'Cette demande n’a pas encore été envoyée.',
  own_submission: 'Vous ne pouvez pas examiner votre propre demande.',
  note_required: 'Ajoutez une note pour le marchand.',
  invalid_note: `La note ne doit pas dépasser ${MODERATION_NOTE_MAX} caractères.`,
  invalid_profile: 'La fiche est incomplète ou invalide. Demandez des modifications.',
  duplicate_shop: 'Une boutique existe déjà pour ce domaine.',
  slug_unavailable: 'Impossible de créer l’adresse de la fiche. Demandez un autre nom.',
  conflict: 'Une autre action vient d’être enregistrée. Réessayez.',
  not_moderator: 'Accès réservé à la modération.',
  failed: 'L’action a échoué. Réessayez dans un instant.',
};

export const MODERATION_ACTION_LABELS: Record<ModerationAction, string> = {
  approve: 'Approuver',
  needs_changes: 'Demander des modifications',
  reject: 'Refuser',
};

/** Client-side mirror of the server rule, so the moderator is told before sending. */
export function checkModerationNote(action: ModerationAction, note: string): string | null {
  const cleaned = note.replace(/\s+/g, ' ').trim();
  if (cleaned.length > MODERATION_NOTE_MAX) return MODERATION_MESSAGES.invalid_note;
  if (action !== 'approve' && cleaned.length === 0) return MODERATION_MESSAGES.note_required;
  return null;
}

export type ModerationResult =
  | { ok: true; outcome: 'approved' | 'needs_changes' | 'rejected'; shopId: string | null; message: string }
  | { ok: false; outcome: Exclude<ModerationOutcome, 'approved' | 'needs_changes' | 'rejected'> | ModerationFailure; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The answer to rpc('moderate_submission'). A raw database message is never shown. */
export function moderationResultOf(response: { data: unknown; error: { code?: string | null } | null }): ModerationResult {
  if (response.error) {
    const outcome: ModerationFailure = response.error.code === '42501' ? 'not_moderator' : 'failed';
    return { ok: false, outcome, message: MODERATION_MESSAGES[outcome] };
  }
  const row = asRecord(Array.isArray(response.data) ? response.data[0] : response.data);
  const outcome = row?.outcome;
  if (!(MODERATION_OUTCOMES as readonly unknown[]).includes(outcome)) {
    return { ok: false, outcome: 'failed', message: MODERATION_MESSAGES.failed };
  }
  const known = outcome as ModerationOutcome;
  if (known === 'approved' || known === 'needs_changes' || known === 'rejected') {
    const shopId = typeof row?.created_shop_id === 'string' && UUID.test(row.created_shop_id) ? row.created_shop_id : null;
    return { ok: true, outcome: known, shopId, message: MODERATION_MESSAGES[known] };
  }
  return { ok: false, outcome: known, message: MODERATION_MESSAGES[known] };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export type ModerationListItem = {
  id: string;
  status: 'submitted' | 'processing' | 'needs_changes';
  host: string | null;
  proposedName: string | null;
  createdAt: string;
  updatedAt: string;
};

export function toModerationList(rows: readonly unknown[]): {
  toReview: ModerationListItem[];
  awaitingMerchant: ModerationListItem[];
} {
  const items: ModerationListItem[] = [];
  for (const raw of rows) {
    const row = asRecord(raw);
    if (!row || typeof row.submission_id !== 'string' || !UUID.test(row.submission_id)) continue;
    if (row.status !== 'submitted' && row.status !== 'processing' && row.status !== 'needs_changes') continue;
    if (typeof row.created_at !== 'string' || typeof row.updated_at !== 'string') continue;
    items.push({
      id: row.submission_id,
      status: row.status,
      host: typeof row.website_url === 'string' ? hostOfUrl(row.website_url) : null,
      proposedName: text(row.proposed_name, 120),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  return {
    // Oldest first: a queue is served in order.
    toReview: items.filter((item) => item.status !== 'needs_changes').sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt)),
    awaitingMerchant: items.filter((item) => item.status === 'needs_changes'),
  };
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export type ModerationProfile = {
  name: string | null;
  shortDescription: string | null;
  primaryCategory: string | null;
  secondaryCategories: string[];
  tags: string[];
  audience: string[];
  pricePositioning: string | null;
  styles: string[];
  values: string[];
  productTypes: string[];
  logoUrl: string | null;
  imageUrls: string[];
};

export type ModerationDetail = {
  id: string;
  status: string;
  websiteUrl: string;
  host: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  reviewNote: string | null;
  submitterRef: string | null;
  ownSubmission: boolean;
  hostAlreadyListed: boolean;
  profile: ModerationProfile | null;
  observed: { name: string | null; description: string | null; logoUrl: string | null; imageUrls: string[] } | null;
  suggested: { shortDescription: string | null; primaryCategory: string | null; tags: string[]; summary: string | null } | null;
  analysisSameHost: boolean | null;
  warnings: string[];
};

export function toModerationDetail(value: unknown): ModerationDetail | null {
  const root = asRecord(value);
  if (!root || typeof root.id !== 'string' || !UUID.test(root.id) || typeof root.websiteUrl !== 'string' || typeof root.status !== 'string') {
    return null;
  }
  const profile = asRecord(root.merchantProfile);
  const analysis = asRecord(root.analysis);
  const observed = asRecord(analysis?.observed);
  const inferred = asRecord(analysis?.inferred);

  return {
    id: root.id,
    status: root.status,
    websiteUrl: root.websiteUrl,
    host: hostOfUrl(root.websiteUrl),
    createdAt: text(root.createdAt, 40),
    updatedAt: text(root.updatedAt, 40),
    reviewNote: text(root.reviewNote, 500),
    submitterRef: text(root.submitterRef, 8),
    ownSubmission: root.ownSubmission === true,
    hostAlreadyListed: root.hostAlreadyListed === true,
    profile: profile
      ? {
          name: text(profile.name, 120),
          shortDescription: text(profile.shortDescription, 280),
          primaryCategory: text(profile.primaryCategory, 64),
          secondaryCategories: strings(profile.secondaryCategories, 3, 64),
          tags: strings(profile.tags, 5, 64),
          audience: strings(profile.audience, 5, 16).filter((item) => (AUDIENCES as readonly string[]).includes(item)),
          pricePositioning: text(profile.pricePositioning, 16),
          styles: strings(profile.styles, 8, 40),
          values: strings(profile.values, 8, 40),
          productTypes: strings(profile.productTypes, 8, 40),
          logoUrl: httpsUrl(profile.logoUrl),
          imageUrls: strings(profile.imageUrls, 6, 2048).filter((url) => httpsUrl(url) !== null),
        }
      : null,
    observed: observed
      ? {
          name: text(asRecord(observed.name)?.value, 120),
          description: text(asRecord(observed.description)?.value, 500),
          logoUrl: httpsUrl(asRecord(observed.logoUrl)?.value),
          imageUrls: (Array.isArray(observed.imageUrls) ? observed.imageUrls : [])
            .map((entry) => httpsUrl(asRecord(entry)?.value))
            .filter((url): url is string => url !== null)
            .slice(0, 6),
        }
      : null,
    suggested: inferred
      ? {
          shortDescription: text(asRecord(inferred.shortDescription)?.value, 280),
          primaryCategory: text(asRecord(inferred.primaryCategory)?.value, 64),
          tags: (Array.isArray(inferred.tags) ? inferred.tags : [])
            .map((entry) => text(asRecord(entry)?.value, 64))
            .filter((tag): tag is string => tag !== null)
            .slice(0, 5),
          summary: text(asRecord(inferred.summary)?.value, 1000),
        }
      : null,
    analysisSameHost: analysis ? analysis.sameHost === true : null,
    warnings: strings(analysis?.warnings, 12, 40),
  };
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned.slice(0, max) : null;
}

function strings(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => text(item, maxLength))
    .filter((item): item is string => item !== null)
    .slice(0, maxItems);
}

function httpsUrl(value: unknown): string | null {
  return typeof value === 'string' && /^https:\/\/\S+$/i.test(value) && value.length <= 2048 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
