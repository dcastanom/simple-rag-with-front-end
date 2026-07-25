const { PDFParse } = require('pdf-parse');
const { v4: uuidv4 } = require('uuid');
const pLimit = require('p-limit');
const { pool } = require('./db');
const { embedText } = require('./embeddings');
const { logger } = require('./logger');

const INGEST_CONCURRENCY = Number(process.env.INGEST_CONCURRENCY || 5);

function chunkText(text, chunkSize = 500, overlap = 50) {
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end).trim());
    start += chunkSize - overlap;
  }

  return chunks.filter(chunk => chunk.length > 50);
}

async function createIngestJob(filename, userId) {
  const jobId = uuidv4();
  await pool.query(
    `INSERT INTO ingest_jobs (id, user_id, filename, status) VALUES ($1, $2, $3, 'pending')`,
    [jobId, userId, filename]
  );
  return jobId;
}

async function getIngestJob(jobId, userId) {
  const { rows } = await pool.query(
    `SELECT id, filename, status, chunk_count, error, created_at, updated_at
     FROM ingest_jobs WHERE id = $1 AND user_id = $2`,
    [jobId, userId]
  );
  return rows[0] || null;
}

// Runs in the background — the HTTP handler does not await this. Embeds
// chunks with bounded concurrency (rather than one at a time) so a large
// PDF doesn't take minutes, without overwhelming Gemini's rate limits.
async function processIngestJob(jobId, userId, buffer, filename) {
  const jobStart = Date.now();
  try {
    await pool.query(`UPDATE ingest_jobs SET status = 'processing', updated_at = now() WHERE id = $1`, [jobId]);

    const parser = new PDFParse({ data: buffer });
    const { text } = await parser.getText();
    await parser.destroy();

    const chunks = chunkText(text);
    logger.info({ jobId, filename, chunkCount: chunks.length }, 'Processing ingest job');

    const limit = pLimit(INGEST_CONCURRENCY);
    await Promise.all(chunks.map(chunk => limit(async () => {
      const embedding = await embedText(chunk);
      await pool.query(
        `INSERT INTO documents (id, user_id, content, source, embedding, job_id)
         VALUES ($1, $2, $3, $4, $5::halfvec, $6)`,
        [uuidv4(), userId, chunk, filename, JSON.stringify(embedding), jobId]
      );
    })));

    await pool.query(
      `UPDATE ingest_jobs SET status = 'done', chunk_count = $2, updated_at = now() WHERE id = $1`,
      [jobId, chunks.length]
    );
    const mem = process.memoryUsage();
    logger.info({
      jobId,
      filename,
      chunkCount: chunks.length,
      totalMs: Date.now() - jobStart,
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
    }, 'Ingest job done');
  } catch (err) {
    logger.error({ jobId, filename, err, totalMs: Date.now() - jobStart }, 'Ingest job failed, cleaning up partial rows');

    // No partial documents left behind on failure.
    await pool.query(`DELETE FROM documents WHERE job_id = $1`, [jobId]);
    await pool.query(
      `UPDATE ingest_jobs SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`,
      [jobId, err.message]
    );
  }
}

async function listDocuments(userId) {
  const { rows } = await pool.query(
    `SELECT id, filename, chunk_count, created_at
     FROM ingest_jobs WHERE user_id = $1 AND status = 'done'
     ORDER BY created_at DESC`,
    [userId]
  );
  return rows;
}

// Deletes a document's chunks and its job record. Both queries are scoped
// to user_id, same as every other document/job lookup, so one user can
// never delete another's data even with a guessed job id.
async function deleteDocument(jobId, userId) {
  await pool.query(`DELETE FROM documents WHERE job_id = $1 AND user_id = $2`, [jobId, userId]);
  const { rowCount } = await pool.query(
    `DELETE FROM ingest_jobs WHERE id = $1 AND user_id = $2`,
    [jobId, userId]
  );
  return rowCount > 0;
}

module.exports = { createIngestJob, getIngestJob, processIngestJob, listDocuments, deleteDocument };
