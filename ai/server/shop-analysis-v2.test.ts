import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { emptyShopAnalysisV2 } from '../contracts/shop-analysis-v2.ts';
import { assertsOrigin, validateShopAnalysisRequestV2, validateShopAnalysisV2 } from './shop-analysis-v2.ts';
import { validateShopAnalysis } from './validation.ts';

/**
 * shop-analysis/2 is the contract a hostile page and a drifting model will
 * both push against. The failures that matter here are silent acceptances, so
 * most tests assert that something is REFUSED — and that the refusal names the
 * right problem.
 */

const TARGET = {
  requestedUrl: 'https://maison-leon.fr/',
  finalUrl: 'https://maison-leon.fr/',
  domain: 'maison-leon.fr',
  redirectCount: 0,
};

const MODEL = {
  provider: 'openai',
  model: 'model-under-test',
  modelVersion: null,
  contractVersion: 'shop-analysis/2',
};

type Json = Record<string, unknown>;

function validAnalysis(): Json {
  return {
    contractVersion: 'shop-analysis/2',
    target: { ...TARGET },
    observed: {
      name: { value: 'Maison Léon', source: { kind: 'html_meta', key: 'og:site_name' } },
      description: {
        value: 'Vestiaire urbain coupé et assemblé à Roubaix.',
        source: { kind: 'html_meta', key: 'description' },
      },
      language: { value: 'fr', source: { kind: 'page_text' } },
      countryCode: {
        value: 'FR',
        source: { kind: 'json_ld', type: 'Organization', path: 'address.addressCountry' },
      },
      currency: { value: 'EUR', source: { kind: 'json_ld', type: 'Offer', path: 'priceCurrency' } },
      logoUrl: { value: 'https://cdn.maison-leon.fr/logo.png', source: { kind: 'html_link', rel: 'icon' } },
      imageUrls: [{ value: 'https://cdn.maison-leon.fr/cover.jpg', source: { kind: 'html_meta', key: 'og:image' } }],
      socialLinks: [
        {
          value: { network: 'instagram', url: 'https://instagram.com/maisonleon' },
          source: { kind: 'page_text' },
        },
      ],
      siteSectionLabels: [{ value: 'Nouveautés', source: { kind: 'page_text' } }],
    },
    inferred: {
      shortDescription: { value: 'Streetwear coupé en séries courtes.', confidence: 0.8 },
      primaryCategory: { value: 'mode', confidence: 0.9 },
      secondaryCategories: [{ value: 'accessoires', confidence: 0.4 }],
      audience: { value: ['unisex'], confidence: 0.7 },
      pricePositioning: { value: 'mid', confidence: 0.6 },
      styles: [{ value: 'streetwear', confidence: 0.85 }],
      values: [{ value: 'séries limitées', confidence: 0.5 }],
      productTypes: [{ value: 'sweats', confidence: 0.7 }],
      tags: [{ value: 'streetwear', confidence: 0.8 }],
      summary: { value: 'Une marque de vêtements urbains produits en petites séries.', confidence: 0.75 },
    },
    warnings: [],
    unsupported: ['verification', 'trust_score', 'legal_entity', 'shipping_countries', 'return_policy', 'certifications'],
    model: { ...MODEL },
    degraded: false,
  };
}

/** Deep clone, mutate, validate. */
function withChange(change: (analysis: any) => void, options = {}) {
  const analysis = structuredClone(validAnalysis());
  change(analysis);
  return validateShopAnalysisV2(analysis, options);
}

function issuesOf(result: ReturnType<typeof validateShopAnalysisV2>): string[] {
  assert.equal(result.ok, false, 'expected the analysis to be refused');
  return result.ok ? [] : result.issues;
}

function assertIssue(result: ReturnType<typeof validateShopAnalysisV2>, fragment: string) {
  const issues = issuesOf(result);
  assert.ok(
    issues.some((issue) => issue.includes(fragment)),
    `expected an issue containing "${fragment}", got ${JSON.stringify(issues)}`
  );
}

