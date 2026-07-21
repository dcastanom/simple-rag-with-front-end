export interface AuthUser {
  id: string;
  email: string;
}

export interface AuthResponse {
  accessToken: string;
  user: AuthUser;
}

export interface IngestStartResponse {
  jobId: string;
  message: string;
  statusUrl: string;
}

export interface IngestJobStatus {
  id: string;
  filename: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  chunk_count: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatResponse {
  answer: string;
  sources: string[];
  topSimilarity?: string;
}

export interface ApiErrorPayload {
  error: string;
  detail?: string;
}

export interface HistoryEntry {
  id: string;
  question: string;
  answer: string;
  sources: string[];
  topSimilarity?: string;
  createdAt: number;
}
