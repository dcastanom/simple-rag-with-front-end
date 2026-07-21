import json
import os
import uuid
from pathlib import Path
from typing import List, Optional

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

load_dotenv()

from rag import RAGSystem  # noqa: E402 – must come after load_dotenv

# ---------------------------------------------------------------------------
# Application setup
# ---------------------------------------------------------------------------

app = FastAPI(title="Simple RAG")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

rag = RAGSystem()

UPLOAD_DIR = Path("uploads")
DOCS_FILE = Path("documents.json")
UPLOAD_DIR.mkdir(exist_ok=True)

ALLOWED_EXTENSIONS = {".pdf", ".txt", ".md"}
MAX_FILE_SIZE = 50 * 1024 * 1024  # 50 MB

# ---------------------------------------------------------------------------
# Document metadata helpers
# ---------------------------------------------------------------------------


def _load_docs() -> dict:
    if DOCS_FILE.exists():
        with open(DOCS_FILE) as f:
            return json.load(f)
    return {}


def _save_docs(docs: dict) -> None:
    with open(DOCS_FILE, "w") as f:
        json.dump(docs, f, indent=2)


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class ChatRequest(BaseModel):
    question: str
    history: Optional[List[dict]] = []


class ChatResponse(BaseModel):
    answer: str
    sources: List[dict]


# ---------------------------------------------------------------------------
# API routes
# ---------------------------------------------------------------------------


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/documents/upload")
async def upload_document(file: UploadFile = File(...)):
    suffix = Path(file.filename).suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{suffix}'. Allowed: {', '.join(ALLOWED_EXTENSIONS)}",
        )

    content = await file.read()
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="File exceeds the 50 MB limit")

    doc_id = str(uuid.uuid4())
    safe_name = f"{doc_id}{suffix}"
    file_path = UPLOAD_DIR / safe_name

    with open(file_path, "wb") as f:
        f.write(content)

    try:
        page_count = rag.add_document(str(file_path), doc_id, file.filename)
    except Exception as exc:
        file_path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Failed to process document: {exc}") from exc

    doc_meta = {
        "id": doc_id,
        "filename": file.filename,
        "size": len(content),
        "pages": page_count,
        "path": str(file_path),
    }
    docs = _load_docs()
    docs[doc_id] = doc_meta
    _save_docs(docs)

    return doc_meta


@app.get("/api/documents")
def list_documents():
    return list(_load_docs().values())


@app.delete("/api/documents/{doc_id}")
def delete_document(doc_id: str):
    docs = _load_docs()
    if doc_id not in docs:
        raise HTTPException(status_code=404, detail="Document not found")

    doc = docs[doc_id]

    try:
        rag.delete_document(doc_id)
    except Exception:
        pass  # Best-effort vector deletion

    file_path = Path(doc["path"])
    if file_path.exists():
        file_path.unlink()

    del docs[doc_id]
    _save_docs(docs)

    return {"message": "Document deleted successfully"}


@app.post("/api/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    if not request.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty")

    try:
        result = rag.query(request.question, request.history)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to generate response: {exc}") from exc

    return result


# ---------------------------------------------------------------------------
# Frontend serving
# ---------------------------------------------------------------------------

_frontend_dir = Path(__file__).parent.parent / "frontend"

if _frontend_dir.exists():
    app.mount("/static", StaticFiles(directory=str(_frontend_dir)), name="static")

    @app.get("/", include_in_schema=False)
    async def serve_index():
        return FileResponse(str(_frontend_dir / "index.html"))


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    port = int(os.getenv("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
