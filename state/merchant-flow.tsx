import { createContext, useContext, useState, type ReactNode } from 'react';

import { MerchantFlowStore, type LastAnalysis } from '@/lib/merchant/flow-store';

/**
 * In-memory state of one merchant flow, scoped to the merchant stack.
 *
 * Route params carry ids only. What is kept here is what should not travel
 * through navigation: the last analysis (a fallback when its proposal could
 * not be stored) and the merchant's unsent edits. Nothing is persisted; the
 * database holds the submission. The rules live in lib/merchant/flow-store.ts.
 */

export type { LastAnalysis };

const MerchantFlowContext = createContext<MerchantFlowStore | null>(null);

export function MerchantFlowProvider({ children }: { children: ReactNode }) {
  // One store for the lifetime of the merchant stack. Its state is read in
  // initialisers and event handlers, never used to drive a render.
  const [store] = useState(() => new MerchantFlowStore());
  return <MerchantFlowContext.Provider value={store}>{children}</MerchantFlowContext.Provider>;
}

export function useMerchantFlow(): MerchantFlowStore {
  const context = useContext(MerchantFlowContext);
  if (context === null) {
    throw new Error('useMerchantFlow must be called inside a MerchantFlowProvider');
  }
  return context;
}
