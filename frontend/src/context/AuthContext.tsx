// =============================================================================
// AuthContext.tsx
//
// This file defines the app's authentication system using React Context.
//
// React Context is a way to share data (like "is the user logged in?") with
// any component in the app, without having to manually pass that data down
// through props at every level ("prop drilling").
//
// This file has two main exports:
//   1. <AuthProvider> — a component you wrap around your app once. It holds
//      the actual auth state (who's logged in, loading status, etc.) and
//      provides login/register/logout functions.
//   2. useAuth() — a hook that any component can call to read the current
//      auth state or call login/register/logout.
// =============================================================================

import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import { setAccessToken, setUnauthorizedHandler } from '../api/client';
import * as authApi from '../api/authApi';
import type { AuthUser } from '../types';

// The three possible states of authentication for the whole app.
// - 'loading'        -> we're still checking if the user has a valid session
// - 'authenticated'   -> we know who the user is
// - 'unauthenticated' -> no valid session, show login/register screens
type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

// This describes the "shape" of everything that will be shared through
// the context: the current status, the user object (or null), and the
// three functions any component can call to change auth state.
interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

// Creates the actual Context object. Its default value is `null` because
// there is no real auth data yet — components must access it through the
// useAuth() hook below, which enforces that AuthProvider is present.
const AuthContext = createContext<AuthContextValue | null>(null);

// -----------------------------------------------------------------------
// AuthProvider
// -----------------------------------------------------------------------
// Wrap this around your app (usually near the root, e.g. in App.tsx or
// main.tsx) so every child component can read auth state via useAuth().
// `children` is whatever JSX is nested inside <AuthProvider>...</AuthProvider>.
export function AuthProvider({ children }: { children: ReactNode }) {
  // React state: whenever setStatus/setUser is called, this component
  // (and everything using useAuth()) re-renders with the new values.
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);

  // Resets everything back to "logged out". useCallback keeps this same
  // function reference across re-renders (instead of creating a brand new
  // function every render), which matters because it's used as a
  // dependency in the useEffect below and passed to setUnauthorizedHandler.
  const clearSession = useCallback(() => {
    setAccessToken(null); // forget the in-memory access token
    setUser(null);        // forget who was logged in
    setStatus('unauthenticated');
  }, []);

  // useEffect with an empty-ish dependency array runs once when
  // <AuthProvider> first mounts (i.e. when the app first loads).
  useEffect(() => {
    // Registers clearSession as the callback the API client should run
    // whenever a request comes back 401 Unauthorized (e.g. session expired
    // while using the app). See api/client.ts for where this gets called.
    setUnauthorizedHandler(clearSession);

    // Recovers a session on page load using only the httpOnly refresh
    // cookie — the access token itself never survives a reload, since it's
    // held in memory only. A missing/expired cookie just lands here as a
    // 401, which is a normal "not logged in" outcome, not an error.
    authApi
      .getCurrentUser()
      .then(me => {
        setUser(me);
        setStatus('authenticated');
      })
      .catch(() => setStatus('unauthenticated'));

    // Cleanup function: runs if <AuthProvider> is ever removed from the
    // page, so we don't leave a stale handler pointing at this component.
    return () => setUnauthorizedHandler(null);
  }, [clearSession]);

  // Calls the backend's /auth/login endpoint, then stores the returned
  // access token (in memory, via setAccessToken) and marks the user as
  // authenticated so the rest of the app updates immediately.
  const login = useCallback(async (email: string, password: string) => {
    const res = await authApi.login(email, password);
    setAccessToken(res.accessToken);
    setUser(res.user);
    setStatus('authenticated');
  }, []);

  // Same idea as login, but hits /auth/register to create a new account
  // first. The backend logs the new user in immediately on success.
  const register = useCallback(async (email: string, password: string) => {
    const res = await authApi.register(email, password);
    setAccessToken(res.accessToken);
    setUser(res.user);
    setStatus('authenticated');
  }, []);

  // Tells the backend to end the session, then always clears local state
  // — the `finally` makes sure the user is logged out on the client even
  // if the network request to the backend fails for some reason.
  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      clearSession();
    }
  }, [clearSession]);

  // Every component nested inside <AuthProvider> can now read `status`,
  // `user`, and call `login`/`register`/`logout` via the useAuth() hook.
  return (
    <AuthContext.Provider value={{ status, user, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

// -----------------------------------------------------------------------
// useAuth
// -----------------------------------------------------------------------
// A custom hook — the standard way components read auth state in this app.
// Instead of importing AuthContext + useContext everywhere, components
// just do: `const { user, login } = useAuth();`
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  // If ctx is null, that means this component was rendered somewhere
  // outside of <AuthProvider>, which is a programming mistake — this
  // throws early with a clear error instead of silently breaking later.
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
