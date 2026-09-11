import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { loadPreferences, setInterest, setShippingCountry } from '@/lib/api/preferences';
import { useAuth } from '@/state/auth';

export type Preferences = {
  interests: ReadonlySet<string>;
  deliveryCountry: string;
};

type PreferencesContextValue = Preferences & {
  isInterested: (interestId: string) => boolean;
  toggleInterest: (interestId: string) => void;
  setDeliveryCountry: (countryCode: string) => void;
  hydrated: boolean;
};

const DEFAULT_DELIVERY_COUNTRY = 'FR';
const PreferencesContext = createContext<PreferencesContextValue | null>(null);

/** Explicit discovery preferences, persisted per account under existing RLS. */
export function PreferencesProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const [interests, setInterests] = useState<ReadonlySet<string>>(() => new Set());
  const [deliveryCountry, setDeliveryCountryState] = useState(DEFAULT_DELIVERY_COUNTRY);
  const [hydrated, setHydrated] = useState(userId === null);
  const generation = useRef(0);

  useEffect(() => {
    const run = ++generation.current;
    if (!userId) {
      setInterests(new Set());
      setDeliveryCountryState(DEFAULT_DELIVERY_COUNTRY);
      setHydrated(true);
      return;
    }
    setHydrated(false);
    void loadPreferences(userId)
      .then((value) => {
        if (generation.current !== run) return;
        setInterests(new Set(value.interests));
        setDeliveryCountryState(value.deliveryCountry);
        setHydrated(true);
      })
      .catch(() => {
        if (generation.current !== run) return;
        setHydrated(true);
      });
  }, [userId]);

  const isInterested = useCallback((interestId: string) => interests.has(interestId), [interests]);

  const toggleInterest = useCallback((interestId: string) => {
    const nextActive = !interests.has(interestId);
    setInterests((current) => {
      const next = new Set(current);
      if (nextActive) next.add(interestId);
      else next.delete(interestId);
      return next;
    });
    if (userId) {
      void setInterest(userId, interestId, nextActive).catch(() => {
        setInterests((current) => {
          const next = new Set(current);
          if (nextActive) next.delete(interestId);
          else next.add(interestId);
          return next;
        });
      });
    }
  }, [interests, userId]);

  const setDeliveryCountry = useCallback((countryCode: string) => {
    const previous = deliveryCountry;
    const next = countryCode.trim().toUpperCase();
    setDeliveryCountryState(next);
    if (userId) {
      void setShippingCountry(userId, next).catch(() => setDeliveryCountryState(previous));
    }
  }, [deliveryCountry, userId]);

  const value = useMemo<PreferencesContextValue>(
    () => ({ interests, deliveryCountry, isInterested, toggleInterest, setDeliveryCountry, hydrated }),
    [interests, deliveryCountry, isInterested, toggleInterest, setDeliveryCountry, hydrated]
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): PreferencesContextValue {
  const context = useContext(PreferencesContext);
  if (context === null) throw new Error('usePreferences must be called inside a PreferencesProvider');
  return context;
}
