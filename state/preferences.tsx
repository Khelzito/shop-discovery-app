import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * Consumer preferences.
 *
 * Session-local for now. The shape mirrors what `profiles` will hold once the
 * table exists (interest ids and an ISO country code), so migrating means
 * swapping the state source, not reshaping the data.
 *
 * Interest ids are the ids from `data/explore-categories.ts`, so preferences
 * and browsing speak the same vocabulary when ranking arrives.
 */
export type Preferences = {
  interests: ReadonlySet<string>;
  /** ISO 3166-1 alpha-2. */
  deliveryCountry: string;
};

type PreferencesContextValue = Preferences & {
  isInterested: (interestId: string) => boolean;
  toggleInterest: (interestId: string) => void;
  setDeliveryCountry: (countryCode: string) => void;
};

const DEFAULT_DELIVERY_COUNTRY = 'FR';

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [interests, setInterests] = useState<ReadonlySet<string>>(() => new Set());
  const [deliveryCountry, setDeliveryCountry] = useState(DEFAULT_DELIVERY_COUNTRY);

  const isInterested = useCallback(
    (interestId: string) => interests.has(interestId),
    [interests]
  );

  const toggleInterest = useCallback((interestId: string) => {
    setInterests((current) => {
      const next = new Set(current);
      if (next.has(interestId)) {
        next.delete(interestId);
      } else {
        next.add(interestId);
      }
      return next;
    });
  }, []);

  const value = useMemo<PreferencesContextValue>(
    () => ({
      interests,
      deliveryCountry,
      isInterested,
      toggleInterest,
      setDeliveryCountry,
    }),
    [interests, deliveryCountry, isInterested, toggleInterest]
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): PreferencesContextValue {
  const context = useContext(PreferencesContext);
  if (context === null) {
    throw new Error('usePreferences must be called inside a PreferencesProvider');
  }
  return context;
}
