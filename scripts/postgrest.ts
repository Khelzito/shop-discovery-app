/**
 * Reading a PostgREST response without assuming it has a body.
 *
 * Extracted and tested because of a real failure. The backfill wrote its ten
 * embeddings successfully and then reported `failed 10`:
 *
 *     return res.status === 204 ? null : res.json();
 *
 * `Prefer: return=minimal` makes PostgREST answer **201 Created with an empty
 * body** — not 204. So `res.json()` ran on an empty string, threw
 * "Unexpected end of JSON input", and the caller's catch block logged
 * NOT WRITTEN for rows that were already committed.
 *
 * That is the worst shape a bug can take here: the destructive-looking outcome
 * was reported for a successful write, which invites someone to "fix" it by
 * re-running and re-paying. Hence a parser that decides from status and
 * content-type rather than from whether JSON.parse happens to succeed.
 *
 * Pure and synchronous: the caller does the I/O and hands the three facts
 * over, so every branch is testable without a network or a fetch mock.
 */

export type PostgrestResult =
  | { ok: true; data: unknown }
  | { ok: false; status: number; code: string | null; message: string };

/** Longest provider text echoed back. Enough to identify, too short to dump. */
const MAX_MESSAGE_CHARS = 300;

export type PostgrestResponseParts = {
  status: number;
  /** The `content-type` header, or null when absent. */
  contentType: string | null;
  /** The body already read as text. May be empty. */
  body: string;
};

export function readPostgrestResponse(parts: PostgrestResponseParts): PostgrestResult {
  const { status, body } = parts;
  const contentType = (parts.contentType ?? '').toLowerCase();
  const trimmed = body.trim();

  if (status >= 200 && status < 300) {
    // A successful write with `return=minimal` has nothing to parse, and that
    // is not an error condition. 201, 204 and 200-with-no-body all land here.
    if (trimmed.length === 0) {
      return { ok: true, data: null };
    }
    if (!contentType.includes('json')) {
      // Success carrying something we did not ask for. Not worth guessing at.
      return { ok: true, data: null };
    }
    try {
      return { ok: true, data: JSON.parse(trimmed) as unknown };
    } catch {
      return {
        ok: false,
        status,
        code: 'invalid_json',
        message: 'The response claimed to be JSON but could not be parsed.',
      };
    }
  }

  // Failure. PostgREST sends {code, message, details, hint}; anything else
  // (a gateway HTML page, say) is reported as a bare status.
  let code: string | null = null;
  let message = `HTTP ${status}`;

  if (trimmed.length > 0 && contentType.includes('json')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed.code === 'string') {
        code = parsed.code;
      }
      const parts: string[] = [];
      for (const field of ['message', 'details', 'hint'] as const) {
        const value = parsed[field];
        if (typeof value === 'string' && value.trim().length > 0) {
          parts.push(value.trim());
        }
      }
      if (parts.length > 0) {
        message = parts.join(' — ');
      }
    } catch {
      message = `HTTP ${status} (unparseable error body)`;
    }
  }

  return { ok: false, status, code, message: sanitize(message) };
}

/**
 * Keeps an error message safe to print.
 *
 * PostgREST echoes the offending row in some constraint violations, and our
 * rows carry 1536-float embeddings. Printing one would flood the terminal and
 * copy a vector into the shell scrollback for no diagnostic value, so numeric
 * arrays are collapsed before anything is truncated.
 */
export function sanitize(message: string): string {
  const collapsed = message
    // A bracketed run of numbers is an embedding, never something to read.
    .replace(/\[\s*-?\d[\d\s.,eE+-]{40,}\]/g, '[vector]')
    .replace(/\s+/g, ' ')
    .trim();

  return collapsed.length > MAX_MESSAGE_CHARS
    ? `${collapsed.slice(0, MAX_MESSAGE_CHARS)}…`
    : collapsed;
}

/** One-line summary for a log. Never contains a key: none is ever passed in. */
export function describeFailure(label: string, result: PostgrestResult): string {
  if (result.ok) {
    return `${label}: ok`;
  }
  const code = result.code ? ` code=${result.code}` : '';
  return `${label}: HTTP ${result.status}${code} — ${result.message}`;
}
