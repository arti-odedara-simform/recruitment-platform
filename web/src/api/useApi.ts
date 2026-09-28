import { useCallback, useEffect, useState } from 'react';
import { ApiError } from './client.js';

/**
 * The smallest thing that covers this app's reads: run a request, expose
 * `{ data, error, loading, reload }`.
 *
 * Deliberately not react-query. Three screens, no mutations that need cache
 * invalidation, no optimistic updates — a dependency that solves problems this app does
 * not have would be harder to justify than twenty lines.
 */
export interface AsyncState<T> {
  data: T | null;
  error: ApiError | Error | null;
  loading: boolean;
  reload: () => void;
}

interface Settled<T> {
  data: T | null;
  error: ApiError | Error | null;
  loading: boolean;
}

export function useApi<T>(request: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [state, setState] = useState<Settled<T>>({ data: null, error: null, loading: true });
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    let live = true;

    /**
     * The one synchronous state update in an effect in this app, and it is the point of
     * the hook: when the inputs change, the screen is loading again, and the previous
     * result must stop being displayed as current. React's lint rule warns about this
     * because it costs a render — here that render is the intended behaviour, not a
     * cascade, and the alternative (deriving `loading` from a request id stored in
     * state) trades one render for bookkeeping that is harder to read than it is worth.
     */
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState((previous) => ({ ...previous, loading: true, error: null }));

    request()
      .then((data) => {
        if (live) setState({ data, error: null, loading: false });
      })
      .catch((cause: unknown) => {
        if (live) {
          setState({
            data: null,
            error: cause instanceof Error ? cause : new Error(String(cause)),
            loading: false,
          });
        }
      });

    // Cancels the state update, not the request: a response that lands after the
    // component has moved on must not write into it.
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { ...state, reload };
}
