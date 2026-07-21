# Multi-User Auth Implementation Plan

Replaces the shared `API_KEY` from the previous pass with real per-user
accounts: email/password signup+login, JWT access tokens, rotating refresh
tokens in an httpOnly cookie, and per-user document isolation.

Decisions locked in (asked up front, not assumptions):
- **Documents are private per-user** — `/chat` and `/ingest` are scoped to
  the requesting user; nobody can query another user's ingested PDFs.
- **Access token in memory + refresh token in an httpOnly cookie** — the SPA
  never touches the refresh token in JS; better XSS resistance than a JWT in
  `localStorage`, at the cost of a refresh-on-401 interceptor and
  `credentials: true` CORS.
- **Open self-signup** — anyone can register. Compensating control: a tight
  rate limit on `/auth/register` and `/auth/login` (this is also the main
  abuse vector for the LLM-cost concern from the earlier pass — a bot could
  otherwise mint accounts to route around per-account rate limits).

Explicitly out of scope for this pass (flagging, not silently skipping):
- **Email verification** — would need SES/email infra. Self-signup without
  it means an unverified email can register; mitigated by auth-endpoint rate
  limiting, not eliminated. Worth adding later if abuse shows up.
- **Password reset** — same reason (needs email sending). A user who forgets
  their password has no self-service recovery yet.
- **A real migration tool** — this project has no migration framework
  (`db.js` just runs `CREATE TABLE IF NOT EXISTS`). New `NOT NULL` columns on
  `documents`/`ingest_jobs` assume a dev DB with no real user data yet, same
  as the `halfvec` change last pass. A production cutover with existing rows
  would need a real migration, not in scope here.

---

## 1. Schema: `users`, `refresh_tokens`, ownership columns

**Fix**:
```sql
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,     -- sha256 of the raw token, not the raw token
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refresh_tokens_token_hash_idx ON refresh_tokens (token_hash);
```
`documents.user_id UUID NOT NULL REFERENCES users(id)` and
`ingest_jobs.user_id UUID NOT NULL REFERENCES users(id)` — added to the
existing `CREATE TABLE` statements.

**Files**: `src/db.js`

**Done when**: fresh `initDb()` run creates all four tables/columns with no
errors.

---

## 2. Password hashing

