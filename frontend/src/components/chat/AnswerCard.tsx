import type { ChatResponse } from '../../types';

interface AnswerCardProps {
  answer: ChatResponse;
  question: string;
}

export function AnswerCard({ answer, question }: AnswerCardProps) {
  return (
    <section className="rounded-2xl border border-stone-200 bg-white/60 p-5 shadow-soft dark:border-stone-800 dark:bg-stone-900/60">
      <p className="text-xs font-medium uppercase tracking-wide text-accent">You asked</p>
      <p className="mt-1 text-sm text-stone-700 dark:text-stone-300">{question}</p>

      <p className="mt-4 text-xs font-medium uppercase tracking-wide text-accent">Answer</p>
      <p className="mt-1 whitespace-pre-wrap text-stone-800 dark:text-stone-100">
        {answer.answer}
      </p>

      {(answer.sources.length > 0 || answer.topSimilarity) && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-stone-100 pt-3 text-xs text-stone-500 dark:border-stone-800 dark:text-stone-400">
          {answer.sources.map((source) => (
            <span
              key={source}
              className="rounded-full bg-stone-100 px-2 py-1 font-mono dark:bg-stone-800"
            >
              {source}
            </span>
          ))}
          {answer.topSimilarity && (
            <span className="ml-auto font-mono">similarity {answer.topSimilarity}</span>
          )}
        </div>
      )}
    </section>
  );
}
