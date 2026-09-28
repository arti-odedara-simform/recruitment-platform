import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { login as loginRequest, me, setToken, setUnauthorizedHandler } from '../api/client.js';
import type { Schemas } from '../api/client.js';

/**
 * Who is signed in, and the token that proves it.
 *
 * The token lives in `sessionStorage`, which is a deliberate and limited choice: it
 * survives a page reload (a 15-minute token that dies on F5 is unusable) and disappears
 * when the tab does. It is readable by any script on this origin, so it is not where a
 * production app would keep one — that would be an httpOnly cookie, which needs the API
 * to set it and a CSRF story to go with it. Recorded here rather than left implicit.
 */

const STORAGE_KEY = 'recruitment.token';

interface Session {
  user: Schemas['PublicUser'] | null;
  ready: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => void;
}

const SessionContext = createContext<Session | null>(null);

function readStoredToken(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    // Private mode, or storage disabled. An in-memory session still works.
    return null;
  }
}

function writeStoredToken(token: string | null): void {
  try {
    if (token === null) window.sessionStorage.removeItem(STORAGE_KEY);
    else window.sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    /* ignore — see readStoredToken */
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  // Read once, during the first render, rather than in an effect: with no stored token
  // there is nothing to verify and the app is ready immediately, so deriving that here
  // avoids a render whose only job is to say "still deciding".
  const [storedToken] = useState(readStoredToken);
  const [user, setUser] = useState<Schemas['PublicUser'] | null>(null);
  const [ready, setReady] = useState(storedToken === null);

  const signOut = useCallback(() => {
    setToken(null);
    writeStoredToken(null);
    setUser(null);
  }, []);

  /**
   * A stored token is not trusted on sight — it may be expired, or issued to an account
   * that no longer exists. `GET /auth/me` reads the current row, so it is the only thing
   * that can answer "is this still valid", and a 401 from it clears the session.
   */
  useEffect(() => {
    if (storedToken === null) {
      return;
    }

    setToken(storedToken);
    me()
      .then(setUser)
      .catch(signOut)
      .finally(() => setReady(true));
  }, [storedToken, signOut]);

  // A 401 from any later request means the token expired mid-session. Routine, not an error.
  useEffect(() => {
    setUnauthorizedHandler(signOut);
    return () => setUnauthorizedHandler(null);
  }, [signOut]);

  const signIn = useCallback(async (email: string, password: string) => {
    const response = await loginRequest(email, password);
    setToken(response.token);
    writeStoredToken(response.token);
    setUser(response.user);
  }, []);

  const value = useMemo<Session>(
    () => ({ user, ready, signIn, signOut }),
    [user, ready, signIn, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (session === null) {
    throw new Error('useSession must be used inside a SessionProvider');
  }
  return session;
}
