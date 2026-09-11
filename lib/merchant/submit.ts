import { buildSubmissionUpdate, validateMerchantProfile } from './profile';
import type {
  MerchantProfileDraft,
  MerchantSubmissionUpdate,
  MerchantTaxonomy,
  ProfileErrors,
} from './profile';

/**
 * Sending a merchant request, without React and without Supabase.
 *
 * The screen passes the draft and a `send` function; everything that decides
 * whether a request goes out, what it contains and what the merchant is told
 * lives here, so it is tested under Node.
 */

export const MERCHANT_SUBMITTED_PATH = '/merchant/submitted' as const;

export type SubmitOutcome =
  | { ok: true }
  | { ok: false; reason: 'locked' | 'session_expired' | 'forbidden' | 'failed' };

export const SUBMIT_MESSAGES = {
  invalid: 'Vérifiez les champs indiqués.',
  locked: 'Cette demande a déjà été envoyée.',
  session_expired: 'Votre session a expiré. Reconnectez-vous pour continuer.',
  forbidden: 'Cette demande ne peut pas être envoyée depuis ce compte.',
  failed: 'L’envoi a échoué. Réessayez dans un instant.',
} as const;

/**
 * The answer to `UPDATE … WHERE id = ? AND status IN ('draft', 'needs_changes')
 * RETURNING id`.
 *
 * No row means the request was already sent or is not the caller's: the RLS
 * update policy filters it out, and nothing was written.
 */
export function submitOutcomeOf(response: {
  data: unknown;
  error: { code?: string | null } | null;
}): SubmitOutcome {
  if (response.error) {
    const code = response.error.code ?? '';
    if (code === 'PGRST301' || code === 'PGRST302' || code === 'PGRST303') {
      return { ok: false, reason: 'session_expired' };
    }
    // Permission or row-level security refusal: a real refusal, not an
    // expired session, and never shown as a raw database message.
    if (code === '42501') {
      return { ok: false, reason: 'forbidden' };
    }
    return { ok: false, reason: 'failed' };
  }
  return response.data ? { ok: true } : { ok: false, reason: 'locked' };
}

export type ReviewSubmitResult =
  | { kind: 'sent' }
  | { kind: 'invalid'; errors: ProfileErrors; message: string }
  | { kind: 'rejected'; message: string };

/**
 * Drops images that failed to load from the draft before it is sent.
 *
 * A tile the merchant could not see — and therefore could not remove — must
 * not be submitted silently. The URL is removed from the suggestion too, so a
 * remaining image keeps its "detected on your site" origin.
 */
export function withoutImages(draft: MerchantProfileDraft, urls: readonly string[]): MerchantProfileDraft {
  if (urls.length === 0) {
    return draft;
  }
  const keep = (list: readonly string[]) => list.filter((url) => !urls.includes(url));
  const initialOrigins = { ...draft.initialOrigins };
  const availableImageUrls = keep(draft.availableImageUrls);
  if (availableImageUrls.length === 0) {
    delete initialOrigins.imageUrls;
  }
  return {
    ...draft,
    values: { ...draft.values, imageUrls: keep(draft.values.imageUrls) },
    initial: { ...draft.initial, imageUrls: keep(draft.initial.imageUrls) },
    initialOrigins,
    availableImageUrls,
  };
}

/**
 * Validates, builds the payload and sends it — to the submission the analysis
 * created, never to a new one. A thrown `send` is a failure, never a success.
 */
export async function submitReview(input: {
  submissionId: string;
  submittedData: unknown;
  draft: MerchantProfileDraft;
  taxonomy: MerchantTaxonomy;
  unavailableImageUrls?: readonly string[];
  now?: Date;
  send: (submissionId: string, update: MerchantSubmissionUpdate) => Promise<SubmitOutcome>;
}): Promise<ReviewSubmitResult> {
  const draft = withoutImages(input.draft, input.unavailableImageUrls ?? []);
  const validated = validateMerchantProfile(draft, input.taxonomy, input.now);
  if (!validated.ok) {
    return { kind: 'invalid', errors: validated.errors, message: SUBMIT_MESSAGES.invalid };
  }

  const payload = buildSubmissionUpdate(input.submittedData, validated.profile);
  if (!payload.ok) {
    return { kind: 'rejected', message: payload.error };
  }

  let outcome: SubmitOutcome;
  try {
    outcome = await input.send(input.submissionId, payload.update);
  } catch {
    outcome = { ok: false, reason: 'failed' };
  }

  return outcome.ok ? { kind: 'sent' } : { kind: 'rejected', message: SUBMIT_MESSAGES[outcome.reason] };
}

export type SingleFlight<T> = (task: () => Promise<T>) => Promise<T> | null;

/**
 * One run at a time. A call made while another is in flight is refused (null)
 * instead of starting a second request: a double tap sends one request and
 * navigates once.
 */
export function singleFlight<T>(): SingleFlight<T> {
  let running = false;
  return (task) => {
    if (running) {
      return null;
    }
    running = true;
    return Promise.resolve()
      .then(task)
      .finally(() => {
        running = false;
      });
  };
}
