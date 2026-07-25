# Using rag-pdf-gemini-node

A minimal RAG (Retrieval-Augmented Generation) app: upload PDFs, they get
chunked and embedded (Gemini) into Postgres/pgvector, then you can ask
questions and get answers grounded in the ingested content (Groq/Llama).

This project is build based on the https://www.freecodecamp.org/news/how-to-build-rag-chatbot-nodejs-gemini-pgvector/ article. Some improvement proposals made by the article's author and me were made in order to make it adaptable and suitable for production workload. These improvements are listed and explained in the file PRODUCTION-APP_LEVEL-FIXES.md. I also included a react frontend layer with authentication using JWT token.

There are two ways to use it:
- **The backend API directly** (`curl`, Postman, etc.) — sections 2–5 below.
- **The web UI** — a React/TypeScript SPA with upload status messages, a
  document list, a question box, and a running history of past Q&A —
  section 6 below.

Interactive API docs (Swagger UI, generated from JSDoc comments on the
routes in `backend/src/index.js` / `backend/src/auth/routes.js`) are served
at `/docs` while the backend is running — e.g. `http://localhost:3000/docs`.
The raw OpenAPI spec is at `/docs.json`. There's no auth on `/docs` itself;
it's a read-only description of the API shape, not a way to call it without
a token.

The repo is split into `backend/` (this API) and `frontend/` (the React SPA)
— each is a self-contained, independently runnable app with its own
`package.json`.

## 1. Prerequisites

- Docker container `backend-postgres-1` running (pgvector-enabled Postgres).
  Start it from `backend/` (docker compose reads `.env` from its own directory):
  ```
  cd backend
  docker compose up -d
  ```
- `backend/.env` filled in with `GEMINI_API_KEY`, `GROQ_API_KEY`,
  `DATABASE_URL`, and `JWT_SECRET` (see `backend/.env` in this repo).
- Backend dev server running (from `backend/`):
  ```
  cd backend
  npm run dev
  ```
  You should see `Database ready` and `RAG chatbot running on port 3000`.
  CORS is restricted to `FRONTEND_ORIGIN` (comma-separated if you need more
  than one, defaults to `http://localhost:5173` if unset) with
  `credentials: true` — required because the refresh token travels as a
  cookie, which means (unlike the previous API-key setup) an explicit origin
  is mandatory even in dev, not just production.

Other env vars, all optional with sane defaults: `MAX_UPLOAD_MB` (20),
`CHAT_RATE_LIMIT` / `INGEST_RATE_LIMIT` (requests per minute per user; 30 /
5), `AUTH_RATE_LIMIT` (requests per 15min per IP on `/auth/register` and
`/auth/login`; 10), `PG_POOL_MAX` (10 — remember this multiplies by however
many instances of the app are running, and must stay under Postgres'
`max_connections`), `INGEST_CONCURRENCY` (5 — how many chunks are embedded in
parallel per ingest job), `LLM_TIMEOUT_MS` (15000), `JWT_ACCESS_EXPIRES_IN`
(15m), `REFRESH_TOKEN_EXPIRES_DAYS` (30).

## 2. Accounts

Every document is private to the account that ingested it — there's no
shared corpus. Auth is JWT access token (short-lived, sent as
`Authorization: Bearer <token>`) + a rotating refresh token in an httpOnly
cookie (long-lived, scoped to `/auth`, never touched by JS).

```
curl.exe -c cookies.txt -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"you@example.com\", \"password\": \"at-least-8-chars\"}"
```
Returns `{ "accessToken": "...", "user": { "id": "...", "email": "..." } }`
and sets the refresh cookie (registering also logs you in — no separate
login step needed right after signup). `POST /auth/login` with the same body
shape works the same way for an existing account.

Use the access token on every subsequent request:
```
curl.exe -X POST http://localhost:3000/ingest -H "Authorization: Bearer <accessToken>" -F "file=@your-document.pdf"
```

