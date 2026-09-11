import assert from 'node:assert/strict';
import test from 'node:test';
import { fallbackAssistantResponse, parseAssistantRequest, selectHelpArticles, validateAssistantDraft } from './assistant-grounding.ts';

const SHOP = '11111111-1111-4111-8111-111111111111';
const ARTICLE = '22222222-2222-4222-8222-222222222222';

test('assistant request is bounded and deduplicates candidate ids', () => {
  const parsed = parseAssistantRequest({ message: ' sneakers françaises ', candidateShopIds: [SHOP, SHOP], history: [] });
  assert.ok(parsed);
  assert.deepEqual(parsed.candidateShopIds, [SHOP]);
  assert.equal(parsed.message, 'sneakers françaises');
});

test('assistant draft cannot recommend an id the server did not ground', () => {
  const result = validateAssistantDraft({ mode: 'discovery', reply: 'Voici.', recommendedShopIds: [SHOP, ARTICLE], citedHelpArticleIds: [] }, [SHOP], []);
  assert.ok(result);
  assert.deepEqual(result.recommendedShopIds, [SHOP]);
});

test('help mode is rejected without a cited retrieved article', () => {
  assert.equal(validateAssistantDraft({ mode: 'help', reply: 'Oui.', recommendedShopIds: [], citedHelpArticleIds: [] }, [], [ARTICLE]), null);
});

test('lexical help retrieval prefers matching product knowledge', () => {
  const rows = selectHelpArticles('comment marche la vérification ?', [
    { id: ARTICLE, slug: 'verification', title: 'Vérification', content: 'La vérification de domaine confirme le contrôle du domaine.' },
    { id: SHOP, slug: 'autre', title: 'Favoris', content: 'Les favoris sont liés au compte.' },
  ]);
  assert.equal(rows[0]?.id, ARTICLE);
});

test('fallback never invents a shop id', () => {
  const answer = fallbackAssistantResponse([{ id: SHOP, name: 'A', shortDescription: null, countryCode: 'FR', city: null, priceLevel: null, audience: null }], []);
  assert.deepEqual(answer.recommendedShopIds, [SHOP]);
  assert.equal(answer.degraded, true);
});
