// =============================================================================
// hooks/useDocumentUpload.ts
//
// A custom React hook that drives the "upload a PDF and wait for it to be
// ingested" flow. Ingestion (chunking + embedding the PDF server-side) can
// take a while, so uploading isn't a single request/response — this hook
// uploads the file, then repeatedly polls a job-status endpoint until the
// backend reports success or failure.
//
// Any component can use this by calling `useDocumentUpload()` and getting
// back `{ status, message, upload, reset }` — see the bottom of the file.
// =============================================================================

import { useCallback, useRef, useState } from 'react';
import { uploadDocument, getIngestJobStatus } from '../api/documentsApi';
import { ApiError } from '../api/client';

// The lifecycle of a single upload attempt:
// - 'idle'      -> nothing happening, initial state (or after reset())
// - 'uploading' -> file is being sent and/or the ingest job is being polled
// - 'success'   -> ingestion finished, PDF is ready to query
// - 'error'     -> upload or ingestion failed
export type UploadStatus = 'idle' | 'uploading' | 'success' | 'error';

// What this hook tracks internally: the current status plus a
// human-readable message to show the user (success summary or error text).
interface UploadState {
  status: UploadStatus;
  message: string | null;
}

// How often to re-check the ingest job's status while waiting, in
// milliseconds. Polling (rather than e.g. websockets) keeps this simple.
const POLL_INTERVAL_MS = 1500;

// Converts a thrown error into a friendly string for display. ApiError
// (from client.ts) carries a structured message/detail from the backend;
// anything else (network blip, unexpected exception) gets a generic message.
function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    return err.detail ? `${err.message}: ${err.detail}` : err.message;
  }
  return 'Upload failed unexpectedly.';
}

// A small helper to "pause" inside an async function — resolves after
// `ms` milliseconds, used to space out the polling requests below.
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function useDocumentUpload() {
  const [state, setState] = useState<UploadState>({ status: 'idle', message: null });

  // A ref (not state) because changing it should NOT trigger a re-render —
  // it's only read inside the polling loop to decide whether to bail out
  // early, e.g. if the user navigates away or calls reset() mid-upload.
  const cancelledRef = useRef(false);

  // Starts an upload for the given File and doesn't resolve until the
  // whole flow (upload + polling) finishes, succeeds, fails, or is
  // cancelled. useCallback keeps a stable function reference across
  // re-renders so components using this hook don't re-run effects
  // unnecessarily if `upload` is in their dependency array.
  const upload = useCallback(async (file: File) => {
    cancelledRef.current = false; // fresh attempt, clear any prior cancellation
    setState({ status: 'uploading', message: null });

    try {
      // Step 1: send the actual file to the backend. This kicks off a
      // background ingest job and immediately returns its ID — it does
      // NOT wait for ingestion to finish.
      const { jobId } = await uploadDocument(file);

      // Step 2: poll until the background ingest job finishes; each PDF
      // can take a while (it's embedding chunks server-side), so this
      // isn't a single request/response anymore.
      for (;;) {
        // Bail out silently if reset() was called while we were mid-flight
        // (e.g. user cancelled or started a new upload elsewhere).
        if (cancelledRef.current) return;

        const job = await getIngestJobStatus(jobId);

        if (job.status === 'done') {
          setState({
            status: 'success',
            message: `Ingested ${job.chunk_count ?? 0} chunks from "${job.filename}"`,
          });
          return;
        }

        if (job.status === 'failed') {
          setState({
            status: 'error',
            message: job.error ? `Ingestion failed: ${job.error}` : 'Ingestion failed',
          });
          return;
        }

        // Job is still pending/processing — wait, then check again.
        await sleep(POLL_INTERVAL_MS);
      }
    } catch (err) {
      // Only surface the error if we weren't cancelled — otherwise a
      // network error from an abandoned upload would incorrectly flash
      // an error message after the user already moved on.
      if (!cancelledRef.current) {
        setState({ status: 'error', message: describeError(err) });
      }
    }
  }, []);

  // Cancels any in-flight polling loop and resets the hook back to its
  // initial idle state — e.g. called when the user dismisses an error or
  // navigates away from the upload UI.
  const reset = useCallback(() => {
    cancelledRef.current = true;
    setState({ status: 'idle', message: null });
  }, []);

  // Public interface returned to whichever component calls this hook.
  return { status: state.status, message: state.message, upload, reset };
}
