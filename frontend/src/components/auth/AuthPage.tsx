import { useState } from 'react';
import { LoginForm } from './LoginForm';
import { RegisterForm } from './RegisterForm';
import { Header } from '../layout/Header';

export function AuthPage() {
  const [mode, setMode] = useState<'login' | 'register'>('login');

  return (
    <div className="min-h-screen bg-stone-50 px-4 py-10 dark:bg-stone-950">
      <div className="mx-auto flex max-w-sm flex-col gap-6">
        <Header />
        <section className="rounded-2xl border border-stone-200 bg-white/60 p-5 shadow-soft dark:border-stone-800 dark:bg-stone-900/60">
          {mode === 'login' ? (
            <LoginForm onSwitchToRegister={() => setMode('register')} />
          ) : (
            <RegisterForm onSwitchToLogin={() => setMode('login')} />
          )}
        </section>
      </div>
    </div>
  );
}
