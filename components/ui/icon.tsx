import Feather from '@expo/vector-icons/Feather';
import type { ComponentProps } from 'react';
import type { StyleProp, TextStyle } from 'react-native';

import { colors, layout } from '@/theme';

type FeatherName = ComponentProps<typeof Feather>['name'];

/**
 * The app's icon vocabulary.
 *
 * Every icon used in the product must be declared here with a semantic name.
 * Screens never reference a Feather name directly, so the whole icon family
 * can be swapped by editing this single map.
 */
const ICONS = {
  home: 'home',
  explore: 'compass',
  favorite: 'heart',
  profile: 'user',
  search: 'search',
  clear: 'x',
  close: 'x',
  chevronRight: 'chevron-right',
  chevronLeft: 'chevron-left',
  chevronDown: 'chevron-down',
  back: 'arrow-left',
  external: 'arrow-up-right',
  verified: 'check',
  check: 'check',
  filter: 'sliders',
  info: 'info',
  alert: 'alert-circle',
  image: 'image',
  shop: 'shopping-bag',
  tag: 'tag',
  globe: 'globe',
  mapPin: 'map-pin',
  shield: 'shield',
  edit: 'edit-2',
  plus: 'plus',
  more: 'more-horizontal',
  settings: 'settings',
  flag: 'flag',
  sparkle: 'star',
} as const satisfies Record<string, FeatherName>;

export type IconName = keyof typeof ICONS;

/** Named sizes from the layout tokens, or an explicit number when needed. */
export type IconSize = keyof typeof layout.iconSize;

export type IconProps = {
  name: IconName;
  /** Token size name. Defaults to `md` (20). */
  size?: IconSize | number;
  /** Any color token value. Defaults to the primary icon color. */
  color?: string;
  style?: StyleProp<TextStyle>;
};

export function Icon({ name, size = 'md', color = colors.icon, style }: IconProps) {
  const resolvedSize = typeof size === 'number' ? size : layout.iconSize[size];

  return (
    <Feather
      name={ICONS[name]}
      size={resolvedSize}
      color={color}
      style={style}
      // Icons are decorative unless a parent control provides the label.
      accessibilityElementsHidden
      importantForAccessibility="no"
    />
  );
}
