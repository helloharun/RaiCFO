import { useState, type FormEvent } from 'react';
import { BarChart3, Lock } from 'lucide-react';
import { api } from '../api';

export interface SessionInfo {
  authenticated: boolean;
  username?: string;
  csrfToken?: string;
  idleMinutes?: number;
}

export default function Login({ onLogin, notice }: { onLogin: (s: SessionInfo) => void; notice?: string | null }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const s = await api<SessionInfo>('/auth/login', { body: { username: username.trim(), password } });
      setPassword('');
      onLogin(s);
    } catch (err) {
      setError((err as Error).message);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <form onSubmit={submit} className="card w-full max-w-sm p-6" autoComplete="on">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-600 text-white">
            <BarChart3 size={22} />
          </div>
          <div>
            <h1 className="text-lg font-semibold leading-tight">Personal Finance HQ</h1>
            <p className="text-xs text-slate-500">Sign in to your books</p>
          </div>
        </div>
        {notice && <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{notice}</div>}
        {error && (
          <div role="alert" className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {error}
          </div>
        )}
        <label className="label" htmlFor="username">Username</label>
        <input id="username" name="username" className="input mb-3" autoComplete="username" autoFocus required maxLength={256} value={username} onChange={(e) => setUsername(e.target.value)} />
        <label className="label" htmlFor="password">Password</label>
        <input id="password" name="password" type="password" className="input mb-5" autoComplete="current-password" required maxLength={256} value={password} onChange={(e) => setPassword(e.target.value)} />
        <button type="submit" className="btn-primary w-full justify-center" disabled={busy || !username || !password}>
          <Lock size={16} /> {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="mt-4 text-center text-xs text-slate-400">Single-user app. Credentials are configured in server/.env.</p>
      </form>
    </div>
  );
}
