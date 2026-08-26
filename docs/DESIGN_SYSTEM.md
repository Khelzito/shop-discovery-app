# DESIGN SYSTEM — V1

## Visual direction
Premium, minimal, spacious, modern, calm. The app should feel closer to an editorial brand-discovery product than a dense marketplace.

Core rule: **If information is not necessary at that moment, do not show it.**

## Palette
Initial neutral tokens:
- `background`: `#FAF9F6`
- `surface`: `#FFFFFF`
- `textPrimary`: `#111111`
- `textSecondary`: `#737373`
- `border`: `#EAE8E3`
- `surfaceSecondary`: `#F2F0EB`
- `accent`: TBD after final branding/name

Approximately 90% of UI should remain neutral. Merchant imagery supplies most visual color.

## Typography
Use one modern sans-serif family compatible with Expo. Desired feel: Inter / Geist / SF Pro family of aesthetics, without mixing many families.

Suggested scale:
- Screen title: 28–32, SemiBold
- Section title: 19–21, SemiBold
- Shop name: 16–18, SemiBold
- Body: 14–16, Regular
- Secondary/meta: 12–14, Regular

Use mainly Regular, Medium and SemiBold.

## Spacing
Use a central spacing scale only. Suggested base tokens:
- 4, 8, 12, 16, 20, 24, 32, 40, 48

Whitespace is part of the design. Scrolling is preferable to density.

## Radius
Use a central radius scale. Suggested:
- small: 8
- medium: 12
- large: 16
- pill: 999

Shop image containers generally use 14–18px visual radius; settle on tokenized values during implementation.

## Shop cards
Do not place all metadata inside heavy bordered cards.

Preferred composition:
- Large image.
- Shop name + subtle verified mark + favorite icon.
- One concise secondary line such as `Streetwear · France`.

Avoid dense rows of ratings, flags, price, delivery, badges and buttons.

## Images
Recommended ratios:
- Primary shop/editorial: 4:5
- Horizontal/editorial: 3:2
- Small selection: 1:1

Use cover cropping with merchant-adjustable focal/crop when feasible.

No usable image state: elegant typographic placeholder with shop initials/name and subtle neutral background. Never fake merchant imagery with AI.

## Search bar
Search is a signature component:
- Large enough to feel primary.
- Very subtle border/background.
- No multicolor AI icon.
- Placeholder such as `Qu'est-ce que tu cherches ?`
- Intelligence is implicit.

## Buttons
### Primary
- Dark/near-black background.
- White text.
- Comfortable touch height.
- Moderate rounded corners.
- One dominant primary action per section.

Typical CTA: `Visiter ↗`

### Secondary
Prefer text actions (`Voir tout`, `Modifier`) over excessive outlined rectangles.

## Icons
One consistent outline icon family. Avoid mixing emojis, filled icons and unrelated styles. No greeting emoji in Home.

## Bottom navigation
Four tabs only:
- Accueil
- Explorer
- Favoris
- Profil

Active: dark icon/text. Inactive: muted gray. No oversized colored active pill.

## Motion
Subtle only:
- Favorite micro-interaction.
- Screen transition.
- Image fade-in.
- Bottom-sheet transition.
- Skeleton loading.

If the animation calls attention to itself, it is probably too strong.

## Loading / empty / error
- Use lightweight skeleton loaders instead of plain “Loading…” text where appropriate.
- Empty states are concise and helpful.
- No-results search should offer nearby/related results and future broader-search affordance rather than a dead end.
- Error states must preserve the calm visual language.

## Accessibility
- Comfortable touch targets.
- Good contrast.
- Readable text.
- Do not encode important meaning only with color.

## Reference screen structure
### Home
Logo/name -> prominent search -> For you -> Hidden gems -> New -> bottom tabs.
No greeting line. No category overload.

### Explore
Title/search -> lightweight categories -> inspirations -> popular/discovery content when query is empty; results when query exists.

### Shop profile
Large cover -> name/verified/favorite -> short descriptor -> Visit CTA -> about -> gallery -> essentials -> trust.
