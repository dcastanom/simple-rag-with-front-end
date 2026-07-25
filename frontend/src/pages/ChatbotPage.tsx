import { useEffect, useState } from 'react';
import { useDocumentUpload } from '../hooks/useDocumentUpload';
import { useDocuments } from '../hooks/useDocuments';
import { useChat } from '../hooks/useChat';
import { useHistory } from '../hooks/useHistory';
import { Header } from '../components/layout/Header';
import { UploadPanel } from '../components/upload/UploadPanel';
import { DocumentsPanel } from '../components/documents/DocumentsPanel';
import { ChatComposer } from '../components/chat/ChatComposer';
import { AnswerCard } from '../components/chat/AnswerCard';
import { HistoryList } from '../components/history/HistoryList';
import type { ChatResponse } from '../types';

export function ChatbotPage() {
  const upload = useDocumentUpload();
  const documents = useDocuments();
  const chat = useChat();
  const history = useHistory();
  const [lastQuestion, setLastQuestion] = useState<string | null>(null);

  // Refresh the document list once an upload finishes ingesting, so a
  // newly ingested file shows up without the user having to reload.
  useEffect(() => {
    if (upload.status === 'success') documents.refresh();
  }, [upload.status, documents.refresh]);

  const handleAsk = async (question: string, docId: string | null): Promise<ChatResponse | null> => {
    const result = await chat.ask(question, docId);
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

        <DocumentsPanel
          documents={documents.documents}
          loading={documents.loading}
          error={documents.error}
          onDelete={documents.remove}
        />

        <ChatComposer
          loading={chat.loading}
          error={chat.error}
          documents={documents.documents}
          onAsk={handleAsk}
        />

        {chat.lastAnswer && lastQuestion && (
          <AnswerCard answer={chat.lastAnswer} question={lastQuestion} />
        )}

        <HistoryList entries={history.entries} onClear={history.clear} />
      </div>
    </div>
  );
}
