import { useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { UploadStatus } from '../../hooks/useDocumentUpload';
import { StatusBanner } from './StatusBanner';

interface UploadPanelProps {
  status: UploadStatus;
  message: string | null;
  onUpload: (file: File) => void;
  onDismissMessage: () => void;
}

export function UploadPanel({ status, message, onUpload, onDismissMessage }: UploadPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    setSelectedName(file ? file.name : null);
  };

  const handleSubmit = () => {
    const file = inputRef.current?.files?.[0];
    if (file) onUpload(file);
  };

  const isUploading = status === 'uploading';

  return (
    <section className="rounded-2xl border border-stone-200 bg-white/60 p-5 shadow-soft dark:border-stone-800 dark:bg-stone-900/60">
      <h2 className="mb-3 text-sm font-medium text-stone-600 dark:text-stone-300">
        1. Upload a PDF
      </h2>
      <div className="flex flex-wrap items-center gap-3">
        <label className="cursor-pointer rounded-xl border border-dashed border-stone-300 px-4 py-2 text-sm text-stone-600 transition hover:border-accent hover:text-accent dark:border-stone-700 dark:text-stone-300">
          Choose file
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf"
            onChange={handleFileChange}
            className="hidden"
          />
        </label>
        <span className="text-sm text-stone-500 dark:text-stone-400">
          {selectedName ?? 'No file selected'}
        </span>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!selectedName || isUploading}
          className="ml-auto rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white shadow-soft transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isUploading ? 'Uploading…' : 'Ingest document'}
        </button>
      </div>

      {message && (status === 'success' || status === 'error') && (
        <div className="mt-4">
          <StatusBanner variant={status} message={message} onDismiss={onDismissMessage} />
        </div>
      )}
    </section>
  );
}