Access tokens expire after `JWT_ACCESS_EXPIRES_IN` (15 min by default). Get a
new one with the refresh cookie (`-b`/`-c` keep curl's cookie jar in sync):
```
curl.exe -b cookies.txt -c cookies.txt -X POST http://localhost:3000/auth/refresh
```
This also **rotates** the refresh token — the old one stops working the
moment a new one is issued, so keep using the same cookie jar rather than a
stale copy. `POST /auth/logout` revokes the current refresh token and clears
the cookie. `GET /auth/me` (requires the access token) returns the current
user — useful for checking whether a session is still valid.

## 3. Ingesting a PDF

Endpoint: `POST /ingest`, `multipart/form-data`, field name **must be `file`**
(the server does `upload.single('file')` — a different field name will make
`req.file` come back empty). Only PDFs are accepted (checked via mimetype).
Requires the `Authorization: Bearer <accessToken>` header.

```
curl.exe -X POST http://localhost:3000/ingest -H "Authorization: Bearer <accessToken>" -F "file=@your-document.pdf"
```

Ingestion runs as a background job — the endpoint returns immediately with a
`jobId` rather than waiting for the whole PDF to finish embedding:

```json
{ "jobId": "...", "message": "Ingestion started for \"your-document.pdf\"", "statusUrl": "/ingest/<jobId>" }
```

Poll `GET /ingest/:jobId` (same header, and only the user who started the
job can see its status — anyone else gets `404`) to check progress:

```
curl.exe http://localhost:3000/ingest/<jobId> -H "Authorization: Bearer <accessToken>"
```

```json
{ "id": "...", "filename": "your-document.pdf", "status": "done", "chunk_count": 42, "error": null, "created_at": "...", "updated_at": "..." }
```

`status` is one of `pending`, `processing`, `done`, `failed`. On `failed`,
`error` has the reason and any partially-inserted chunks for that job have
already been cleaned up — a failed ingest never leaves half a document
searchable.

### About the file path

`curl -F "file=@path"` reads the file straight off **your local disk** and
streams it to the server over HTTP — the server never sees or cares about the
path itself, only the bytes and the filename. So:

- The file does **not** need to live inside the project folder.
- `@your-document.pdf` is resolved relative to the directory you run the
  `curl.exe` command from (your terminal's current working directory).
- Simplest fix: `cd` to the folder containing your PDF before running the
  command, or just give curl a full path, e.g.:
  ```
  curl.exe -X POST http://localhost:3000/ingest -H "Authorization: Bearer <accessToken>" -F "file=@C:\Users\dcast\Documents\my-file.pdf"
  ```

### What happens on ingest (`backend/src/ingest.js`)

1. PDF text is extracted (`pdf-parse`).
2. Text is split into ~500-character chunks with 50-character overlap
   (chunks under 50 chars are dropped).
3. Chunks are embedded via Gemini (`gemini-embedding-001`, 3072 dims,
   stored as `halfvec` so they stay indexable — see below) with up to
   `INGEST_CONCURRENCY` running in parallel, and inserted into the
   `documents` table (`content`, `source` = original filename, `embedding`,
   `job_id`).
4. The job's row in `ingest_jobs` is updated to `done` (with `chunk_count`)
   or `failed` (with `error`, after deleting any rows it managed to insert).

## 4. Asking questions

Endpoint: `POST /chat`, JSON body. Requires the `Authorization: Bearer
<accessToken>` header. The response is **streamed** as Server-Sent Events
rather than one JSON body, so the answer can render token-by-token instead
of the client waiting for the whole thing:

```
curl.exe -N -X POST http://localhost:3000/chat -H "Content-Type: application/json" -H "Authorization: Bearer <accessToken>" -d "{\"question\": \"What is this document about?\"}"
```
(`-N` disables curl's output buffering so you actually see frames arrive
as they're written, instead of all at once at the end.)

This embeds your question, finds the 5 most similar chunks **among your own
ingested documents** in Postgres (cosine distance via pgvector's `<=>`
operator, scoped to `user_id`), and asks Groq's `llama-3.1-8b-instant` to
answer using only that retrieved context — streaming each token back as
it's generated.

The stream is a sequence of `event: <name>\ndata: <json>\n\n` frames:
- `event: token`, repeated — `data` is a JSON-encoded string, one fragment
  of the answer. Concatenate them in order to get the full answer.
- `event: done`, once, at the end — `data` is
  `{ "sources": [...], "topSimilarity": "0.842" }`.
  - `sources` — de-duplicated list of filenames the answer drew from.
  - `topSimilarity` — similarity score (0–1) of the single closest chunk;
    low values (well under ~0.5) usually mean nothing relevant was
    ingested yet.
- `event: error`, instead of `done`, if generation fails after streaming
  had already started — `data` is a JSON-encoded error string.

If no documents match, the stream sends a single `token` frame with "No
relevant documents found." and a `done` frame with empty `sources`.

Optionally scope the question to one document instead of searching all of
them, by passing `docId` (the id from `GET /documents`, below):
```
curl.exe -N -X POST http://localhost:3000/chat -H "Content-Type: application/json" -H "Authorization: Bearer <accessToken>" -d "{\"question\": \"...\", \"docId\": \"<jobId>\"}"
```

Validation errors (missing `question`, malformed `docId`) are returned as
a normal JSON `400` response, *before* the stream starts — only failures
that happen mid-generation become an `error` frame instead.

## 5. Managing ingested documents

- `GET /documents` — lists your successfully ingested documents, most
  recent first:
  ```
  curl.exe http://localhost:3000/documents -H "Authorization: Bearer <accessToken>"
  ```
  ```json
  [{ "id": "<jobId>", "filename": "your-document.pdf", "chunk_count": 42, "created_at": "..." }]
  ```
  `id` here is the same job id from ingestion (`GET /ingest/:jobId`) — use
  it as `docId` on `/chat` to scope questions to that one document.

- `DELETE /documents/:jobId` — removes that document's chunks and its job
  record. Returns `204` on success, `404` if the id doesn't exist or
  belongs to another user:
  ```
  curl.exe -X DELETE http://localhost:3000/documents/<jobId> -H "Authorization: Bearer <accessToken>"
  ```

## 6. Using the web UI (`frontend/`)

A React + TypeScript SPA (Vite, Tailwind) that wraps the auth + document
endpoints above in a single chatbot-style page, gated behind login. Layout:

- `frontend/src/api` — fetch calls to the backend (no React).
- `frontend/src/context/AuthContext.tsx` — session state: current user, the
  in-memory access token, login/register/logout.
- `frontend/src/hooks` — state/business logic (`useDocumentUpload`,
  `useDocuments`, `useChat`, `useHistory`).
- `frontend/src/components` — presentation only (`auth/` has the login and
  register forms, `documents/` has the ingested-documents panel).
- `frontend/src/pages/ChatbotPage.tsx` — the main page once logged in, wires
  everything together.

### Run it

With the backend already running (section 1):
```
cd frontend
npm install
npm run dev
```
(Both `backend/` and `frontend/` have their own `package.json`/`node_modules`
— run `npm install` in each independently, not from the repo root.)
Open the printed URL (defaults to `http://localhost:5173`, or the next free
port if that one's taken). By default the UI talks to
`http://localhost:3000`; to point it elsewhere, copy
`frontend/.env.example` to `frontend/.env` and set `VITE_API_URL`.

The access token lives in memory only — refreshing the page re-derives a new
one from the httpOnly refresh cookie automatically (you stay logged in), but
it means the token is never in `localStorage`/`sessionStorage` for a stray
XSS to grab.

### What it does

- **Log in or register** — shown first if there's no valid session. Registering
  logs you in immediately, no separate step.
- **Upload a PDF** — pick a file and click "Ingest document". The button
  shows "Uploading…" until the background ingest job finishes (the UI polls
  `GET /ingest/:jobId` every 1.5s), then a banner shows the final result
  (`Ingested N chunks from "..."`) or its error, auto-dismissing after a few
  seconds or dismissible manually.
- **Your documents** — a panel lists everything you've ingested (filename,
  chunk count, when) with a delete (✕) button per document; it refreshes
  automatically once an upload finishes.
- **Ask a question** — type into the textarea and click "Ask" (or it's
  disabled while empty/loading). A dropdown next to the question box lets
  you scope the question to one document instead of searching all of them
  ("All documents" by default). The answer streams in token-by-token as
  Groq generates it rather than appearing all at once; its sources and the
  top similarity score appear once it finishes.
- **History** — every question/answer pair is added to a running list below,
  with the answer cut down to 200 characters and a "Show more" toggle to see
  the full text. History is kept in the browser's `sessionStorage`: it
  survives page reloads but clears once the browser (or tab session) is
  closed. A "Clear" control wipes it manually.

Note: generic questions like "what is this document about?" will often
retrieve the same top chunk/source with a similar similarity score each
time — that's expected retrieval behavior, not a bug; more specific,
content-targeted questions will surface different sources.

## 7. Quick end-to-end check

```
cd backend
docker compose up -d
npm run dev
# in another terminal:
curl.exe -c cookies.txt -X POST http://localhost:3000/auth/register -H "Content-Type: application/json" -d "{\"email\": \"you@example.com\", \"password\": \"at-least-8-chars\"}"
# copy the returned accessToken, then from the folder holding the PDF:
curl.exe -X POST http://localhost:3000/ingest -H "Authorization: Bearer <accessToken>" -F "file=@sample.pdf"
# note the returned jobId, then poll until status is "done":
curl.exe http://localhost:3000/ingest/<jobId> -H "Authorization: Bearer <accessToken>"
# -N so you see tokens arrive as they stream instead of all at once:
curl.exe -N -X POST http://localhost:3000/chat -H "Content-Type: application/json" -H "Authorization: Bearer <accessToken>" -d "{\"question\": \"Summarize this document\"}"

# or, instead of curl, use the web UI:
cd frontend && npm install && npm run dev
```