describe('a valid analysis', () => {
  it('passes and round-trips', () => {
    const result = validateShopAnalysisV2(validAnalysis());
    assert.ok(result.ok, JSON.stringify(!result.ok && result.issues));
    assert.equal(result.value.observed.name?.value, 'Maison Léon');
    assert.equal(result.value.inferred.primaryCategory?.confidence, 0.9);
  });

  it('accepts the empty builder, which is degraded and model-less', () => {
    const result = validateShopAnalysisV2(emptyShopAnalysisV2(TARGET));
    assert.ok(result.ok, JSON.stringify(!result.ok && result.issues));
    assert.equal(result.value.degraded, true);
  });

  it('canonicalises observed URLs through the url policy', () => {
    const result = withChange((a) => {
      a.observed.logoUrl.value = 'https://CDN.Maison-Leon.fr/logo.png#top';
    });
    assert.ok(result.ok);
    assert.equal(result.value.observed.logoUrl?.value, 'https://cdn.maison-leon.fr/logo.png');
  });
});

describe('forbidden fields cannot be represented', () => {
  const cases: [string, (a: any) => void][] = [
    ['top level verified', (a) => { a.verified = true; }],
    ['top level trust_score', (a) => { a.trust_score = 0.99; }],
    ['target status', (a) => { a.target.status = 'published'; }],
    ['observed verification', (a) => { a.observed.verification = { value: 'domain', source: { kind: 'page_text' } }; }],
    ['inferred trustworthy', (a) => { a.inferred.trustworthy = { value: true, confidence: 1 }; }],
    ['inferred reliable', (a) => { a.inferred.reliable = { value: true, confidence: 1 }; }],
    ['inferred legal_entity_verified', (a) => { a.inferred.legal_entity_verified = { value: true, confidence: 1 }; }],
    ['inferred certifications', (a) => { a.inferred.certifications = [{ value: 'bio', confidence: 1 }]; }],
    ['observed entry verified', (a) => { a.observed.name.verified = true; }],
    ['inferred entry badge', (a) => { a.inferred.summary.badge = 'official'; }],
    ['provenance approved', (a) => { a.observed.name.source.approved = true; }],
    ['model trustScore', (a) => { a.model.trustScore = 1; }],
  ];

  for (const [label, change] of cases) {
    it(`refuses ${label} and calls it forbidden`, () => {
      assertIssue(withChange(change), 'forbidden field');
    });
  }
});

describe('unknown keys are refused at every level', () => {
  const cases: [string, (a: any) => void][] = [
    ['top level', (a) => { a.extra = 1; }],
    ['target', (a) => { a.target.extra = 1; }],
    ['observed', (a) => { a.observed.extra = null; }],
    ['inferred', (a) => { a.inferred.extra = null; }],
    ['observed entry', (a) => { a.observed.name.extra = 1; }],
    ['inferred entry', (a) => { a.inferred.summary.extra = 1; }],
    ['provenance', (a) => { a.observed.name.source.extra = 1; }],
    ['social link', (a) => { a.observed.socialLinks[0].value.extra = 1; }],
    ['list entry', (a) => { a.inferred.styles[0].extra = 1; }],
    ['model', (a) => { a.model.extra = 1; }],
  ];
  for (const [label, change] of cases) {
    it(`in ${label}`, () => {
      assertIssue(withChange(change), 'unknown field');
    });
  }
});

describe('observed versus inferred', () => {
  it('requires provenance on an observed value', () => {
    assertIssue(withChange((a) => { delete a.observed.name.source; }), 'provenance is required');
  });

  it('refuses a confidence on an observed value', () => {
    assertIssue(
      withChange((a) => { a.observed.name.confidence = 0.9; }),
      'observed values carry provenance, not confidence'
    );
  });

  it('requires a confidence on an inferred value', () => {
    assertIssue(withChange((a) => { delete a.inferred.summary.confidence; }), 'required for an inferred value');
  });

  it('refuses a provenance on an inferred value', () => {
    assertIssue(
      withChange((a) => { a.inferred.summary.source = { kind: 'page_text' }; }),
      'inferred values carry confidence, not provenance'
    );
  });

  it('refuses a confidence outside [0, 1]', () => {
    assertIssue(withChange((a) => { a.inferred.summary.confidence = 1.5; }), 'expected number in [0, 1]');
    assertIssue(withChange((a) => { a.inferred.summary.confidence = Number.NaN; }), 'expected number in [0, 1]');
  });

  it('refuses an unknown provenance kind', () => {
    assertIssue(withChange((a) => { a.observed.name.source = { kind: 'model' }; }), '.kind: expected one of');
  });

  it('requires every field to be present, even when empty', () => {
    assertIssue(withChange((a) => { delete a.observed.logoUrl; }), 'required');
    assertIssue(withChange((a) => { delete a.inferred.tags; }), 'required');
  });
});

