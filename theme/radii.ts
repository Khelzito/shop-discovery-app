/**
 * Corner radius scale.
 */
export const radii = {
  none: 0,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  /** Shop/editorial image containers. */
  image: 16,
  /** Fully rounded: chips, avatars, icon buttons. */
  pill: 999,
} as const;

export type RadiusToken = keyof typeof radii;
