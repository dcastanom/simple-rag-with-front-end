const { logger } = require('./logger');

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1/models';

const REQUEST_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 15000);
const MAX_RETRIES = 2; // total attempts = MAX_RETRIES + 1

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Retries on network errors, timeouts, 429, and 5xx (all transient).
// Does not retry other 4xx — a bad request won't succeed on retry.
async function fetchWithRetry(url, options, label) {
  let lastErr;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);

      if (!res.ok && (res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const backoffMs = 500 * 2 ** attempt;
        logger.warn({ label, status: res.status, attempt }, 'Retrying after transient failure');
        await sleep(backoffMs);
        continue;
      }

      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;

      if (attempt < MAX_RETRIES) {
        const backoffMs = 500 * 2 ** attempt;
        logger.warn({ label, err: err.message, attempt }, 'Retrying after network error/timeout');
        await sleep(backoffMs);
        continue;
      }
    }
  }

  throw lastErr || new Error(`${label} failed after ${MAX_RETRIES + 1} attempts`);
}

async function embedText(text) {
  const res = await fetchWithRetry(
    `${GEMINI_BASE}/gemini-embedding-001:embedContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { parts: [{ text }] } }),
    },
    'gemini-embed'
  );
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data.embedding.values;
}

async function generateAnswer(context, question) {
  const res = await fetchWithRetry(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant. Answer the question using only the context provided. If the context does not contain enough information, say so clearly.',
          },
          {
            role: 'user',
            content: `Context:\n${context}\n\nQuestion: ${question}`,
          },
        ],
      }),
    },
    'groq-chat'
  );
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data.choices[0].message.content;
}

module.exports = { embedText, generateAnswer };
