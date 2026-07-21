import type { HistoryEntry } from '../../types';
import { HistoryItem } from './HistoryItem';

interface HistoryListProps {
  entries: HistoryEntry[];
  onClear: () => void;
}

export function HistoryList({ entries, onClear }: HistoryListProps) {
  return (
    <section className="rounded-2xl border border-stone-200 bg-white/60 p-5 shadow-soft dark:border-stone-800 dark:bg-stone-900/60">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-stone-600 dark:text-stone-300">History</h2>
        {entries.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="text-xs text-stone-400 hover:text-accent"
          >
            Clear
          </button>
        )}
      </div>

      {entries.length === 0 ? (
        <p className="text-sm text-stone-400">Your past questions will show up here.</p>
      ) : (
        <ul className="space-y-3">
          {entries.map((entry) => (
            <HistoryItem key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </section>
  );
}
