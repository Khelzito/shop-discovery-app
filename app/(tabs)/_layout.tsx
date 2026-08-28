import { Tabs } from 'expo-router';

import { HapticTab } from '@/components/haptic-tab';
import { Icon } from '@/components/ui/icon';
import { colors, layout, typography } from '@/theme';

/**
 * V1 ends with exactly four tabs (Accueil, Explorer, Favoris, Profil).
 * Profil arrives in a later phase.
 */
export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarButton: HapticTab,
        tabBarActiveTintColor: colors.tabActive,
        tabBarInactiveTintColor: colors.tabInactive,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          borderTopWidth: layout.hairline,
        },
        tabBarLabelStyle: {
          fontSize: typography.caption.fontSize,
          fontWeight: typography.label.fontWeight,
        },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Accueil',
          tabBarIcon: ({ color }) => <Icon name="home" size="lg" color={color} />,
        }}
      />
      <Tabs.Screen
        name="explore"
        options={{
          title: 'Explorer',
          tabBarIcon: ({ color }) => <Icon name="explore" size="lg" color={color} />,
        }}
      />
      <Tabs.Screen
        name="favorites"
        options={{
          title: 'Favoris',
          tabBarIcon: ({ color }) => <Icon name="favorite" size="lg" color={color} />,
        }}
      />
    </Tabs>
  );
}
