# Shop Discovery App

Mobile discovery platform for finding independent online shops. Purchases stay on the merchant website.

See `/docs` for product spec, design system, database, AI architecture, and the development plan. Start with `docs/MASTER_SPEC.md`.

## Requirements

- Node.js 20.19.x or later
- Expo CLI via the project (`npx expo`)
- Expo Go or an Android emulator on Windows; iOS Simulator requires a Mac

## Setup

```sh
npm install
cp .env.example .env
npx expo start
```

Fill `.env` with public Supabase values when they exist. Only `EXPO_PUBLIC_` variables are available in the client. Never put a service-role key, LLM secret, or other privileged credential in the app or in `EXPO_PUBLIC_` variables.

`.env` is gitignored. `.env.example` is tracked.

## Scripts

| Command | Purpose |
|---|---|
| `npm start` | Start the Expo dev server |
| `npm run android` | Open on Android |
| `npm run ios` | Open on iOS (macOS only) |
| `npm run web` | Open in a browser |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript (`tsc --noEmit`) |

## Design system

Design tokens live in `theme/` and are the single source of truth for colors,
typography, spacing, radii and layout. Import them from `@/theme`. Never write a
raw hex value, font size, spacing number or radius in a screen.

Reusable primitives live in `components/ui/` and are re-exported from
`@/components/ui`: `Text`, `Screen`, `Icon`, `Button`, `SearchField`,
`ImageFrame`, `Skeleton`, `Section`, `VerifiedMark`, `EmptyState`. Check that
list before creating a new component.

V1 constraints: light mode only, French-only copy, Feather icons (routed through
`components/ui/icon.tsx`), and the platform system font. No accent color is
defined until branding is settled.

This repository is currently at Phase 01: design tokens and UI primitives. The
Explore tab temporarily renders a live preview of the design system and is
replaced by the real Explore screen in a later phase.
