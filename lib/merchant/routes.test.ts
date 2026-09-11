import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addModeParam,
  manualReasonParam,
  MERCHANT_WELCOME_PATH,
  merchantEntry,
  merchantRedirectTarget,
  uuidParam,
} from './routes';

describe('merchantEntry — the auth guard of "Référencer ma boutique"', () => {
  it('waits while the session is restored', () => {
    assert.deepEqual(merchantEntry('loading'), { kind: 'wait' });
  });

  it('sends a signed-in user to the welcome screen', () => {
    assert.deepEqual(merchantEntry('signedIn'), { kind: 'go', pathname: MERCHANT_WELCOME_PATH });
  });

  it('sends a signed-out user to sign in, then back to the welcome screen', () => {
    assert.deepEqual(merchantEntry('signedOut'), {
      kind: 'sign_in',
      pathname: '/sign-in',
      params: { redirect: MERCHANT_WELCOME_PATH },
    });
  });
});

describe('merchantRedirectTarget — no open redirect after sign-in', () => {
  it('accepts only the merchant welcome screen', () => {
    assert.equal(merchantRedirectTarget('/merchant/welcome'), '/merchant/welcome');
    assert.equal(merchantRedirectTarget(['/merchant/welcome']), '/merchant/welcome');
  });

  it('ignores everything else', () => {
    for (const value of [undefined, null, '', '/account', '/merchant/review', 'https://evil.example', '//evil.example', 42]) {
      assert.equal(merchantRedirectTarget(value), null, String(value));
    }
  });
});

describe('route params', () => {
  it('reads a uuid parameter or nothing', () => {
    assert.equal(uuidParam('88742c16-8ddd-4177-ada3-6677e3121fd4'), '88742c16-8ddd-4177-ada3-6677e3121fd4');
    assert.equal(uuidParam(['88742c16-8ddd-4177-ada3-6677e3121fd4']), '88742c16-8ddd-4177-ada3-6677e3121fd4');
    assert.equal(uuidParam('1 or 1=1'), null);
    assert.equal(uuidParam(undefined), null);
  });

  it('defaults the add mode to analysis, and opens the claim search on request', () => {
    assert.equal(addModeParam(undefined), 'analyze');
    assert.equal(addModeParam('claim'), 'claim');
    assert.equal(addModeParam('publish'), 'analyze');
  });

  it('accepts only known manual-entry reasons', () => {
    assert.equal(manualReasonParam('robots_disallowed'), 'robots_disallowed');
    assert.equal(manualReasonParam('not_saved'), 'not_saved');
    assert.equal(manualReasonParam('<script>'), null);
  });
});
