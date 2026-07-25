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
  const start = Date.now();
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

  // Gemini's embedContent response has no token-usage field, so this is
  // latency + input size only — still useful to spot slow/oversized calls.
  logger.info({ label: 'gemini-embed', ms: Date.now() - start, chars: text.length }, 'Embed call completed');

  return data.embedding.values;
}

const SYSTEM_PROMPT = 'You are a helpful assistant. Answer the question using only the context provided. If the context does not contain enough information, say so clearly.';

// Streams the answer token-by-token via `onToken`, so the caller (an
// Express route) can forward each piece to the client as it arrives
// instead of waiting for the full response. `stream_options.include_usage`
// asks Groq to append a final usage-only chunk before [DONE], same
// prompt/completion/total token counts the non-streaming call used to log.
async function generateAnswerStream(context, question, onToken) {
  const start = Date.now();
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
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Context:\n${context}\n\nQuestion: ${question}` },
        ],
      }),
    },
    'groq-chat-stream'
  );

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(errBody);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage = null;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 2);
      if (!rawEvent.startsWith('data:')) continue;

      const payload = rawEvent.slice(5).trim();
      if (payload === '[DONE]') continue;

      const parsed = JSON.parse(payload);
      const delta = parsed.choices?.[0]?.delta?.content;
      if (delta) onToken(delta);
      if (parsed.usage) usage = parsed.usage;
    }
  }

  logger.info({
    label: 'groq-chat-stream',
    ms: Date.now() - start,
    promptTokens: usage?.prompt_tokens,
    completionTokens: usage?.completion_tokens,
    totalTokens: usage?.total_tokens,
  }, 'Generate call completed');
}

module.exports = { embedText, generateAnswerStream };