**Fix**: `bcryptjs` (pure JS — the native `bcrypt` package needs node-gyp,
which is friction we don't need on this stack). Cost factor 10. A thin
`src/auth/passwords.js` with `hashPassword` / `verifyPassword`.

**Files**: new `src/auth/passwords.js`, `package.json` (new dep)

**Done when**: a wrong password fails verification, a correct one passes,
hashes are never logged.

---

## 3. Token issuance (access JWT + rotating refresh token)

**Fix**:
- Access token: `jsonwebtoken`, HS256, secret from `JWT_SECRET` env,
  payload `{ sub: userId }`, `expiresIn: '15m'`. Symmetric signing is fine —
  one API process validates its own tokens, no need for RS256/JWKS.
- Refresh token: **not** a JWT — a random opaque value
  (`crypto.randomBytes(32).toString('hex')`), stored as its sha256 hash in
  `refresh_tokens` (fast, deterministic hash is correct here — unlike
  passwords, refresh tokens are already high-entropy, so no need for
  bcrypt's slow hashing, and we need exact-match lookup). Sent to the client
  only via an httpOnly cookie.
- Rotation: every `/auth/refresh` call revokes the presented token and
  issues a new one. Reusing an already-revoked token is a signal of theft;
  simplest realistic response is to revoke it and fail — no need for a full
  breach-detection/alerting system at this scale.

**Files**: new `src/auth/tokens.js`

**Done when**: a minted access token verifies and decodes the right user id;
a refresh token round-trips through hash/lookup; using a revoked refresh
token fails.

---

## 4. Auth endpoints

**Fix**: `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`,
`POST /auth/logout`, `GET /auth/me`.

- `register`: validate email format + password length (min 8 chars — not
  building a full strength meter), 409 on duplicate email, hash password,
  create user, issue tokens (auto-login after signup).
- `login`: verify credentials, issue tokens. Same generic error for
  "no such user" and "wrong password" (don't leak which one).
- `refresh`: read refresh cookie, validate + rotate, return new access token.
- `logout`: revoke the refresh token, clear the cookie.
- `me`: returns `{ id, email }` for the current access token — lets the
  frontend confirm session state without guessing.
- All issue/clear the refresh cookie as `httpOnly, sameSite: 'lax', secure:
  <true in prod>`.
- A dedicated `authLimiter` (tighter than the existing chat/ingest limiters,
  e.g. 10/15min per IP) on `register` and `login` — this is the actual
  abuse control given open self-signup.

**Files**: new `src/auth/routes.js` (or inline in `index.js` — small enough
either way, will decide during implementation based on how `index.js` reads),
`src/index.js`

**Done when**: register → login → refresh → logout all work via curl;
wrong password / duplicate email return correct 4xx codes; hitting
`register` past the rate limit returns 429.

---

## 5. `requireAuth` middleware, replacing `apiKeyAuth`

**Fix**: Reads `Authorization: Bearer <token>`, verifies the JWT, attaches
`req.user = { id }`. Replaces `apiKeyAuth` on `/ingest`, `/chat`,
`/ingest/:jobId`. `src/auth.js` (the old shared-key middleware) and the
`API_KEY` env var are removed — fully superseded.

**Files**: `src/auth/middleware.js` (replaces `src/auth.js`), `src/index.js`

**Done when**: those three routes 401 with no/garbage/expired token and
succeed with a valid one.

---

## 6. Per-user data isolation

**Fix**:
- `createIngestJob(filename, userId)`, `processIngestJob` tags every
  inserted `documents` row with `user_id`, `getIngestJob(jobId, userId)`
  scoped so polling someone else's job id 404s instead of leaking status.
- `queryDocuments(question, userId)` adds `WHERE user_id = $2` to the
  similarity search — a user can only ever retrieve their own chunks.
- Rate limiting: now keyed on `req.user.id` (auth already ran) instead of
  API key/IP for `/chat` and `/ingest`.

**Files**: `src/ingest.js`, `src/query.js`, `src/index.js`

**Done when**: two different users each ingest a document; user B's
`/chat` never returns user A's content, and `GET /ingest/:jobId` for user
A's job returns 404 for user B.

---

## 7. CORS + cookies wiring

**Fix**: `cookie-parser` middleware to read the refresh cookie;
`cors({ origin: FRONTEND_ORIGIN, credentials: true })` — cookies across
origins require an explicit origin (already the case) plus
`credentials: true` on both server and frontend `fetch` calls.

**Files**: `src/index.js`, `package.json` (new dep)

**Done when**: a browser-origin request from the configured frontend origin
successfully sends/receives the refresh cookie; a disallowed origin still
can't.

---

## 8. Frontend: auth state, login/register UI, gating the app

**Fix**:
- `AuthContext`/`useAuth`: holds the access token + current user **in
  memory only** (a page refresh loses it — recovered via a silent
  `POST /auth/refresh` on app mount using the httpOnly cookie). Exposes
  `login`, `register`, `logout`.
- `client.ts`: `credentials: 'include'` on every request; inject
  `Authorization: Bearer <token>` from the in-memory token instead of the
  old `VITE_API_KEY` header; on a `401`, attempt one silent refresh and
  retry the original request once before giving up (handles access-token
  expiry transparently mid-session).
- New `LoginForm` / `RegisterForm` components (plain email/password,
  consistent with the existing Tailwind styling — no new UI library).
  Top-level app renders these when logged out, `ChatbotPage` when logged in.
- Remove `VITE_API_KEY` from `client.ts`, `vite-env.d.ts`, `.env.example` —
  fully replaced by the auth flow.

**Files**: new `frontend/src/context/AuthContext.tsx`,
`frontend/src/components/auth/LoginForm.tsx`,
`frontend/src/components/auth/RegisterForm.tsx`;
edits to `frontend/src/api/client.ts`, `frontend/src/main.tsx` (or wherever
the app root lives), `frontend/.env.example`, `frontend/src/vite-env.d.ts`

**Done when**: registering, logging in, refreshing the page (session
persists via silent refresh), ingesting/chatting as that user, and logging
out (further requests 401) all work through the actual UI in a browser.

---

## Suggested implementation order

1. #1 schema, #2 password hashing, #3 token issuance — backend primitives,
   no HTTP surface yet
2. #4 auth endpoints, #5 `requireAuth` middleware — auth is now usable via
   curl
3. #6 per-user data isolation — the actual multi-tenant guarantee
4. #7 CORS/cookies — needed before the browser can use any of this
5. #8 frontend — wire the UI to the now-complete backend

Each step gets tested live against the real Postgres container before
moving on, same as the previous pass.
