import { apiClient } from './client';
import type { ChatResponse } from '../types';

export function askQuestion(question: string): Promise<ChatResponse> {
  return apiClient.postJson<ChatResponse>('/chat', { question });
}
