import { apiClient } from './client';
import type { IngestStartResponse, IngestJobStatus, DocumentSummary } from '../types';

export function uploadDocument(file: File): Promise<IngestStartResponse> {
  const form = new FormData();
  form.append('file', file);
  return apiClient.postForm<IngestStartResponse>('/ingest', form);
}

export function getIngestJobStatus(jobId: string): Promise<IngestJobStatus> {
  return apiClient.getJson<IngestJobStatus>(`/ingest/${jobId}`);
}

export function listDocuments(): Promise<DocumentSummary[]> {
  return apiClient.getJson<DocumentSummary[]>('/documents');
}

export function deleteDocument(jobId: string): Promise<void> {
  return apiClient.deleteJson<void>(`/documents/${jobId}`);
}
