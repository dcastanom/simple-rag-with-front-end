const { pool } = require('./db');
const { embedText, generateAnswerStream } = require('./embeddings');
const { logger } = require('./logger');

// Retrieves the caller's matching chunks, then streams the answer via
// `onToken` as Groq generates it. Resolves once the stream is done, with
// the metadata (sources/similarity) that only the retrieval step knows.
async function streamQueryDocuments(question, userId, docId, onToken) {
  const totalStart = Date.now();
  const embedStart = Date.now();
  const questionEmbedding = await embedText(question);
  const embedMs = Date.now() - embedStart;

  const { rows } = await pool.query(
    `SELECT content, source,
            1 - (embedding <=> $1::halfvec) AS similarity
     FROM documents
     WHERE user_id = $2 AND ($3::uuid IS NULL OR job_id = $3)
     ORDER BY embedding <=> $1::halfvec
     LIMIT 5`,
    [JSON.stringify(questionEmbedding), userId, docId]
  );

  if (rows.length === 0) {
    logger.info({ userId, docId, embedMs, chunkCount: 0, totalMs: Date.now() - totalStart }, 'Chat query completed (no matches)');
    onToken('No relevant documents found.');
    return { sources: [] };
  }

  const context = rows.map(r => r.content).join('\n\n---\n\n');
  const genStart = Date.now();
  await generateAnswerStream(context, question, onToken);
  const genMs = Date.now() - genStart;

  logger.info({ userId, docId, embedMs, genMs, chunkCount: rows.length, totalMs: Date.now() - totalStart }, 'Chat query completed');

  return {
    sources: [...new Set(rows.map(r => r.source))],
    topSimilarity: parseFloat(rows[0].similarity).toFixed(3),
  };
}

module.exports = { streamQueryDocuments };