import { useState } from 'react';
import type { HistoryEntry } from '../../types';
import { truncate } from '../../utils/truncate';
import { formatTime } from '../../utils/formatDate';

interface HistoryItemProps {
  entry: HistoryEntry;
}

export function HistoryItem({ entry }: HistoryItemProps) {
  const [expanded, setExpanded] = useState(false);
  const truncated = truncate(entry.answer, 200);
  const canExpand = truncated.length < entry.answer.length;

  return (
    <li className="rounded-xl border border-stone-100 bg-white/50 p-4 text-sm dark:border-stone-800 dark:bg-stone-900/40">
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium text-stone-800 dark:text-stone-100">{entry.question}</p>
        <span className="shrink-0 text-xs text-stone-400">{formatTime(entry.createdAt)}</span>
      </div>
      <p className="mt-1 text-stone-600 dark:text-stone-400">
        {expanded ? entry.answer : truncated}
      </p>
      {canExpand && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-xs font-medium text-accent hover:underline"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </li>
  );
}
