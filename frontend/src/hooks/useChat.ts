import { useCallback, useState } from 'react';
import { streamQuestion } from '../api/chatApi';
import type { ChatResponse } from '../types';

interface ChatState {
  loading: boolean;
  error: string | null;
  lastAnswer: ChatResponse | null;
}

export function useChat() {
  const [state, setState] = useState<ChatState>({
    loading: false,
    error: null,
    lastAnswer: null,
  });

  const ask = useCallback(async (question: string, docId: string | null): Promise<ChatResponse | null> => {
    setState({ loading: true, error: null, lastAnswer: { answer: '', sources: [] } });

    let accumulated = '';
    let result: ChatResponse | null = null;
    let errorMessage: string | null = null;

    await streamQuestion(question, docId, {
      onToken: (text) => {
        accumulated += text;
        setState((s) => ({
          ...s,
          lastAnswer: { ...(s.lastAnswer ?? { sources: [] }), answer: accumulated },
        }));
      },
      onDone: ({ sources, topSimilarity }) => {
        result = { answer: accumulated, sources, topSimilarity };
        setState({ loading: false, error: null, lastAnswer: result });
      },
      onError: (message) => {
        errorMessage = message;
        setState((s) => ({ ...s, loading: false, error: message }));
      },
    });

    return errorMessage ? null : result;
  }, []);

  return { loading: state.loading, error: state.error, lastAnswer: state.lastAnswer, ask };
}
