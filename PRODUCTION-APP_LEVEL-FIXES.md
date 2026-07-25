# Production App-Level Fixes

Scope: code-only changes to make this app safe and stable to run in production
(target: ~10k users/day, ~1k concurrent). AWS infra (ECS, RDS, Secrets Manager,
SQS, etc.) is tracked separately — this file is just the application code.

Each item: problem, fix, files touched, and how we'll know it's done.

---

## 1. Vector index on `documents.embedding`

**Problem**: `src/db.js` creates the `documents` table with no index on
`embedding`. Every `/chat` call does a full sequential scan + sort over the
whole table.

**Fix**: Add an `ivfflat` (or `hnsw`, if the pgvector version supports it)
index with cosine ops in `initDb()`. Note pgvector's `ivfflat` needs rows
present to pick a good `lists` value, and both index types support cosine
distance — use `vector_cosine_ops` to match the `<=>` operator already in use.

**Files**: `src/db.js`

**Done when**: index exists (`\d documents` shows it), `/chat` queries still
return correct results.

---

## 2. API key auth on `/ingest` and `/chat`

**Problem**: Both endpoints are open to the internet with no auth. Each call
spends real Gemini/Groq API budget — this is a direct cost-abuse vector, not
just a security nicety.

**Fix**: Simple shared-secret API key middleware — require an
`x-api-key` header matching `API_KEY` from env, applied to both routes.
(Not building full user accounts/JWT — out of scope for this pass; can layer
proper auth on later if the product needs per-user identity.)

**Files**: `src/index.js` (new middleware), `.env` (new `API_KEY` var),
`USAGE.md` (document the header)

**Done when**: requests without a valid key get `401`; frontend sends the key.

---

## 3. Rate limiting

**Problem**: No limit on request volume — combined with #2, a leaked key or a
single bad actor can still hammer the LLM APIs.

**Fix**: `express-rate-limit`, applied per-key (or per-IP as fallback) on
`/ingest` and `/chat`, with separate (tighter) limits for `/ingest` since it's
more expensive per call.

**Files**: `src/index.js`, `package.json` (new dep)

**Done when**: exceeding the limit returns `429` with a clear message.

---

## 4. Async ingestion (stop blocking the HTTP request)

