import { useCallback, useEffect, useState } from 'react';

/**
 * Minimal async state for a screen.
 *
 * Deliberately not a caching library. The app fetches a handful of small
 * lists; adding React Query now would be a dependency and a mental model paid
 * for before anything needs them. This covers loading, error and reload, and
 * cancels on unmount so a slow response cannot set state on a gone screen.
 *
 * `load` must be stable — wrap it in `useCallback` — because it is the effect
 * dependency and therefore what re-runs the fetch.
 */
export type AsyncResource<T> =
  | { status: 'loading'; data: null; error: null }
  | { status: 'ready'; data: T; error: null }
  | { status: 'error'; data: null; error: unknown };

export type AsyncResourceState<T> = AsyncResource<T> & { reload: () => void };

export function useAsyncResource<T>(load: () => Promise<T>): AsyncResourceState<T> {
  const [state, setState] = useState<AsyncResource<T>>({
    status: 'loading',
    data: null,
    error: null,
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setState({ status: 'loading', data: null, error: null });

    load()
      .then((data) => {
        if (active) {
          setState({ status: 'ready', data, error: null });
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setState({ status: 'error', data: null, error });
        }
      });

    return () => {
      active = false;
    };
  }, [load, attempt]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  return { ...state, reload };
}
