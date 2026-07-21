# Simple RAG with Front-End

A minimal **Retrieval-Augmented Generation (RAG)** application with a clean web interface.  
Upload your documents and ask questions about them — the AI retrieves the most relevant passages and generates a grounded answer with source citations.

---

## Features

- 📄 Upload **PDF**, **TXT**, and **Markdown** documents (up to 50 MB each)
- 💬 Chat interface for asking questions about uploaded content
- 🔍 Semantic search over document chunks using **ChromaDB**
- 📎 Source citations shown alongside every answer
- 🗑️ Delete documents when they are no longer needed
- 💾 Persisted vector store — documents survive server restarts

---

## Prerequisites

| Requirement | Version |
|-------------|---------|
| Python | 3.10 + |
| pip | any recent |
| OpenAI API key | — |

---

## Quick start

```bash
# 1. Clone
git clone https://github.com/dcastanom/simple-rag-with-front-end.git
cd simple-rag-with-front-end

# 2. Install dependencies
cd backend
pip install -r requirements.txt

# 3. Configure environment variables
cp .env.example .env
#  → open .env and set OPENAI_API_KEY=sk-...

# 4. Start the server
python main.py

# 5. Open the app
#  → http://localhost:8000
```

For development with auto-reload:

```bash
uvicorn main:app --reload --port 8000
```

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | **required** | Your OpenAI API key |
| `OPENAI_MODEL` | `gpt-3.5-turbo` | Chat completion model |
| `PORT` | `8000` | Server listening port |

---

## Project structure

```
simple-rag-with-front-end/
├── backend/
│   ├── main.py          # FastAPI application & API routes
│   ├── rag.py           # RAG pipeline (LangChain + ChromaDB + OpenAI)
│   ├── requirements.txt # Python dependencies
│   └── .env.example     # Environment variable template
├── frontend/
│   ├── index.html       # Single-page application shell
│   ├── styles.css       # All styles (no external CSS framework)
│   └── app.js           # Vanilla JS — upload, chat, document list
└── README.md
```

Runtime directories created automatically (git-ignored):

```
backend/uploads/      # uploaded files
backend/chroma_db/    # persisted vector store
backend/documents.json
```

---

## How it works

1. **Upload** — The document is split into overlapping chunks (1 000 chars, 200 overlap), each chunk is embedded with `text-embedding-ada-002`, and stored in a local ChromaDB collection.
2. **Query** — Your question is embedded and the top-4 most similar chunks are retrieved.  The question + context are sent to GPT (default `gpt-3.5-turbo`) which generates a grounded answer.
3. **Sources** — The retrieved passages are shown below the answer so you can verify the information.

---

## API reference

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/documents` | List uploaded documents |
| `POST` | `/api/documents/upload` | Upload a document (`multipart/form-data`) |
| `DELETE` | `/api/documents/{id}` | Delete a document |
| `POST` | `/api/chat` | Ask a question `{ "question": "…", "history": [] }` |
