# DEVELOPMENT PLAN — Cursor Execution Roadmap

## Operating method
Do not ask Cursor to build the entire app at once.

For each mission:
1. Read relevant docs.
2. Plan changes before coding.
3. Implement a small coherent slice.
4. Run app/typecheck/lint/tests as relevant.
5. Test manually on emulator/real device.
6. Fix regressions.
7. Commit stable state to Git.
8. Continue only after validation.

## Phase 00 — Environment and repository
- Install/verify Node.js, Git, Cursor, Expo tooling.
- Create GitHub repository.
- Initialize Expo + TypeScript project.
- Confirm clean app launches on device/emulator.
- Add `/docs` files to repo.
- Establish `.env` conventions and `.gitignore`.

Deliverable: blank but healthy version-controlled Expo app.

## Phase 01 — Foundation and design tokens
- Create project folders.
- Add colors, typography, spacing, radius tokens.
- Select consistent icon library.
- Build foundational primitives/components.
- No feature logic yet.

Deliverable: reusable design foundation matching DESIGN_SYSTEM.md.

## Phase 02 — Navigation and screen shells
- Expo Router structure.
- Four tabs: Home, Explore, Favorites, Profile.
- Shop detail route.
- Merchant/auth route groups.
- Empty screen shells only where possible.

Deliverable: complete navigable skeleton.

## Phase 03 — Supabase foundation
- Create Supabase project/config.
- Add migrations/enums/tables/indexes.
- Add Storage buckets/policies.
- Implement RLS intentionally.
- Generate/use typed database definitions if appropriate.

Deliverable: secure database foundation.

## Phase 04 — Authentication and profile
- Sign up/sign in/sign out.
- Profile creation.
- User preferences and onboarding interests.
- Session handling.

Deliverable: user can authenticate and persist basic profile/preferences.

## Phase 05 — Seed data and shop read model
- Add development seed categories/tags/shops.
- Build shop service/read queries.
- Build image placeholder behavior.

Deliverable: app can render realistic shop data safely.

## Phase 06 — Home
- Search entry.
- For You.
- Hidden Gems.
- New.
- Skeleton/empty/error states.
- No duplicate shop on one Home render.

Deliverable: reference-quality Home screen.

## Phase 07 — Explore and classic search
- Categories/browse state.
- Keyword/full-text search.
- Filters.
- Search result cards.
- No-results state.

Deliverable: useful search without AI.

## Phase 08 — Shop profile and outbound tracking
- Shop detail.
- Gallery.
- Trust summary.
- Favorite control.
- Visit CTA.
- Record shop view/outbound click source.

Deliverable: full consumer discovery-to-merchant journey.

## Phase 09 — Favorites and profile
- Favorites CRUD with RLS.
- Favorites screen.
- Profile/preferences/settings entry points.

Deliverable: complete core consumer V1 loop.

## Phase 10 — Merchant foundation
- Add/claim shop entry.
- Shop membership authorization.
- Draft shop editing.
- Merchant dashboard shell.

Deliverable: merchant can own/manage a draft shop.

## Phase 11 — Shop URL analysis
- Server-side URL validation/extraction.
- AIService abstraction.
- Shop Analyzer structured output validation.
- Persist `shop_analysis_runs`.
- Merchant review/edit of proposal.
- Visual selection/upload flow.

Deliverable: URL -> proposed shop profile.

## Phase 12 — Verification and moderation
- Domain verification flow chosen for V1.
- Business verification status workflow.
- Admin/backend-only status transitions.
- Submit for review.
- Published/draft visibility behavior.
- Reporting flow.

Deliverable: safe publication lifecycle.

## Phase 13 — Natural-language search
- Search intent parser service.
- Schema validation.
- Map intent to DB filters.
- Fallback to classic search.
- Cache where justified.

Deliverable: same search box supports natural queries.

## Phase 14 — Merchant analytics
- Profile views.
- Outbound clicks.
- Source breakdown.
- Simple dashboard presentation.

Deliverable: merchant sees concrete traffic value.

## Phase 15 — Hardening
- Security review/RLS tests.
- Error handling.
- Loading states.
- Performance/image optimization.
- Accessibility pass.
- Device testing.
- Crash/edge-case cleanup.
- Remove debug code/secrets.

Deliverable: beta-ready V1.

## Phase 16 — Private beta
Outside pure coding:
- Load initial quality catalogue.
- Invite first merchants/users.
- Measure searches, profile opens, favorites, outbound clicks and return behavior.
- Fix based on observed behavior before adding new scope.

## First prompt to Cursor
After the docs are copied into the repository, use a prompt similar to:

> Read every file in `/docs`, especially `MASTER_SPEC.md`. Do not implement the application yet. First summarize the product, V1 boundaries, technical architecture, database/security constraints, design principles, and development phases in your own words. Then inspect the current repository and propose the exact steps for Phase 00/01 only. Flag any contradictions or missing decisions before changing files.

Only after reviewing its plan should implementation begin.
