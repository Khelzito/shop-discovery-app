import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { scanClaimMeta } from './meta-token.ts';

const TOKEN = `sd-claim-${'a1'.repeat(32)}`;
const OTHER = `sd-claim-${'b2'.repeat(32)}`;

const page = (head: string, body = '<p>Bienvenue</p>') =>
  `<!doctype html><html lang="fr"><head><title>Boutique</title>${head}</head><body>${body}</body></html>`;

describe('scanClaimMeta — finds the tag as merchants write it', () => {
  it('reads the exact tag the app displays', () => {
    const scan = scanClaimMeta(page(`<meta name="shop-discovery-verification" content="${TOKEN}">`));
    assert.deepEqual(scan, { metaTags: 1, tokens: [TOKEN] });
  });

  it('accepts attribute order, quotes, case, spacing and self-closing variants', () => {
    for (const tag of [
      `<meta content="${TOKEN}" name="shop-discovery-verification">`,
      `<meta name='shop-discovery-verification' content='${TOKEN}'>`,
      `<META NAME="Shop-Discovery-Verification" CONTENT="${TOKEN}">`,
      `<meta   name = "shop-discovery-verification"   content = "  ${TOKEN}  " />`,
      `<meta name=shop-discovery-verification content=${TOKEN}>`,
      `<meta\nname="shop-discovery-verification"\ncontent="${TOKEN}"\n/>`,
    ]) {
      assert.deepEqual(scanClaimMeta(page(tag)).tokens, [TOKEN], tag);
    }
  });

  it('accepts the tag in the body, where some site builders put custom HTML', () => {
    assert.deepEqual(scanClaimMeta(page('', `<div><meta name="shop-discovery-verification" content="${TOKEN}"></div>`)).tokens, [TOKEN]);
  });

  it('decodes entities in the content attribute', () => {
    const encoded = TOKEN.replace('sd-', 'sd&#45;');
    assert.deepEqual(scanClaimMeta(page(`<meta name="shop-discovery-verification" content="${encoded}">`)).tokens, [TOKEN]);
  });
});

describe('scanClaimMeta — refuses what is not the tag', () => {
  it('ignores tokens quoted in comments, scripts, styles, titles, textareas and templates', () => {
    const tag = `<meta name="shop-discovery-verification" content="${TOKEN}">`;
    const html = page(
      `<!-- ${tag} --><script>document.write('${tag}')</script><style>/* ${tag} */</style>`,
      `<title>${tag}</title><textarea>${tag}</textarea><template>${tag}</template><p>&lt;meta name="shop-discovery-verification" content="${TOKEN}"&gt;</p>`
    );
    assert.deepEqual(scanClaimMeta(html), { metaTags: 0, tokens: [] });
  });

  it('ignores other names and property-only tags', () => {
    for (const tag of [
      `<meta name="shop-discovery-verification-2" content="${TOKEN}">`,
      `<meta name="google-site-verification" content="${TOKEN}">`,
      `<meta property="shop-discovery-verification" content="${TOKEN}">`,
      `<metadata name="shop-discovery-verification" content="${TOKEN}">`,
    ]) {
      assert.deepEqual(scanClaimMeta(page(tag)).tokens, [], tag);
    }
  });

  it('counts a malformed token as a tag, never as a candidate', () => {
    for (const content of [TOKEN.toUpperCase(), TOKEN.slice(0, -1), `${TOKEN}0`, `x${TOKEN}`, '', 'sd-claim-']) {
      const scan = scanClaimMeta(page(`<meta name="shop-discovery-verification" content="${content}">`));
      assert.equal(scan.metaTags, 1, content);
      assert.deepEqual(scan.tokens, [], content);
    }
  });

  it('keeps distinct tokens in order, deduplicated and capped', () => {
    const tags = [TOKEN, OTHER, TOKEN]
      .concat(Array.from({ length: 12 }, (_, index) => `sd-claim-${index.toString(16).padStart(64, 'c')}`))
      .map((token) => `<meta name="shop-discovery-verification" content="${token}">`)
      .join('');
    const scan = scanClaimMeta(page(tags));
    assert.equal(scan.tokens.length, 8);
    assert.deepEqual(scan.tokens.slice(0, 2), [TOKEN, OTHER]);
    assert.equal(scan.metaTags, 15);
  });
});

describe('scanClaimMeta — hostile documents', () => {
  it('stays linear on unterminated quotes and many tag openings', () => {
    const hostile = `<meta name="shop-discovery-verification content="${'x'.repeat(10)}`.repeat(60_000);
    const started = Date.now();
    const scan = scanClaimMeta(hostile);
    assert.ok(Date.now() - started < 2000, 'scan took too long');
    assert.deepEqual(scan.tokens, []);
  });

  it('skips an over-long tag without losing a valid one after it', () => {
    const html = page(`<meta name="x" content="${'y'.repeat(10_000)}"><meta name="shop-discovery-verification" content="${TOKEN}">`);
    assert.deepEqual(scanClaimMeta(html).tokens, [TOKEN]);
  });

  it('returns nothing for an empty or text-only document', () => {
    assert.deepEqual(scanClaimMeta(''), { metaTags: 0, tokens: [] });
    assert.deepEqual(scanClaimMeta(TOKEN), { metaTags: 0, tokens: [] });
  });
});
