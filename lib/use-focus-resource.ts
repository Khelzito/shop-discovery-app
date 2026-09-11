import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import type { AsyncResource, AsyncResourceState } from './use-async-resource';

/**
 * Like useAsyncResource, but loads each time the screen gains focus.
 *
 * For screens whose data another screen changes — a request reviewed, a shop
 * edited — so returning to them shows the current state. A refresh keeps what
 * is already on screen: no loading flash, and a failed refresh leaves the
 * last good data in place.
 *
 * `load` must be stable — wrap it in `useCallback`.
 */
export function useFocusResource<T>(load: () => Promise<T>): AsyncResourceState<T> {
  const [state, setState] = useState<AsyncResource<T>>({ status: 'loading', data: null, error: null });

  useFocusEffect(
    useCallback(() => {
      let active = true;
      load()
        .then((data) => {
          if (active) {
            setState({ status: 'ready', data, error: null });
          }
        })
        .catch((error: unknown) => {
          if (active) {
            setState((current) => (current.status === 'ready' ? current : { status: 'error', data: null, error }));
          }
        });
      return () => {
        active = false;
      };
    }, [load])
  );

  const reload = useCallback(() => {
    setState({ status: 'loading', data: null, error: null });
    load()
      .then((data) => setState({ status: 'ready', data, error: null }))
      .catch((error: unknown) => setState({ status: 'error', data: null, error }));
  }, [load]);

  return { ...state, reload };
}
