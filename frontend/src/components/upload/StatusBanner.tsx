import { useEffect } from 'react';

interface StatusBannerProps {
  variant: 'success' | 'error';
  message: string;
  onDismiss: () => void;
}

export function StatusBanner({ variant, message, onDismiss }: StatusBannerProps) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 6000);
    return () => clearTimeout(timer);
  }, [message, onDismiss]);

  const isSuccess = variant === 'success';

  return (
    <div
      role="status"
      className={`flex items-start justify-between gap-3 rounded-2xl border px-4 py-3 text-sm shadow-soft ${
        isSuccess
          ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200'
          : 'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200'
      }`}
    >
      <span>{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 text-current opacity-70 hover:opacity-100"
      >
        ✕
      </button>
    </div>
  );
}
