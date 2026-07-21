import logging
import os
from pathlib import Path
from typing import List

from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain_community.document_loaders import PyPDFLoader, TextLoader
from langchain_community.vectorstores import Chroma
from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import RunnablePassthrough
from langchain_openai import ChatOpenAI, OpenAIEmbeddings

CHROMA_DIR = Path("chroma_db")

# Number of leading characters used as the deduplication key for retrieved chunks.
# 80 chars is enough to distinguish different passages while being shorter than a
# full chunk (1000 chars), so near-duplicate passages are collapsed.
_DEDUP_KEY_LEN = 80

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = (
    "You are a helpful assistant that answers questions based on the provided context.\n"
    "Use the retrieved context below to answer the question.\n"
    "If the context does not contain enough information, say you don't know.\n"
    "Keep your answer concise and accurate.\n\n"
    "Context:\n{context}"
)


class RAGSystem:
    def __init__(self) -> None:
        self.embeddings = OpenAIEmbeddings()
        self.vectorstore = Chroma(
            persist_directory=str(CHROMA_DIR),
            embedding_function=self.embeddings,
            collection_name="rag_documents",
        )
        self.text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=1000,
            chunk_overlap=200,
        )
        self.llm = ChatOpenAI(
            model=os.getenv("OPENAI_MODEL", "gpt-3.5-turbo"),
            temperature=0,
        )

    def add_document(self, file_path: str, doc_id: str, filename: str) -> int:
        """Load, split, and embed a document. Returns the number of pages/sections loaded."""
        if filename.lower().endswith(".pdf"):
            loader = PyPDFLoader(file_path)
        else:
            loader = TextLoader(file_path, encoding="utf-8")

        documents = loader.load()
        chunks = self.text_splitter.split_documents(documents)

        for chunk in chunks:
            chunk.metadata["doc_id"] = doc_id
            chunk.metadata["filename"] = filename

        if chunks:
            self.vectorstore.add_documents(chunks)

        return len(documents)

    def delete_document(self, doc_id: str) -> None:
        """Remove all vector chunks belonging to a document."""
        collection = self.vectorstore._collection
        results = collection.get(where={"doc_id": doc_id})
        if results and results.get("ids"):
            collection.delete(ids=results["ids"])

    def query(self, question: str, history: List[dict] | None = None) -> dict:
        """Retrieve relevant context and generate an answer with source citations."""
        history = history or []

        # Return early when no documents are indexed
        if self.vectorstore._collection.count() == 0:
            return {
                "answer": (
                    "No documents have been uploaded yet. "
                    "Please upload a document before asking questions."
                ),
                "sources": [],
            }

        retriever = self.vectorstore.as_retriever(search_kwargs={"k": 4})

        # Build a history preamble (last 3 exchanges)
        history_text = ""
        if history:
            exchanges = history[-3:]
            history_text = "\nChat history:\n" + "\n".join(
                f"Human: {h['question']}\nAssistant: {h['answer']}" for h in exchanges
            )

        prompt = ChatPromptTemplate.from_messages(
            [
                ("system", SYSTEM_PROMPT + history_text),
                ("human", "{question}"),
            ]
        )

        def format_docs(docs: list) -> str:
            return "\n\n".join(doc.page_content for doc in docs)

        chain = (
            {
                "context": retriever | format_docs,
                "question": RunnablePassthrough(),
            }
            | prompt
            | self.llm
            | StrOutputParser()
        )

        # Retrieve once so we can return sources alongside the answer
        source_docs = retriever.invoke(question)
        answer = chain.invoke(question)

        sources = []
        seen: set = set()
        for doc in source_docs:
            key = (doc.metadata.get("filename", ""), doc.page_content[:_DEDUP_KEY_LEN])
            if key in seen:
                continue
            seen.add(key)
            preview = (
                doc.page_content[:300] + "…"
                if len(doc.page_content) > 300
                else doc.page_content
            )
            sources.append(
                {
                    "content": preview,
                    "filename": doc.metadata.get("filename", "Unknown"),
                    "page": doc.metadata.get("page"),
                }
            )

        return {"answer": answer, "sources": sources[:3]}
