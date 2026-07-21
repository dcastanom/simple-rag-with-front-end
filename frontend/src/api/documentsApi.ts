import { apiClient } from './client';
import type { IngestStartResponse, IngestJobStatus } from '../types';

export function uploadDocument(file: File): Promise<IngestStartResponse> {
  const form = new FormData();
  form.append('file', file);
  return apiClient.postForm<IngestStartResponse>('/ingest', form);
}

export function getIngestJobStatus(jobId: string): Promise<IngestJobStatus> {
  return apiClient.getJson<IngestJobStatus>(`/ingest/${jobId}`);
}
