import { Stack } from 'expo-router';

import { MerchantFlowProvider } from '@/state/merchant-flow';
import { colors } from '@/theme';

/**
 * The merchant flow: welcome → add → review → submitted, and claim.
 *
 * Its in-memory state lives here, so it exists for the duration of the flow
 * and is gone once the merchant leaves it.
 */
export default function MerchantLayout() {
  return (
    <MerchantFlowProvider>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
        }}
      />
    </MerchantFlowProvider>
  );
}
