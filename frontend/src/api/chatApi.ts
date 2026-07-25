import { apiClient, ApiError } from './client';

export interface ChatStreamResult {
  sources: string[];
  topSimilarity?: string;
}

export interface ChatStreamCallbacks {
  onToken: (text: string) => void;
  onDone: (result: ChatStreamResult) => void;
  onError: (message: string) => void;
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    return err.detail ? `${err.message}: ${err.detail}` : err.message;
  }
  return 'Something went wrong asking your question.';
}

// Parses one `event: <name>\ndata: <json>` SSE frame (the blank-line
// separated unit the backend writes per token/done/error) and dispatches
// it to the matching callback.
function handleFrame(frame: string, cb: ChatStreamCallbacks) {
  let event = 'message';
  let data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return;

  if (event === 'token') cb.onToken(JSON.parse(data) as string);
  else if (event === 'done') cb.onDone(JSON.parse(data) as ChatStreamResult);
  else if (event === 'error') cb.onError(JSON.parse(data) as string);
}

// Streams an answer from /chat token-by-token instead of waiting for one
// JSON response. Resolves once the stream ends (after onDone or onError
// fires) — it never rejects, since a request-level failure is reported
// through onError rather than a thrown exception.
export async function streamQuestion(
  question: string,
  docId: string | null,
  cb: ChatStreamCallbacks
): Promise<void> {
  let res: Response;
  try {
    res = await apiClient.postJsonStream('/chat', docId ? { question, docId } : { question });
  } catch (err) {
    cb.onError(describeError(err));
    return;
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });

    let sepIndex;
    while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);
      handleFrame(frame, cb);
    }
  }
}
