import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { REPORT_MESSAGES, REPORT_REASON_LABELS, reportOutcomeOf, validateReport } from './report';

const SHOP = '78d97b85-0000-4000-8000-000000000009';

describe('shop report', () => {
  it('offers exactly the four agreed reasons', () => {
    assert.deepEqual(Object.values(REPORT_REASON_LABELS), ['Contenu trompeur', 'Boutique inaccessible', 'Usurpation', 'Autre']);
  });

  it('writes only the columns the client is granted', () => {
    const result = validateReport(SHOP, 'impersonation', '  Faux site  ');
    assert.deepEqual(result, { ok: true, insert: { shop_id: SHOP, reason: 'impersonation', description: 'Faux site' } });
    assert.deepEqual(Object.keys(result.ok ? result.insert : {}).sort(), ['description', 'reason', 'shop_id']);
  });

  it('asks for a reason, details for "Autre", and bounds the text', () => {
    assert.deepEqual(validateReport(SHOP, null, ''), { ok: false, error: REPORT_MESSAGES.reasonRequired });
    assert.deepEqual(validateReport(SHOP, 'other', ' '), { ok: false, error: REPORT_MESSAGES.detailsRequired });
    assert.deepEqual(validateReport(SHOP, 'misleading_information', 'x'.repeat(2001)), { ok: false, error: REPORT_MESSAGES.tooLong });
    assert.equal(validateReport(SHOP, 'website_unavailable', '').ok, true);
  });

  it('maps the database answer', () => {
    assert.equal(reportOutcomeOf(null), 'sent');
    assert.equal(reportOutcomeOf({ code: '23505' }), 'already_reported');
    assert.equal(reportOutcomeOf({ code: 'PGRST301' }), 'session_expired');
    assert.equal(reportOutcomeOf({ code: '42501' }), 'failed');
  });
});