describe('inferred text cannot assert trust', () => {
  const claims: [string, (a: any) => void][] = [
    ['summary', (a) => { a.inferred.summary.value = 'Boutique vérifiée et fiable.'; }],
    ['short description', (a) => { a.inferred.shortDescription.value = 'A trusted and legit shop.'; }],
    ['style', (a) => { a.inferred.styles[0].value = 'certifié bio'; }],
    ['value', (a) => { a.inferred.values[0].value = 'sans arnaque'; }],
    ['tag slug', (a) => { a.inferred.tags[0].value = 'verified-shop'; }],
  ];
  for (const [label, change] of claims) {
    it(`refuses a trust claim in ${label}`, () => {
      assertIssue(withChange(change), 'forbidden trust or verification claim');
    });
  }

  it('still accepts the same words QUOTED from the site as an observed value', () => {
    const result = withChange((a) => {
      a.observed.description.value = 'Nos produits sont certifiés bio.';
    });
    assert.ok(result.ok, JSON.stringify(!result.ok && result.issues));
  });
});

/**
 * Decision of Prompt 16 Phase A.1: an origin or place of manufacture may be
 * OBSERVED on the site or DECLARED by the merchant, never asserted by the
 * model. The line is the head word — "marque japonaise" states an origin,
 * "style japonais" describes an aesthetic that Search V2 relies on.
 */
describe('inferred text cannot assert an origin', () => {
  const claims: [string, (a: any) => void][] = [
    ['summary "Made in France"', (a) => { a.inferred.summary.value = 'Vêtements Made in France.'; }],
    ['short description "fabriqués en France"', (a) => { a.inferred.shortDescription.value = 'Des sacs fabriqués en France.'; }],
    ['value "French made"', (a) => { a.inferred.values[0].value = 'French made'; }],
    ['summary "made in Italy"', (a) => { a.inferred.summary.value = 'Chaussures made in Italy.'; }],
    ['style "italian-made"', (a) => { a.inferred.styles[0].value = 'italian-made'; }],
    ['product type "tricotés au Portugal"', (a) => { a.inferred.productTypes[0].value = 'pulls tricotés au Portugal'; }],
    ['summary with a city "assemblées à Roubaix"', (a) => { a.inferred.summary.value = 'Pièces assemblées à Roubaix.'; }],
    ['value "d\'origine française"', (a) => { a.inferred.values[0].value = "d'origine française"; }],
    ['value "fabrication française"', (a) => { a.inferred.values[0].value = 'fabrication française'; }],
    ['value "production locale"', (a) => { a.inferred.values[0].value = 'production locale'; }],
    ['summary "Locally made"', (a) => { a.inferred.summary.value = 'Locally made candles.'; }],
    ['short description "100 % française"', (a) => { a.inferred.shortDescription.value = 'Une marque 100 % française.'; }],
    ['summary "marque japonaise"', (a) => { a.inferred.summary.value = 'Une marque japonaise de céramique.'; }],
    ['summary "Designed in the USA"', (a) => { a.inferred.summary.value = 'Designed in the USA.'; }],
    ['summary "provenance d\'Italie"', (a) => { a.inferred.summary.value = "Cuirs de provenance d'Italie."; }],
    ['tag slug "made-in-france"', (a) => { a.inferred.tags[0].value = 'made-in-france'; }],
  ];

  for (const [label, change] of claims) {
    it(`refuses ${label}`, () => {
      assertIssue(withChange(change), 'forbidden origin or manufacturing claim');
    });
  }

  it('keeps aesthetic nationality, which Search V2 depends on', () => {
    for (const style of ['style japonais', 'élégance française', 'chic parisien', 'coupe italienne', 'inspiration scandinave']) {
      const result = withChange((a) => { a.inferred.styles[0].value = style; });
      assert.ok(result.ok, `${style}: ${JSON.stringify(!result.ok && result.issues)}`);
    }
  });

  it('does not mistake a material or a method for an origin', () => {
    for (const text of ['Vêtements produits en petites séries.', 'pulls tissés en coton', 'made in small batches', 'chaussures en suède']) {
      assert.equal(assertsOrigin(text), false, text);
    }
  });

  it('lets the SITE say it: an observed origin is kept verbatim', () => {
    const result = withChange((a) => {
      a.observed.description.value = 'Fabriqué en France dans notre atelier.';
      a.observed.siteSectionLabels[0].value = 'Made in France';
    });
    assert.ok(result.ok, JSON.stringify(!result.ok && result.issues));
    assert.equal(result.value.observed.description?.value, 'Fabriqué en France dans notre atelier.');
    assert.deepEqual(result.value.observed.description?.source, { kind: 'html_meta', key: 'description' });
  });

  it('draws no trust consequence from an observed origin', () => {
    const result = withChange((a) => {
      a.observed.description.value = 'Made in France depuis 1987.';
    });
    assert.ok(result.ok);
    // The accepted shape is exactly the contract: no field appears that could
    // carry verification, and verification stays listed as unsupported.
    assert.deepEqual(Object.keys(result.value).sort(), [
      'contractVersion', 'degraded', 'inferred', 'model', 'observed', 'target', 'unsupported', 'warnings',
    ]);
    assert.ok(result.value.unsupported.includes('verification'));
    assert.deepEqual(result.value.warnings, []);
  });
});

