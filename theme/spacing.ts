/**
 * Spacing scale: 4, 8, 12, 16, 20, 24, 32, 40, 48.
 *
 * Whitespace is part of the design. Scrolling is preferred over density,
 * so favour the larger end of the scale between blocks.
 */
export const spacing = {
  none: 0,
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
  xxxl: 40,
  huge: 48,
} as const;

export type SpacingToken = keyof typeof spacing;
