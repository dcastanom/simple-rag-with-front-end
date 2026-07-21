# RAG Chat frontend

React + TypeScript SPA for the `rag-pdf-gemini-node` backend. Upload a PDF,
ask questions about it, and keep a running history of what you've asked
(persisted for the browser session, cleared when the browser closes).

## Layers

- `src/api` — fetch calls only, no React. Talks to the Express backend.
- `src/hooks` — state/business logic, wraps `api/` in React hooks.
- `src/components` — presentation only, calls hooks' functions, never `api/` directly.
- `src/pages/ChatbotPage.tsx` — the single page, wires hooks to components.

## Run it

1. Backend must be running first (from the repo root):
   ```
   docker compose up -d
   npm run dev
   ```
2. Then, from this folder:
   ```
   npm install
   npm run dev
   ```
3. Open the printed local URL (defaults to `http://localhost:5173`).

By default the frontend talks to `http://localhost:3000`. To point it
elsewhere, copy `.env.example` to `.env` and set `VITE_API_URL`.
