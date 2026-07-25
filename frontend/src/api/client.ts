// =============================================================================
// api/client.ts
//
// This is the low-level "HTTP layer" the whole frontend uses to talk to the
// backend. Nothing here knows about specific features (auth, PDFs, etc.) —
// it just knows how to make a request, attach the access token, and retry
// once if that token has expired. Feature-specific files like authApi.ts
// build on top of the `apiClient` exported at the bottom of this file.
// =============================================================================

import type { ApiErrorPayload } from '../types';

// Where the backend lives. In development this falls back to localhost;
// in production it's set via the VITE_API_URL environment variable.
const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

// Access token lives in memory only (never localStorage) — the refresh
// token that actually recovers a session lives in an httpOnly cookie the
// JS here never touches.
let accessToken: string | null = null;
// Optional callback the rest of the app (AuthContext) can register, so this
// file can say "hey, the session just died" without importing React state.
let onUnauthorized: (() => void) | null = null;
// Tracks an in-flight token refresh so simultaneous requests don't each
// trigger their own refresh call (see refreshAccessToken below).
let refreshPromise: Promise<boolean> | null = null;

// Called by AuthContext after login/register/refresh to store the current
// access token here, so every subsequent request can use it.
export function setAccessToken(token: string | null) {
  accessToken = token;
}

// Called by AuthContext to register what should happen when a request
// definitively fails auth (token expired AND refresh failed too).
export function setUnauthorizedHandler(handler: (() => void) | null) {
  onUnauthorized = handler;
}

// A custom Error subclass so callers can check `err.status` /
// `err.detail` instead of just getting a generic message string.
export class ApiError extends Error {
  status: number;
  detail?: string;

  constructor(message: string, status: number, detail?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

// The actual fetch() wrapper. Every request goes through here.
async function doFetch(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`${BASE_URL}${path}`, {
      ...init,
      // Sends cookies (like the httpOnly refresh cookie) along with the
      // request, even though this is a cross-origin call to the backend.
      credentials: 'include',
      headers: {
        ...(init.headers ?? {}),
        // Attach "Authorization: Bearer <token>" only if we have one.
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
    });
  } catch {
    // fetch() only throws on network-level failures (server unreachable,
    // no internet, etc.) — not on HTTP error statuses like 404 or 500.
    throw new ApiError('Could not reach the server. Is the backend running?', 0);
  }
}

// Turns a raw fetch Response into either parsed JSON data or a thrown
// ApiError, depending on the HTTP status code.
async function parseBody<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // non-JSON response body, leave data as null
    }
  }

  if (!res.ok) {
    const payload = (data ?? {}) as Partial<ApiErrorPayload>;
    throw new ApiError(
      payload.error ?? `Request failed with status ${res.status}`,
      res.status,
      payload.detail
    );
  }

  return data as T;
}

// Several requests can 401 around the same moment (access token just
// expired) — only one of them should actually hit /auth/refresh.
function refreshAccessToken(): Promise<boolean> {
  // If a refresh is already in progress, every caller just waits on that
  // same promise instead of firing off a second /auth/refresh request.
  if (!refreshPromise) {
    refreshPromise = fetch(`${BASE_URL}/auth/refresh`, {
      method: 'POST',
      credentials: 'include', // sends the httpOnly refresh cookie
    })
      .then(async res => {
        if (!res.ok) return false; // refresh cookie missing/expired
        const data = (await res.json()) as { accessToken: string };
        accessToken = data.accessToken; // got a fresh access token
        return true;
      })
      .catch(() => false)
      .finally(() => {
        // Clear the shared promise so the *next* 401 (later on) starts a
        // brand new refresh instead of reusing this finished one.
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

// These auth endpoints must never trigger a refresh-and-retry: a 401 from
// them is a real answer (bad credentials, no session, refresh itself
// failed), not a signal that the access token merely expired.
const NO_REFRESH_RETRY = new Set(['/auth/login', '/auth/register', '/auth/refresh', '/auth/logout']);

// Does the fetch + the 401-refresh-and-retry dance, but returns the raw
// Response instead of parsing it — shared by both the JSON path (request,
// below) and the streaming path (postJsonStream) since only the JSON path
// wants the body parsed up front; a stream needs its body left untouched.
// `isRetry` prevents infinite loops — we only ever attempt one
// refresh-and-retry per original request.
async function requestRaw(path: string, init: RequestInit, isRetry = false): Promise<Response> {
  const res = await doFetch(path, init);

  if (res.status === 401 && !isRetry && !NO_REFRESH_RETRY.has(path)) {
    // Access token probably expired — try to silently get a new one using
    // the refresh cookie, then replay the original request exactly once.
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      return requestRaw(path, init, true);
    }
    // Refresh failed too, meaning there's truly no valid session anymore.
    accessToken = null;
    onUnauthorized?.(); // tells AuthContext to flip the app into "logged out"
  }

  return res;
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const res = await requestRaw(path, init);
  return parseBody<T>(res);
}

// The public API other files (like authApi.ts) actually call. Each method
// corresponds to one way of sending a request body.
export const apiClient = {
  getJson<T>(path: string): Promise<T> {
    return request<T>(path, { method: 'GET' });
  },

  deleteJson<T>(path: string): Promise<T> {
    return request<T>(path, { method: 'DELETE' });
  },

  postJson<T>(path: string, body: unknown): Promise<T> {
    return request<T>(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  },

  // Used for endpoints that need file uploads (multipart/form-data),
  // e.g. uploading a PDF — FormData sets its own Content-Type header
  // automatically, including the multipart boundary.
  postForm<T>(path: string, form: FormData): Promise<T> {
    return request<T>(path, {
      method: 'POST',
      body: form,
    });
  },

  // For endpoints that respond with a stream (e.g. Server-Sent Events)
  // instead of one JSON body. Same auth/refresh handling as everything
  // else here, but on success the caller gets the raw Response back to
  // read `res.body` from — parsing the stream's contents is the calling
  // feature module's job (client.ts only owns transport + error shape).
  async postJsonStream(path: string, body: unknown): Promise<Response> {
    const res = await requestRaw(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) await parseBody(res); // throws ApiError, never returns
    return res;
  },
};
