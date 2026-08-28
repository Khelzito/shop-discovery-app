/**
 * Color tokens — V1 is light-mode only (see docs/MASTER_SPEC.md §3).
 *
 * ~90% of the UI stays neutral; merchant imagery supplies the color.
 * No accent color is defined yet: it is decided with the final branding.
 * `danger` is intentionally restrained and reserved for error states.
 *
 * Never use a raw hex value in a component. Add a token here instead.
 */
export const colors = {
  /** App canvas. */
  background: '#FAF9F6',
  /** Cards, sheets, bars sitting on the canvas. */
  surface: '#FFFFFF',
  /** Quiet fills: search field, image placeholders, chips. */
  surfaceSecondary: '#F2F0EB',
  /** Pressed state for surfaces and quiet controls. */
  surfacePressed: '#EAE8E3',

  /** Hairline separators and control outlines. */
  border: '#EAE8E3',
  /** Slightly stronger outline where a hairline disappears. */
  borderStrong: '#DEDBD4',

  /** Titles and primary reading text. */
  textPrimary: '#111111',
  /** Secondary lines, meta, placeholders. */
  textSecondary: '#737373',
  /** Lowest-emphasis text. Do not use for essential meaning. */
  textTertiary: '#9A968E',
  /** Text on a dark/near-black surface. */
  textInverse: '#FFFFFF',

  /** Default icon color, matches primary text. */
  icon: '#111111',
  /** Muted icon color, matches secondary text. */
  iconMuted: '#737373',

  /** Primary action background (near-black). */
  actionPrimary: '#111111',
  actionPrimaryPressed: '#2E2E2E',
  actionPrimaryText: '#FFFFFF',
  /** Disabled primary action. */
  actionDisabled: '#DEDBD4',
  actionDisabledText: '#9A968E',

  /** Errors only. Deliberately muted to preserve the calm palette. */
  danger: '#A5352B',
  dangerSurface: '#FBF1EF',
  dangerBorder: '#EBD5D1',

  /** Skeleton loading. */
  skeleton: '#EFEDE8',

  /** Bottom navigation. */
  tabActive: '#111111',
  tabInactive: '#9A968E',

  /** Overlay above imagery. */
  scrim: 'rgba(17, 17, 17, 0.32)',
  /** Heavier overlay, for white text sitting directly on a photograph. */
  scrimStrong: 'rgba(17, 17, 17, 0.42)',
  /** Resting background for a control floating over a photograph. */
  overlayChip: 'rgba(255, 255, 255, 0.92)',
  /** Same control while pressed. */
  overlayChipPressed: 'rgba(255, 255, 255, 0.75)',
} as const;

export type ColorToken = keyof typeof colors;