describe('limits', () => {
  it('bounds strings to the database columns they will fill', () => {
    assertIssue(withChange((a) => { a.inferred.shortDescription.value = 'x'.repeat(281); }), 'longer than 280');
    assertIssue(withChange((a) => { a.observed.name.value = 'x'.repeat(121); }), 'longer than 120');
    assertIssue(withChange((a) => { a.inferred.summary.value = 'x'.repeat(1001); }), 'longer than 1000');
  });

  it('bounds lists', () => {
    const tag = (i: number) => ({ value: `tag-${i}`, confidence: 0.5 });
    assertIssue(withChange((a) => { a.inferred.tags = [0, 1, 2, 3, 4, 5].map(tag); }), 'at most 5');
    const image = (i: number) => ({ value: `https://cdn.maison-leon.fr/${i}.jpg`, source: { kind: 'page_text' } });
    assertIssue(withChange((a) => { a.observed.imageUrls = [0, 1, 2, 3, 4, 5, 6].map(image); }), 'at most 6');
    const category = (slug: string) => ({ value: slug, confidence: 0.5 });
    assertIssue(
      withChange((a) => { a.inferred.secondaryCategories = ['a', 'b', 'c', 'd'].map(category); }),
      'at most 3'
    );
  });

  it('refuses empty strings — absence is null', () => {
    assertIssue(withChange((a) => { a.observed.name.value = '   '; }), 'must not be empty');
  });

  it('refuses duplicates in inferred lists', () => {
    assertIssue(
      withChange((a) => { a.inferred.styles = [{ value: 'a', confidence: 0.5 }, { value: 'a', confidence: 0.6 }]; }),
      'duplicate value'
    );
  });
});

describe('taxonomy compatibility', () => {
  it('refuses a malformed slug', () => {
    assertIssue(withChange((a) => { a.inferred.primaryCategory.value = 'Mode'; }), 'not a valid slug');
  });

  it('refuses a slug outside the live taxonomy when one is supplied', () => {
    assertIssue(
      withChange((a) => { a.inferred.primaryCategory.value = 'bijoux-imaginaires'; }, { allowedCategorySlugs: ['mode', 'accessoires'] }),
      'not in the category taxonomy'
    );
  });

  it('accepts slugs inside the supplied taxonomy', () => {
    const result = validateShopAnalysisV2(validAnalysis(), {
      allowedCategorySlugs: ['mode', 'accessoires'],
      allowedTagSlugs: ['streetwear'],
    });
    assert.ok(result.ok, JSON.stringify(!result.ok && result.issues));
  });

  it('refuses a secondary category that repeats the primary', () => {
    assertIssue(
      withChange((a) => { a.inferred.secondaryCategories = [{ value: 'mode', confidence: 0.3 }]; }),
      'must not repeat primaryCategory'
    );
  });

  it('expresses an unknown price as null, never as a value', () => {
    assertIssue(withChange((a) => { a.inferred.pricePositioning.value = 'unknown'; }), 'use null for unknown');
  });
});

