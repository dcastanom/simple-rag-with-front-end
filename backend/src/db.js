const { Pool } = require('pg');
const { logger } = require('./logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 10),
});

async function initDb() {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS refresh_tokens_token_hash_idx ON refresh_tokens (token_hash)
  `);

  // halfvec, not vector: pgvector's HNSW/ivfflat indexes cap at 2000 dims
  // for the full-precision "vector" type, but Gemini's embeddings are 3072-
  // dim. halfvec (half-precision) supports indexing up to 4000 dims with a
  // small, acceptable precision tradeoff.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ingest_jobs (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id),
      filename TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      chunk_count INT,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS ingest_jobs_user_id_idx ON ingest_jobs (user_id)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS documents (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id),
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      embedding HALFVEC(3072),
      job_id UUID REFERENCES ingest_jobs(id)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS documents_user_id_idx ON documents (user_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS documents_job_id_idx ON documents (job_id)
  `);

  // HNSW over ivfflat: no "lists" tuning needed and works well even before
  // the table has much data in it, unlike ivfflat which wants realistic
  // row counts to pick a good list count.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS documents_embedding_hnsw_idx
    ON documents USING hnsw (embedding halfvec_cosine_ops)
  `);

  logger.info('Database ready');
}

module.exports = { pool, initDb };