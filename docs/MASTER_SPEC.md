# MASTER SPEC — Shop Discovery App (V1)

## 1. Product vision
A mobile discovery platform that helps consumers find reliable online shops and independent brands they would probably not have discovered otherwise.

Consumer promise: **Discover shops worth knowing.**
Merchant promise: **Get your shop discovered by new potential customers.**

This is not Amazon, Google Shopping, or a traditional directory. It is a **shop discovery engine**. Purchases remain on the merchant's own website in V1.

## 2. Product principles
- Minimal, premium, spacious, calm interface.
- Discovery over density.
- Photography/content over UI decoration.
- Progressive disclosure: show only what matters now.
- Trust is a core product feature, not a paid badge.
- AI understands intent; structured data determines results.
- A merchant should be able to start onboarding with only a shop URL.
- V1 must remain small and excellent rather than feature-heavy.

## 3. V1 scope
### Consumer
- Lightweight onboarding and interest selection.
- Home.
- Explore.
- Natural-language and classic search.
- Search results and filters.
- Shop profile.
- Favorites.
- User profile/preferences.
- External visit to merchant website.
- Shop reporting.

### Merchant
- Start from Profile > Add my shop.
- Submit shop URL.
- Automated site analysis and proposed profile.
- Review/edit proposed information.
- Select/upload shop visuals.
- Domain-control verification flow.
- Business verification status.
- Submit for moderation.
- Merchant dashboard.
- Edit owned shop profile.
- Basic metrics: profile views and outbound website clicks.

### Explicitly out of scope for initial V1
- In-app checkout/cart/payment.
- Order, stock, shipping or return management.
- Merchant/customer messaging.
- TikTok-style video feed.
- Complex public comments/reviews.
- Product comparison.
- Full product-catalog synchronization.
- Web-wide AI shopping search.
- Complex advertising/boost system.
- Promotions in first development pass.
- Dark mode.
- Generative chatbot screen.

## 4. Navigation
Exactly four primary bottom tabs:
1. Home
2. Explore
3. Favorites
4. Profile

Search and discovery coexist inside Explore. Avoid unnecessary tabs.

## 5. Primary consumer journey
Open app -> Home/Explore -> Search or discover -> Results -> Shop profile -> Favorite and/or Visit -> Merchant website.

The core product moment is: **“I didn’t know this shop, and I’m glad I found it.”**

## 6. Primary merchant journey
Profile -> Add my shop -> Enter URL -> Automated analysis -> Proposed profile -> Merchant corrections -> Domain/business verification -> Submit for review -> Published -> Dashboard.

If the shop already exists, offer **Claim this shop** rather than creating a duplicate.

## 7. Home
Home contains only three discovery sections in V1:
- **For you**: interests + behavior + controlled diversity.
- **Hidden gems**: relevant, trusted, quality shops receiving comparatively low exposure; good engagement can increase eligibility.
- **New**: recently published shops meeting minimum quality/trust requirements.

Rules:
- Do not repeat the same shop twice on one Home render.
- Reduce excessive repetition across sessions when catalogue size allows.
- Do not add categories, promotions, news, trends, etc. to Home in V1.
- Search remains prominent near the top.

## 8. Explore and search
Explore supports browsing when query is empty and results when a query exists.

Example queries:
- “shoes” -> classic category/text search.
- “small French minimalist menswear brands” -> AI parses structured intent, database executes search.
- “a gift for my girlfriend under €50, original but elegant” -> AI may infer cross-category constraints.

Manual filters remain available: budget/price level, country, delivery destination when data exists, category, verified shops, tags/style.

Do not create a separate “Ask AI” mode. The normal search box is intelligent.

## 9. Search ranking principles
Ranking should combine:
- Query relevance (dominant factor).
- Trust/safety eligibility.
- Profile quality/completeness.
- Reasonable engagement/popularity.
- Freshness.
- Discovery/diversity boost.

Do not sort purely by popularity. Independent/new shops must have a fair path to visibility.

## 10. Shop profile
Above the fold:
- Large cover visual.
- Shop name + subtle verified indicator if eligible.
- Short positioning/category + country.
- Favorite action.
- Primary CTA: **Visit**.

Then, progressively:
- Short about section.
- Gallery/selection.
- Essential information.
- Trust section (e.g. domain verified, business verified).
- Link explaining verification methodology.

Avoid dense marketplace metadata.

## 11. Trust and moderation
Never promise zero scam. Communicate verification levels transparently.

Verification dimensions can include:
- Domain control.
- Business/legal existence.
- Identity where appropriate.
- Website security checks.

A paid plan must never purchase a trust badge.

Publishing workflow:
`draft -> pending_review -> published | rejected`
Published shops may later become `suspended`.

Users can report suspicious shops. Verification/moderation status must be controlled server-side/admin-side, never by the mobile client.

## 12. Images
Three states:
1. No usable visual: elegant typographic placeholder derived from shop identity.
2. Merchant-provided/approved logo, cover and gallery.
3. Future product/catalog visuals.

Never use fake AI product/shop imagery that could be mistaken for merchant-owned content. Avoid broken-image placeholders and generic stock photography.

## 13. Technical stack
- React Native
- Expo
- TypeScript
- Expo Router
- Supabase Auth
- Supabase PostgreSQL
- Supabase Storage
- Supabase Edge Functions/server-side functions where appropriate
- Git + GitHub
- Cursor as AI-assisted IDE

Keep AI provider behind a server-side abstraction so the provider can change without rewriting the app.

## 14. Security principles
- Enable RLS on user/business tables.
- Client may use Supabase public/anon credentials as intended.
- Never ship service-role credentials, AI provider secrets, identity-provider secrets, or privileged API keys in the app.
- Privileged verification, moderation and publication transitions are server/admin operations.
- Validate and normalize all external URLs.
- Do not trust AI-generated facts as verification evidence.

## 15. Analytics
V1 tracks at minimum:
- Shop profile views.
- Outbound clicks to merchant website.
- Discovery source (home, explore, search, favorites, direct).

Merchant dashboard should focus on understandable value, not vanity metrics.

## 16. Coding rules for Cursor
- Read all `/docs` files before implementing a feature.
- Before code changes, state the intended files and approach.
- Inspect existing components before creating new ones.
- Never duplicate an existing reusable component unnecessarily.
- Never introduce arbitrary colors, spacing, typography sizes or radii outside design tokens.
- Do not modify unrelated files unless necessary.
- Prefer maintainable, simple solutions over premature abstractions.
- Preserve TypeScript strictness and meaningful types.
- Do not expose secrets client-side.
- Do not silently change architecture or product scope.
- Ask for/flag a decision if implementation conflicts with this specification.
- Keep each development mission small enough to test before continuing.

## 17. Definition of Done for a feature
A feature is done only when:
- It matches the spec and visual system.
- Loading, empty and error states are handled.
- Main happy path works on a real device/emulator.
- Type checking/linting/tests relevant to the feature pass.
- Security/RLS implications are reviewed.
- No unrelated regression is observed.
- A Git commit can safely mark the feature as stable.