describe('coherence', () => {
  it('refuses inferred content with no model to have inferred it', () => {
    assertIssue(withChange((a) => { a.model = null; a.degraded = true; }), 'must be empty when model is null');
  });

  it('refuses a non-degraded answer with no model', () => {
    const empty = emptyShopAnalysisV2(TARGET) as unknown as Json;
    empty.degraded = false;
    assertIssue(validateShopAnalysisV2(empty), 'must be true when model is null');
  });

  it('refuses a domain that is not the host of finalUrl', () => {
    assertIssue(withChange((a) => { a.target.domain = 'autre-boutique.fr'; }), 'must equal the host of finalUrl');
  });

  it('refuses a redirect count beyond the limit', () => {
    assertIssue(withChange((a) => { a.target.redirectCount = 4; }), 'redirectCount');
  });

  it('refuses unknown warnings and unsupported entries', () => {
    assertIssue(withChange((a) => { a.warnings = ['all_good']; }), 'unknown value');
    assertIssue(withChange((a) => { a.unsupported = ['verified']; }), 'unknown value');
  });

  it('refuses the wrong contract version', () => {
    assertIssue(withChange((a) => { a.contractVersion = 'shop-analysis/1'; }), 'contractVersion');
  });
});

describe('every URL inside an analysis passes the url policy', () => {
  it('refuses an internal logo, image or social URL', () => {
    assertIssue(withChange((a) => { a.observed.logoUrl.value = 'http://169.254.169.254/logo.png'; }), 'blocked_address');
    assertIssue(withChange((a) => { a.observed.imageUrls[0].value = 'http://localhost/x.jpg'; }), 'hostname_not_public');
    assertIssue(
      withChange((a) => { a.observed.socialLinks[0].value.url = 'javascript:alert(1)'; }),
      'scheme_not_allowed'
    );
  });
});

describe('the request', () => {
  it('accepts a URL, an owned submission id and the locale', () => {
    const result = validateShopAnalysisRequestV2({
      websiteUrl: 'maison-leon.fr',
      submissionId: '3f1c2a9e-5b7d-4e2a-9c1b-8d6e4f2a1b3c',
      locale: 'fr',
    });
    assert.ok(result.ok, JSON.stringify(!result.ok && result.issues));
  });

  it('refuses a request that tries to carry verification', () => {
    const result = validateShopAnalysisRequestV2({ websiteUrl: 'https://maison-leon.fr', verified: true });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.issues.some((issue) => issue.includes('forbidden field')));
  });

  it('refuses an internal URL before any fetcher sees it', () => {
    for (const websiteUrl of ['http://127.0.0.1/', 'http://metadata.google.internal/', 'file:///etc/passwd']) {
      assert.equal(validateShopAnalysisRequestV2({ websiteUrl }).ok, false, websiteUrl);
    }
  });

  it('refuses a malformed submission id and an unsupported locale', () => {
    assert.equal(validateShopAnalysisRequestV2({ websiteUrl: 'https://maison-leon.fr', submissionId: 'x' }).ok, false);
    assert.equal(validateShopAnalysisRequestV2({ websiteUrl: 'https://maison-leon.fr', locale: 'en' }).ok, false);
  });
});

describe('version 1 is untouched', () => {
  it('still validates a v1 inferred-only analysis', () => {
    const v1 = {
      summary: 'Streetwear.',
      suggestedCategories: [{ slug: 'mode', confidence: 0.8 }],
      suggestedTags: [],
      detectedStyles: [],
      detectedAudience: [],
      detectedProducts: [],
      detectedValues: [],
      pricePositioning: 'unknown',
      keywords: [],
      visualIdentity: null,
      confidence: 0.7,
      fieldConfidence: {},
    };
    assert.equal(validateShopAnalysis(v1).ok, true);
  });
});
