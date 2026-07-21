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
**Problem**:Right now /chat holds the connection open until Groq finishes generating the full answer, then returns everything at once. On a short question that's fine. On a longer one, the user stares at nothing for a few seconds and wonders if the request hung.

**Fix**: The Groq API supports streaming — add stream: true to the request body and tokens start coming back as they're generated. Piping those through Express with res.write() is maybe 15 minutes of work and the difference in feel is immediate.

---

## 14. Metadata filtering

**problem**: Once you've loaded more than a few documents, queries bleed across everything: ask about the API spec and you'll get chunks from the onboarding guide too.

**Fix**: The fix is a metadata JSONB column where you store the document ID on ingest, then add `WHERE metadata->>'doc_id' = $1` to the similarity query. Expose it as an optional body field on `/chat: { "question": "...", "docId": "api-spec-v2" }`. Users get scoped results, and you get much cleaner answers.

When your corpus grows into the hundreds of documents, look at re-ranking. Vector similarity retrieval is fast but approximate — it finds chunks that are semantically close to the question, not necessarily the ones that most directly answer it.

The pattern is: retrieve the top 20 by cosine distance, then run a cross-encoder over them to re-score by actual relevance, then take the best 5 from that second pass. LangChain.js has a cross-encoder wrapper if you don't want to implement it yourself.

---

## 15. Document management 
**problem**: The ability to list what's ingested, delete a specific file, and re-ingest an updated version.

**fix** A DELETE FROM documents WHERE source = $1 handles the delete case. Add a GET /documents endpoint that queries SELECT DISTINCT source FROM documents and you have a complete enough API for real use.

---

## 16. Add measurements to the logs

Add measurements like token, memory, latency usage in order to give an idea of what are the costs we might incur when this goes to production. Be creative.

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

Not included here (deliberately infra-layer, not app-code):
containerizing the app (Dockerfile), moving secrets to Secrets Manager/SSM,
ECS/ALB/RDS setup, SQS-backed worker, CI/CD pipeline, CloudFront/S3 for the
frontend, WAF rate-based rules, CloudWatch alarms.
