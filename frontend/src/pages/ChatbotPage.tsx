import { useState } from 'react';
import { useDocumentUpload } from '../hooks/useDocumentUpload';
import { useChat } from '../hooks/useChat';
import { useHistory } from '../hooks/useHistory';
import { Header } from '../components/layout/Header';
import { UploadPanel } from '../components/upload/UploadPanel';
import { ChatComposer } from '../components/chat/ChatComposer';
import { AnswerCard } from '../components/chat/AnswerCard';
import { HistoryList } from '../components/history/HistoryList';
import type { ChatResponse } from '../types';

export function ChatbotPage() {
  const upload = useDocumentUpload();
  const chat = useChat();
  const history = useHistory();
  const [lastQuestion, setLastQuestion] = useState<string | null>(null);

  const handleAsk = async (question: string): Promise<ChatResponse | null> => {
    const result = await chat.ask(question);
    if (result) {
      setLastQuestion(question);
      history.add({
        question,
        answer: result.answer,
        sources: result.sources,
        topSimilarity: result.topSimilarity,
      });
    }
    return result;
  };

  return (
    <div className="min-h-screen bg-stone-50 px-4 py-10 dark:bg-stone-950">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <Header />

        <UploadPanel
          status={upload.status}
          message={upload.message}
          onUpload={upload.upload}
          onDismissMessage={upload.reset}
        />

        <ChatComposer loading={chat.loading} error={chat.error} onAsk={handleAsk} />

        {chat.lastAnswer && lastQuestion && (
          <AnswerCard answer={chat.lastAnswer} question={lastQuestion} />
        )}

        <HistoryList entries={history.entries} onClear={history.clear} />
      </div>
    </div>
  );
}