**Problem**: `ingestDocument` embeds chunks one at a time, sequentially,
inside the request/response cycle. A large PDF can take minutes — this will
exceed typical LB/proxy timeouts (e.g. ALB's default 60s) and ties up a
request the whole time.

**Fix**:
- Bound the concurrency of embedding calls (e.g. `p-limit` or a small
  hand-rolled worker pool, concurrency ~5) instead of one-at-a-time — cuts
  ingestion time significantly without hammering Gemini's rate limits.
- Change `/ingest` to return immediately with a `jobId` and process the PDF
  in the background; add `GET /ingest/:jobId` to poll status
  (`pending` / `done` / `failed`, chunk count when done).
- Job state can live in a new Postgres table (`ingest_jobs`) for this pass —
  no need for SQS/Redis at the code level; that's an infra-layer swap later
  if we move the worker out of-process.

**Files**: `src/ingest.js`, `src/index.js`, `src/db.js` (new table),
`USAGE.md`

**Done when**: `/ingest` responds in well under a second regardless of PDF
size; polling `/ingest/:jobId` reflects real progress/completion.

---

## 5. Retries + timeouts on external API calls

**Problem**: `embedText` and `generateAnswer` in `src/embeddings.js` have no
timeout and no retry. One transient network blip fails the whole chunk (and,
combined with #4's loop, can kill an in-progress ingestion partway through).

**Fix**: Wrap both fetch calls with a timeout (`AbortController`, ~15s) and a
small retry with exponential backoff (2–3 attempts) on network errors/5xx/429
from the provider. Don't retry on 4xx (bad request) — that won't succeed on
retry.

**Files**: `src/embeddings.js`

**Done when**: a simulated transient failure (e.g. temporarily wrong URL)
retries and either recovers or fails cleanly with a clear error.

---

## 6. Partial-ingestion handling

**Problem**: If ingestion fails midway (chunk 50 of 100), the document is
left half-ingested in the `documents` table with no indication anything's
wrong — `/chat` will silently retrieve from the incomplete set.

**Fix**: Tag rows inserted during a job with the `job_id` (new column). On
failure, delete rows for that `job_id` so a failed ingest leaves no partial
data. On success, nothing to clean up. Ties into the `ingest_jobs` table from
#4.

**Files**: `src/db.js`, `src/ingest.js`

**Done when**: forcing a mid-ingestion failure leaves zero rows for that
document, and the job status reflects `failed`.

---

## 7. Don't leak internal error details to clients

**Problem**: `src/index.js` returns `err.message` (and implicitly stack
context via logs) directly in API responses on 500s.

**Fix**: Log the full error server-side (`console.error` today, structured
logger from #11), return a generic message + an error code/id to the client.
No behavior change for 400-level validation errors (those messages are
already intentional and safe).

**Files**: `src/index.js`

**Done when**: a forced 500 (e.g. DB down) returns a generic JSON body with
no internal detail, full detail still visible in server logs.

---

## 8. Upload size limit

**Problem**: `multer({ storage: multer.memoryStorage() })` has no file size
limit — a large upload is held entirely in memory and can exhaust process
memory.

**Fix**: Add `limits: { fileSize: <cap> }` to the multer config (e.g. 20MB —
generous for a text PDF, adjust if real usage needs more) and return a clean
400 on `LIMIT_FILE_SIZE`.

**Files**: `src/index.js`

**Done when**: an oversized upload gets a `400` with a clear message instead
of an unbounded memory allocation.

---

## 9. Restrict CORS to the real frontend origin

**Problem**: `app.use(cors())` with no options allows every origin.

**Fix**: Configure `cors({ origin: process.env.FRONTEND_ORIGIN })`
(comma-separated list if multiple origins needed later), read from env so
dev/prod differ without a code change.

**Files**: `src/index.js`, `.env`

**Done when**: requests from an unlisted origin are rejected by CORS;
requests from the configured frontend origin still work.

---

## 10. Health check + graceful shutdown

**Problem**: No `/health` endpoint (needed for a load balancer/orchestrator
to know the instance is alive) and no `SIGTERM` handling (needed so in-flight
requests finish instead of being dropped when a task is stopped/redeployed).

**Fix**: Add `GET /health` (checks DB connectivity, returns 200/503). Add a
`SIGTERM` handler that stops accepting new connections
(`server.close()`), lets in-flight requests finish, then exits.

**Files**: `src/index.js`

**Done when**: `/health` reflects real DB state; sending `SIGTERM` to the
process lets an in-flight request complete before exit instead of killing it.

---

## 11. Structured logging

**Problem**: Plain `console.log`/`console.error` — works, but not queryable
(no levels, no request correlation) once this is running as a service.

**Fix**: Swap to `pino` (fast, minimal). Add a request-id per request
(generate or pass through `x-request-id`) so logs for one request can be
correlated. Keep output as JSON to stdout — that's all CloudWatch/any log
collector needs, no separate log-shipping code.

**Files**: `src/index.js`, `src/ingest.js`, `src/query.js`,
`src/embeddings.js`, `package.json` (new dep)

**Done when**: logs are structured JSON lines with level + request id where
applicable.

---

## 12. Postgres pool sizing

**Problem**: `new Pool({ connectionString: ... })` in `src/db.js` uses
pg's default `max: 10` with no thought given to how that multiplies across
however many app instances run in production.

**Fix**: Make pool size configurable via env (`PG_POOL_MAX`, sane default),
document in `USAGE.md` that total `PG_POOL_MAX × instance count` must stay
under the Postgres server's `max_connections`.

**Files**: `src/db.js`, `.env`, `USAGE.md`

**Done when**: pool max is env-driven with a documented default.

---

## 13. Not streaming responses

**Problem**: Right now `/chat` holds the connection open until Groq finishes
generating the full answer, then returns everything at once. On a short
question that's fine. On a longer one, the user stares at nothing for a few
seconds and wonders if the request hung.

**Fix**: Groq supports streaming — add `stream: true` to the request body
and tokens come back incrementally. Backend pipes them to the client as
Server-Sent Events (`event: token` per chunk, `event: done` with
sources/similarity once retrieval context is known to be exhausted,
`event: error` on mid-stream failure). Frontend reads the response body as
a stream and appends tokens to the answer as they arrive instead of waiting
for one JSON blob. This replaces the old single-shot `/chat` response
shape entirely (no parallel non-streaming endpoint kept around).

**Files**: `src/embeddings.js`, `src/query.js`, `src/index.js`,
`frontend/src/api/client.ts`, `frontend/src/api/chatApi.ts`,
`frontend/src/hooks/useChat.ts`, `frontend/src/components/chat/*`

**Done when**: asking a question shows the answer appearing token-by-token
in the UI rather than all at once; a forced failure mid-stream surfaces a
clean error instead of hanging.

---

## 14a. Doc-scoped chat filtering

**Problem**: Once a user has loaded more than one document, `/chat` queries bleed
across all of them: ask about the API spec and you'll get chunks from the
onboarding guide too.

**Fix**: No new column needed — every row in `documents` already carries
`job_id` (added for #6, indexed via `documents_job_id_idx`), and one
`job_id` already corresponds to exactly one ingested file per user. Add
`AND ($3::uuid IS NULL OR job_id = $3)` to the similarity query in
`queryDocuments`, and accept an optional `docId` body field on `/chat: {
"question": "...", "docId": "<job_id>" }`. Users get scoped results with no
migration.

**Files**: `src/query.js`, `src/index.js`, `frontend/src/api/chatApi.ts`,
`frontend/src/hooks/useChat.ts`, `frontend/src/components/chat/ChatComposer.tsx`

**Done when**: a `/chat` call with `docId` set only returns chunks from that
job; omitting `docId` behaves as before (searches all of the user's docs).
Frontend gets a small document selector in the chat composer (sourced from
the same list as #15's panel) so users can scope a question without
crafting the request by hand.

---

## 14b. Re-ranking (deferred, not scheduled)

**Problem**: Vector similarity retrieval is fast but approximate — it finds
chunks that are semantically close to the question, not necessarily the
ones that most directly answer it. This gets worse as a user's corpus grows.

**Fix (future, not part of this pass)**: retrieve the top 20 by cosine
distance, then run a cross-encoder over them to re-score by actual
relevance, then take the best 5 from that second pass. LangChain.js has a
cross-encoder wrapper if you don't want to implement it yourself.

**Why deferred**: adds a new dependency plus extra latency/cost per query,
and there's no evidence yet that any user's corpus is large enough for
retrieval precision to be the bottleneck. Revisit if/when it is.

---

## 15. Document management

**Problem**: No way to see what's ingested, delete a specific file, or clean
up after a bad upload — a real gap now that `/chat` can bleed across
documents (see #14a).

**Fix**: No new schema needed — `ingest_jobs` already has one row per
logical document (`filename`, `status`, `chunk_count`, `created_at`) and
every `documents` row already carries `job_id`. Add `GET /documents`
(lists the caller's completed jobs) and `DELETE /documents/:jobId` (deletes
that job's rows from `documents` then the `ingest_jobs` row itself, scoped
to `user_id` same as every other query here). Frontend gets a small panel
listing ingested files with a delete action, which also becomes the source
list for the doc-scoped chat selector from #14a.

**Files**: `src/ingest.js`, `src/index.js`,
`frontend/src/api/documentsApi.ts`, `frontend/src/hooks/useDocuments.ts`,
`frontend/src/components/documents/*`, `frontend/src/pages/ChatbotPage.tsx`

**Done when**: `GET /documents` lists ingested files for the caller only;
`DELETE /documents/:jobId` removes that document's chunks and the job
record, and returns 404 for another user's job id.

---

## 16. Add measurements to the logs

**Problem**: No visibility into what a `/chat` or `/ingest` call actually
costs — token usage, latency breakdown, memory footprint — which makes it
hard to reason about real per-request cost or capacity before this goes to
production traffic.

**Fix**: Log latency around each external call (`embedText`,
`generateAnswer`/stream) individually plus the total per `/chat` request;
log Groq's `usage` (prompt/completion/total tokens — requested via
`stream_options.include_usage` even in streaming mode) alongside it. Log
total duration + chunk count per ingest job (already partially there via
`chunkCount` logging from #4). Surface `process.memoryUsage()` on `/health`
so it's visible to whatever polls that endpoint, and log a memory snapshot
at the end of each ingest job to see how concurrency (`INGEST_CONCURRENCY`)
affects footprint on large PDFs. All additive — no behavior change.

**Files**: `src/embeddings.js`, `src/query.js`, `src/ingest.js`,
`src/index.js`

**Done when**: a `/chat` call's logs show embed/generate latency and token
usage; an ingest job's logs show total duration and a memory snapshot;
`/health` reports current memory usage.

## Suggested implementation order

Roughly cost-of-delay order — cheap/high-impact first:

[x] 1. #2 API key auth, #3 rate limiting — cost exposure, quick to add
[x] 2. #1 vector index — one migration, immediate correctness/perf fix
[x] 3. #7 error sanitization, #8 upload limit, #9 CORS — small, low-risk hardening
[x] 4. #10 health check + graceful shutdown, #12 pool sizing — needed for any
   real deployment target
[x] 5. #11 structured logging — useful scaffolding for debugging the rest
[x] 6. #5 retries/timeouts — before touching ingestion concurrency
[x] 7. #4 async ingestion, #6 partial-ingestion cleanup — biggest structural
   change, do last once everything else is stable
[x] 8. #16 measurements in logs — cheap, additive, gives a before/after
   baseline for the next three changes
[x] 9. #15 document management — closes a real functionality gap, reuses
   existing `ingest_jobs`/`job_id` schema, no migration
[x] 10. #14a doc-scoped chat filtering — fixes a live correctness bug
   (cross-document bleed for any user with 2+ docs), reuses `job_id`, no
   migration; #14b re-ranking is deliberately not scheduled (see above)
[x] 11. #13 streaming `/chat` responses — biggest structural change of this
   batch (backend protocol change + frontend consumption), done last once
   the rest is stable and #16's measurement plumbing is in place to
   instrument it

Notes from implementing 8–11:
- #13 fully replaced the old single-JSON-response `/chat` with SSE
  (`event: token` / `event: done` / `event: error`) — there's no
  non-streaming `/chat` left, and `generateAnswer` in `embeddings.js` was
  replaced by `generateAnswerStream`. `queryDocuments` in `query.js` became
  `streamQueryDocuments`, taking an `onToken` callback.
- Validation (missing `question`, invalid `docId`) still short-circuits as
  a plain JSON 400 before the SSE headers are sent — only failures that
  happen after streaming has started become `event: error` frames.
- All four items were verified against the real backend (real Postgres via
  the repo's `docker-compose.yml`, real Gemini/Groq calls) with curl plus a
  Node script that mirrors the frontend's exact SSE-parsing logic — no
  browser automation tool was available in this environment, so the actual
  UI was not visually verified; `npm run build` and `tsc --noEmit` both
  pass and the dev server was left running for manual browser check.

Not included here (deliberately infra-layer, not app-code):
containerizing the app (Dockerfile), moving secrets to Secrets Manager/SSM,
ECS/ALB/RDS setup, SQS-backed worker, CI/CD pipeline, CloudFront/S3 for the
frontend, WAF rate-based rules, CloudWatch alarms.
