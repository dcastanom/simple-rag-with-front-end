import { useState } from 'react';
import type { FormEvent } from 'react';

interface ChatComposerProps {
  loading: boolean;
  error: string | null;
  onAsk: (question: string) => Promise<unknown>;
}

export function ChatComposer({ loading, error, onAsk }: ChatComposerProps) {
  const [value, setValue] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const question = value.trim();
    if (!question || loading) return;
    const result = await onAsk(question);
    if (result) setValue('');
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-2xl border border-stone-200 bg-white/60 p-5 shadow-soft dark:border-stone-800 dark:bg-stone-900/60"
    >
      <h2 className="mb-3 text-sm font-medium text-stone-600 dark:text-stone-300">
        2. Ask a question
      </h2>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="What is this document about?"
        rows={3}
        className="w-full resize-none rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm text-stone-800 outline-none transition focus:border-accent dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100"
      />
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-xs text-red-600 dark:text-red-400">{error ?? ''}</p>
        <button
          type="submit"
          disabled={loading || !value.trim()}
          className="ml-auto shrink-0 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white shadow-soft transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? 'Thinking…' : 'Ask'}
        </button>
      </div>
    </form>
  );
}
