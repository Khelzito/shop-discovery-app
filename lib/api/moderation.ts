import type { ModerationAction } from '@/ai/contracts/merchant-trust';
import {
  moderationResultOf,
  toModerationDetail,
  toModerationList,
  type ModerationDetail,
  type ModerationListItem,
  type ModerationResult,
} from '@/lib/merchant/moderation';
import { supabase } from '@/lib/supabase';

/**
 * Moderation, through SECURITY DEFINER functions that check the caller's
 * moderator role in the database on every call.
 *
 * Nothing here decides who is a moderator. is_app_moderator only tells the
 * app whether to show the section; hiding it is convenience, the functions are
 * the boundary.
 */

export class ModerationApiError extends Error {
  readonly code: string | null;
  constructor(operation: string, code: string | null) {
    super(`Moderation request failed: ${operation}`);
    this.name = 'ModerationApiError';
    this.code = code;
  }
}

function client() {
  if (!supabase) {
    throw new ModerationApiError('client', 'not_configured');
  }
  return supabase;
}

function logFailure(operation: string, code: string | null | undefined): void {
  if (__DEV__) {
    console.warn(`[moderation] ${operation} failed`, { code: code ?? null });
  }
}

/** Whether the signed-in user is a moderator. Any failure is "no". */
export async function isAppModerator(): Promise<boolean> {
  if (!supabase) {
    return false;
  }
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session) {
    return false;
  }
  const { data, error } = await supabase.rpc('is_app_moderator');
  if (error) {
    logFailure('isAppModerator', error.code);
    return false;
  }
  return data === true;
}

export async function listSubmissionsForModeration(): Promise<{
  toReview: ModerationListItem[];
  awaitingMerchant: ModerationListItem[];
}> {
  const { data, error } = await client().rpc('moderation_list_submissions');
  if (error) {
    logFailure('listSubmissionsForModeration', error.code);
    throw new ModerationApiError('listSubmissionsForModeration', error.code ?? null);
  }
  return toModerationList(Array.isArray(data) ? (data as unknown[]) : []);
}

export async function getSubmissionForModeration(id: string): Promise<ModerationDetail | null> {
  const { data, error } = await client().rpc('moderation_get_submission', { p_submission_id: id });
  if (error) {
    logFailure('getSubmissionForModeration', error.code);
    throw new ModerationApiError('getSubmissionForModeration', error.code ?? null);
  }
  return toModerationDetail(data);
}

export async function moderateSubmission(id: string, action: ModerationAction, note: string): Promise<ModerationResult> {
  const cleaned = note.replace(/\s+/g, ' ').trim();
  const { data, error } = await client().rpc('moderate_submission', {
    p_submission_id: id,
    p_action: action,
    p_note: cleaned.length > 0 ? cleaned : null,
  });
  if (error) {
    logFailure('moderateSubmission', error.code);
  }
  return moderationResultOf({ data, error });
}
