# AI ARCHITECTURE — V1

## Principle
**AI understands. The database verifies. The ranking system orders. The user remains in control.**

AI is intentionally narrow in V1. Do not add AI merely for marketing.

## AI capability 1 — Natural Search Parser
Input: user natural-language search.

Example:
`Je cherche une petite marque française de sneakers minimalistes pas trop chère.`

Output should be validated structured data, e.g.:
```json
{
  "category": "sneakers",
  "country": "FR",
  "tags": ["minimaliste", "independant"],
  "max_price_level": 2
}
```

The LLM does not return the final shop list. PostgreSQL/search services execute against our catalogue.

Simple keyword/category searches should work without AI. AI failure must not make basic search unavailable.

## AI capability 2 — Shop Analyzer
Input pipeline:
Merchant URL -> server-side extraction -> normalized extracted content -> AI -> structured proposal -> merchant confirmation.

AI may propose:
- Shop name.
- Short description.
- Long description draft.
- Categories.
- Up to ~5 useful tags.
- Country only when supported by extracted evidence, otherwise unknown.
- Price level only when reasonably inferable, otherwise unknown.

AI output is a proposal, never a verification result.

## AI must never autonomously assert
- Verified shop.
- Legitimate business.
- Verified identity.
- Made in France.
- Eco-responsible certification.
- Delivery coverage not evidenced.
- Return terms not evidenced.
- Legal/corporate facts not supported by trusted evidence.
- Publication approval.

Unknown is preferable to fabricated certainty.

## Server-side boundary
Mobile app never calls the LLM provider directly.

`Mobile App -> Backend/Edge Function -> AIService -> Provider Adapter -> LLM`

Secrets remain server-side.

## Provider abstraction
Implement a provider-neutral interface, conceptually:
- `parseSearchIntent(input)`
- `analyzeShop(extractedData)`

The rest of the application should not depend on Anthropic/OpenAI/Google-specific response shapes.

## Validation
Every AI response must be validated against an explicit schema before use. Reject or repair malformed outputs server-side. Never trust arbitrary model text as database-ready data.

## Cost and resilience
- Use deterministic/classic search for simple queries.
- Cache safe/reusable intent parsing where useful.
- Persist shop analysis runs for debugging.
- Add sensible timeouts/retries.
- The app remains usable if AI is temporarily unavailable.

## Site analysis boundary
Do not build a massive autonomous crawler for V1. Extract only the minimum public/authorized information needed to create a useful proposal. Respect technical/legal constraints and merchant confirmation.

## Recommendations
Home recommendation sections do not require an LLM in V1. Use application data and ranking logic.

## External web search
Out of scope for initial V1.

Future hybrid model:
1. Search verified/internal catalogue first.
2. If insufficient, optionally search external sources.
3. Clearly label external shops as not verified by the platform.

## Discovery ranking is not an LLM

Prompt 18 keeps Home personalization deterministic and database-driven. The
model is not asked to decide what a user should see. Explicit preferences and
first-party interaction signals feed a bounded SQL ranker, with exposure
penalties and category diversity so popularity does not become the only path
to visibility. AI remains responsible for understanding natural-language
search; the database remains responsible for recommendation eligibility and
ordering.
