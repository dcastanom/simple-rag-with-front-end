import type { DocumentSummary } from '../../types';

interface DocumentsPanelProps {
  documents: DocumentSummary[];
  loading: boolean;
  error: string | null;
  onDelete: (jobId: string) => void;
}

export function DocumentsPanel({ documents, loading, error, onDelete }: DocumentsPanelProps) {
  return (
    <section className="rounded-2xl border border-stone-200 bg-white/60 p-5 shadow-soft dark:border-stone-800 dark:bg-stone-900/60">
      <h2 className="mb-3 text-sm font-medium text-stone-600 dark:text-stone-300">
        Your documents
      </h2>

      {error && <p className="mb-3 text-xs text-red-600 dark:text-red-400">{error}</p>}

      {loading ? (
        <p className="text-sm text-stone-400">Loading…</p>
      ) : documents.length === 0 ? (
        <p className="text-sm text-stone-400">Nothing ingested yet — upload a PDF above.</p>
      ) : (
        <ul className="space-y-2">
          {documents.map((doc) => (
            <li
              key={doc.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-stone-100 px-3 py-2 text-sm dark:border-stone-800"
            >
              <div className="min-w-0">
                <p className="truncate font-medium text-stone-700 dark:text-stone-200">{doc.filename}</p>
                <p className="text-xs text-stone-400">
                  {doc.chunk_count ?? 0} chunks ·{' '}
                  {new Date(doc.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                </p>
              </div>
              <button
                type="button"
                onClick={() => onDelete(doc.id)}
                aria-label={`Delete ${doc.filename}`}
                className="shrink-0 text-stone-400 hover:text-red-600 dark:hover:text-red-400"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
