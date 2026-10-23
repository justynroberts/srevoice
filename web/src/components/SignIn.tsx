import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { VoiceRing } from './Stage';

const silent = () => 0;
const noSpectrum = () => new Uint8Array();

/**
 * The console's front door: the stage's black, Paige's ring at rest, and a
 * username and password. Lockouts come back from the server as 429s with a
 * wait, shown as a countdown so a locked-out operator knows when to retry.
 */
export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const userRef = useRef<HTMLInputElement>(null);

  useEffect(() => userRef.current?.focus(), []);

  useEffect(() => {
    if (lockedUntil <= Date.now()) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [lockedUntil]);

  const remaining = Math.max(0, Math.ceil((lockedUntil - now) / 1000));
  const locked = remaining > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || locked || !username || !password) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/login', { username, password });
      onSignedIn();
    } catch (err) {
      setPassword('');
      if (err instanceof ApiError && err.status === 429) {
        const seconds = Number((err.body as { retryAfterSeconds?: number } | null)?.retryAfterSeconds) || 60;
        setLockedUntil(Date.now() + seconds * 1000);
        setNow(Date.now());
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const field =
    'w-full rounded-[4px] border border-[#2a3136] bg-black px-3.5 py-3 text-[16px] text-[#eef3f2] placeholder:text-[#56636a] transition-colors focus:border-accent focus:outline-none disabled:opacity-50';

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center overflow-hidden bg-black px-6">
      <div className="pointer-events-none absolute inset-0 opacity-70" aria-hidden>
        <VoiceRing
          activity="offline"
          muted={false}
          getOutputVolume={silent}
          getInputVolume={silent}
          getOutputFrequency={noSpectrum}
          radius={0.24}
          moteCount={40}
        />
      </div>

      <form onSubmit={submit} className="relative flex w-full max-w-[320px] flex-col gap-3">
        <h1 className="mb-2 text-center text-[clamp(22px,3vmin,30px)] font-light tracking-[-0.01em] text-[#eef3f2]">
          Sign in to talk to Paige
        </h1>
        <label className="sr-only" htmlFor="signin-user">
          Username
        </label>
        <input
          ref={userRef}
          id="signin-user"
          className={field}
          autoComplete="username"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          disabled={busy || locked}
        />
        <label className="sr-only" htmlFor="signin-password">
          Password
        </label>
        <input
          id="signin-password"
          className={field}
          type="password"
          autoComplete="current-password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy || locked}
        />
        <button
          type="submit"
          disabled={busy || locked || !username || !password}
          className="mt-1 rounded-[4px] bg-accent px-4 py-3 text-[15px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? 'Signing in…' : locked ? `Locked — try again in ${formatWait(remaining)}` : 'Sign in'}
        </button>
        <p className="min-h-[1.5em] text-center text-[13px] text-warn" role="alert">
          {error ?? ''}
        </p>
      </form>

      <img
        src="/brand/pagerduty-wordmark.png"
        alt="PagerDuty"
        draggable={false}
        className="pointer-events-none absolute bottom-[4vmin] left-[4vmin] h-[clamp(18px,2.4vmin,26px)] w-auto select-none opacity-80"
      />
    </div>
  );
}

function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}
