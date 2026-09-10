/**
 * Argument parsing for the embedding backfill.
 *
 * Its own tested module because of how this failed in practice: the paid flag
 * was pasted immediately followed by an API key —
 *
 *     node scripts/backfill-shop-embeddings.mjs --confirm-paidsk-proj-...
 *
 * `argv.includes('--confirm-paid')` was false, so the script silently ran a
 * dry run and reported success. Two things went wrong at once and neither was
 * visible: the real run never happened, and a live secret went into the shell
 * history.
 *
 * So this parser is deliberately strict rather than forgiving. It refuses
 * anything it does not recognise instead of ignoring it, because for a script
 * that spends money the dangerous failure is not "crashed" — it is "quietly
 * did something other than what you asked".
 */

export const CONFIRM_FLAG = '--confirm-paid';

export type BackfillArgs = {
  /** True only for an exact `--confirm-paid`. */
  confirmed: boolean;
  force: boolean;
  /** 0 means no cap. */
  limit: number;
  batch: number;
  /**
   * Read-only report of what is stored, then exit.
   *
   * Named `--inspect-embeddings` rather than `--inspect` on purpose: the
   * shorter name is a Node runtime flag, and a reader should not have to
   * work out which one is meant.
   */
  inspect: boolean;
};

export type BackfillArgsResult =
  | { ok: true; value: BackfillArgs }
  | { ok: false; errors: string[] };

/** Upper bound mirrored from the provider adapter. */
export const MAX_BATCH = 96;
const DEFAULT_BATCH = 32;

/**
 * Shapes that are almost certainly a credential.
 *
 * Matched on a PREFIX rather than by entropy: a false positive here costs a
 * confusing error message, while a false negative costs a leaked key. The
 * asymmetry decides.
 */
const SECRET_PREFIXES = ['sk-', 'sk_', 'sb_secret_', 'sb_publishable_', 'eyJ', 'service_role'];

export function looksLikeSecret(value: string): boolean {
  const candidate = value.trim();
  if (SECRET_PREFIXES.some((prefix) => candidate.startsWith(prefix))) {
    return true;
  }
  // A long opaque blob with no flag syntax is not something this script takes.
  return candidate.length >= 40 && !candidate.startsWith('--') && !candidate.includes('=');
}

export function parseBackfillArgs(argv: readonly string[]): BackfillArgsResult {
  const errors: string[] = [];
  let confirmed = false;
  let force = false;
  let limit = 0;
  let batch = DEFAULT_BATCH;
  let inspect = false;

  for (const raw of argv) {
    const arg = raw.trim();
    if (arg.length === 0) {
      continue;
    }

    // Checked FIRST, before any flag matching: an argument carrying a secret
    // must abort loudly whatever else it looks like, because by the time this
    // runs the value is already in the shell history and must be rotated.
    if (looksLikeSecret(arg)) {
      errors.push(
        'An argument looks like a credential. This script never takes secrets on the ' +
          'command line — they belong in environment variables. Treat that value as ' +
          'compromised and rotate it: it is in your shell history.'
      );
      continue;
    }

    if (arg === CONFIRM_FLAG) {
      confirmed = true;
      continue;
    }
    if (arg === '--force') {
      force = true;
      continue;
    }
    if (arg === '--inspect-embeddings') {
      inspect = true;
      continue;
    }

    // The exact trap that caused the incident: a flag the parser would
    // otherwise ignore, leaving a paid run silently unconfirmed.
    if (arg.startsWith(CONFIRM_FLAG)) {
      errors.push(
        `An argument starts with ${CONFIRM_FLAG} but is not exactly it — something is ` +
          'stuck to the flag. Refusing rather than falling back to a dry run, which is ' +
          'how this went unnoticed before. If what is stuck to it is a key, it is now in ' +
          'your shell history: rotate it.'
      );
      continue;
    }

    const numeric = /^--(limit|batch)=(\d+)$/.exec(arg);
    if (numeric) {
      const value = Number.parseInt(numeric[2]!, 10);
      if (!Number.isFinite(value) || value <= 0) {
        errors.push(`"${arg}" needs a positive number.`);
        continue;
      }
      if (numeric[1] === 'limit') {
        limit = value;
      } else {
        batch = Math.min(value, MAX_BATCH);
      }
      continue;
    }

    errors.push(`Unknown argument "${arg}".`);
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { confirmed, force, limit, batch, inspect } };
}
