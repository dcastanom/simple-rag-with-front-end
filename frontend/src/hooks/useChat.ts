import { useCallback, useState } from 'react';
import { askQuestion } from '../api/chatApi';
import { ApiError } from '../api/client';
import type { ChatResponse } from '../types';

interface ChatState {
  loading: boolean;
  error: string | null;
  lastAnswer: ChatResponse | null;
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    return err.detail ? `${err.message}: ${err.detail}` : err.message;
  }
  return 'Something went wrong asking your question.';
}

export function useChat() {
  const [state, setState] = useState<ChatState>({
    loading: false,
    error: null,
    lastAnswer: null,
  });

  const ask = useCallback(async (question: string): Promise<ChatResponse | null> => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const result = await askQuestion(question);
      setState({ loading: false, error: null, lastAnswer: result });
      return result;
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: describeError(err) }));
      return null;
    }
  }, []);

  return { loading: state.loading, error: state.error, lastAnswer: state.lastAnswer, ask };
}
