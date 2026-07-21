import { useAuth } from '../../context/AuthContext';

export function Header() {
  const { status, user, logout } = useAuth();

  return (
    <header className="mb-8 flex items-center justify-between gap-4">
      <div>
        <h1 className="font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
          RAG Chat
        </h1>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          Upload a document, then ask it anything.
        </p>
      </div>

      {status === 'authenticated' && user && (
        <div className="flex items-center gap-3 text-sm text-stone-500 dark:text-stone-400">
          <span>{user.email}</span>
          <button
            type="button"
            onClick={() => void logout()}
            className="rounded-lg border border-stone-300 px-3 py-1 text-stone-600 transition hover:border-accent hover:text-accent dark:border-stone-700 dark:text-stone-300"
          >
            Log out
          </button>
        </div>
      )}
    </header>
  );
}
