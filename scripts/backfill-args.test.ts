import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONFIRM_FLAG, MAX_BATCH, looksLikeSecret, parseBackfillArgs } from './backfill-args.ts';

/**
 * These exist because of a real incident, not a hypothetical one: the paid
 * flag was pasted with an API key stuck to it, the parser ignored the unknown
 * argument, and the script reported a successful dry run while the operator
 * believed a real backfill had happened.
 */

function ok(argv: string[]) {
  const result = parseBackfillArgs(argv);
  assert.ok(result.ok, `expected success, got ${JSON.stringify(result)}`);
  return result.value;
}

function errors(argv: string[]): string[] {
  const result = parseBackfillArgs(argv);
  assert.equal(result.ok, false, 'expected the parse to fail');
  return result.ok ? [] : result.errors;
}

describe('defaults', () => {
  it('is a dry run when nothing is passed', () => {
    assert.deepEqual(ok([]), {
      confirmed: false,
      force: false,
      limit: 0,
      batch: 32,
      inspect: false,
    });
  });

  it('reads the read-only inspection flag', () => {
    assert.equal(ok(['--inspect-embeddings']).inspect, true);
    // Node's own --inspect must not be mistaken for it.
    assert.equal(parseBackfillArgs(['--inspect']).ok, false);
  });

  it('confirms only on an exact flag', () => {
    assert.equal(ok([CONFIRM_FLAG]).confirmed, true);
  });

  it('reads the numeric flags', () => {
    const args = ok(['--limit=5', '--batch=8', '--force']);
    assert.equal(args.limit, 5);
    assert.equal(args.batch, 8);
    assert.equal(args.force, true);
  });

  it('caps the batch at the provider limit', () => {
    assert.equal(ok([`--batch=${MAX_BATCH + 50}`]).batch, MAX_BATCH);
  });
});

describe('the incident', () => {
  it('refuses a key glued to the confirm flag instead of dry-running', () => {
    // The exact shape that went wrong. Previously: silently a dry run.
    const found = errors(['--confirm-paidsk-proj-EXAMPLE-not-a-real-key']);
    assert.equal(found.length >= 1, true);
    assert.ok(
      found.some((message) => message.includes('credential') || message.includes(CONFIRM_FLAG)),
      `unhelpful errors: ${JSON.stringify(found)}`
    );
  });

  it('refuses any flag merely starting with the confirm flag', () => {
    const found = errors(['--confirm-paidx']);
    assert.ok(found[0]?.includes(CONFIRM_FLAG));
  });

  it('never treats a malformed confirm flag as confirmation', () => {
    for (const argv of [['--confirm-paidsk-abc'], ['--confirm-paidx'], ['--confirm_paid']]) {
      const result = parseBackfillArgs(argv);
      assert.equal(result.ok, false, `${argv[0]} must not parse`);
    }
  });
});

describe('secrets on the command line', () => {
  it('rejects each credential shape', () => {
    const samples = [
      'sk-proj-EXAMPLE',
      'sk_live_EXAMPLE',
      'sb_secret_EXAMPLE',
      'sb_publishable_EXAMPLE',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      'x'.repeat(64),
    ];
    for (const sample of samples) {
      assert.equal(looksLikeSecret(sample), true, `${sample.slice(0, 12)}… should look like a secret`);
      assert.equal(parseBackfillArgs([sample]).ok, false);
    }
  });

  it('tells the operator the value must be rotated', () => {
    const found = errors(['sk-proj-EXAMPLE-not-a-real-key']);
    assert.ok(found[0]?.includes('rotate'), found[0]);
  });

  it('does not mistake ordinary flags for secrets', () => {
    for (const flag of ['--force', '--limit=10', '--batch=8', CONFIRM_FLAG]) {
      assert.equal(looksLikeSecret(flag), false, flag);
    }
  });

  it('never echoes the offending value back', () => {
    // Printing it would copy the secret into a second place.
    const secret = 'sk-proj-SUPERSECRETVALUE';
    for (const message of errors([secret])) {
      assert.equal(message.includes(secret), false, 'the error echoed the secret');
    }
  });
});

describe('unknown arguments', () => {
  it('refuses a typo rather than ignoring it', () => {
    assert.ok(errors(['--dryrun'])[0]?.includes('Unknown argument'));
  });

  it('refuses a non-numeric value', () => {
    assert.equal(parseBackfillArgs(['--limit=0']).ok, false);
  });

  it('reports every problem at once', () => {
    assert.equal(errors(['--nope', '--alsonope']).length, 2);
  });
});
