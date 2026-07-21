import { useCallback, useEffect, useState } from 'react';
import { listDocuments, deleteDocument } from '../api/documentsApi';
import { ApiError } from '../api/client';
import type { DocumentSummary } from '../types';

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    return err.detail ? `${err.message}: ${err.detail}` : err.message;
  }
  return 'Something went wrong loading your documents.';
}

export function useDocuments() {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDocuments(await listDocuments());
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const remove = useCallback(async (jobId: string): Promise<boolean> => {
    try {
      await deleteDocument(jobId);
      setDocuments((docs) => docs.filter((d) => d.id !== jobId));
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    }
  }, []);

  return { documents, loading, error, refresh, remove };
}
