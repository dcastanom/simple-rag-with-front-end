// =============================================================================
// api/authApi.ts
//
// Thin, feature-specific wrapper around the generic `apiClient` from
// client.ts. Each function here maps to exactly one backend auth endpoint.
// This is the layer AuthContext.tsx calls into — AuthContext handles
// *state* (who's logged in, React re-renders), this file just handles
// *making the actual HTTP calls*.
// =============================================================================

import { apiClient } from './client';
import type { AuthResponse, AuthUser } from '../types';

// POST /auth/register — creates a new account. On success the backend
// also logs the user in, returning an access token + user object (see
// AuthResponse in types.ts) just like login() does.
export function register(email: string, password: string): Promise<AuthResponse> {
  return apiClient.postJson<AuthResponse>('/auth/register', { email, password });
}

// POST /auth/login — verifies credentials and starts a session. The
// backend also sets an httpOnly refresh cookie as a side effect of this
// call (not visible here in JS — that's the whole point of httpOnly).
export function login(email: string, password: string): Promise<AuthResponse> {
  return apiClient.postJson<AuthResponse>('/auth/login', { email, password });
}

// POST /auth/logout — tells the backend to invalidate the refresh cookie
// server-side. Returns nothing on success.
export function logout(): Promise<void> {
  return apiClient.postJson<void>('/auth/logout', {});
}

// GET /auth/me — returns the currently logged-in user based on whatever
// access token / refresh cookie is present. Used by AuthContext on app
// load to check "is there already a valid session?" without requiring
// the user to log in again after a page refresh.
export function getCurrentUser(): Promise<AuthUser> {
  return apiClient.getJson<AuthUser>('/auth/me');
}
