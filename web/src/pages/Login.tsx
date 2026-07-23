/**
 * Login — password sign-in by default.
 *
 * Advanced tabs (auth token / redeem invite) only when
 * GET /api/onboard/demo returns showAdvancedLogin=true
 * (UTARUS_LOGIN_SHOW_ADVANCED=true).
 *
 * When open signup is enabled, shows a link to /signup.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { redeemInvite, loginWithPassword } from '../api.js';
import { setStoredSession } from '../auth.js';
import { Loader2, ShieldCheck, Copy, Check } from 'lucide-react';

interface LoginProps {
  onSuccess: () => void;
}

interface OnboardUiState {
  agentName: string;
  version?: string;
  openSignupEnabled: boolean;
  showAdvancedLogin: boolean;
}

type Tab = 'password' | 'token' | 'invite';

interface RedeemedCredentials {
  slug: string;
  displayName: string;
  contactEmail: string;
  presetPassword: string;
}

function emailFromQuery(): string {
  try {
    const q = new URLSearchParams(window.location.search).get('email');
    return q?.trim() || '';
  } catch {
    return '';
  }
}

export function Login({ onSuccess }: LoginProps) {
  const [tab, setTab] = useState<Tab>('password');
  const [ui, setUi] = useState<OnboardUiState>({
    agentName: 'Agent',
    openSignupEnabled: false,
    showAdvancedLogin: false,
  });
  const [demoError, setDemoError] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<RedeemedCredentials | null>(null);
  const [passwordPrefill, setPasswordPrefill] = useState<string | null>(
    emailFromQuery() || null,
  );

  useEffect(() => {
    fetch('/api/onboard/demo', { credentials: 'include' })
      .then((r) => r.json())
      .then(
        (
          b: {
            agentName?: string;
            version?: string;
            enabled?: boolean;
            openSignupEnabled?: boolean;
            showAdvancedLogin?: boolean;
            error?: string;
          },
        ) => {
          const agentName = b?.agentName || 'Agent';
          setUi({
            agentName,
            version: typeof b?.version === 'string' ? b.version : undefined,
            openSignupEnabled: b?.openSignupEnabled === true,
            showAdvancedLogin: b?.showAdvancedLogin === true,
          });
          if (b?.error) setDemoError(b.error);
          document.title = `${agentName} · Sign in`;
        },
      )
      .catch((err: unknown) => {
        setDemoError(err instanceof Error ? err.message : String(err));
        document.title = 'Sign in';
      });
  }, []);

  function continueToSignIn(creds: RedeemedCredentials) {
    setCredentials(null);
    setPasswordPrefill(creds.contactEmail || creds.slug);
    setTab('password');
  }

  const showTabs = ui.showAdvancedLogin;

  return (
    <div className="flex min-h-dvh items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <header className="mb-5 text-center">
          <h1 className="text-xl font-semibold text-slate-900">
            {ui.agentName}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Sign in to continue
          </p>
          {ui.version && (
            <p
              className="mt-1 font-mono text-[11px] text-slate-400"
              title="Utarus framework version"
            >
              v{ui.version}
            </p>
          )}
        </header>

        {credentials ? (
          <CredentialsPanel
            creds={credentials}
            onContinue={() => continueToSignIn(credentials)}
          />
        ) : (
          <>
            {showTabs && (
              <div className="mb-4 flex rounded-lg bg-slate-100 p-0.5 text-sm">
                <TabButton
                  active={tab === 'password'}
                  onClick={() => setTab('password')}
                >
                  Sign in
                </TabButton>
                <TabButton
                  active={tab === 'token'}
                  onClick={() => setTab('token')}
                >
                  Auth token
                </TabButton>
                <TabButton
                  active={tab === 'invite'}
                  onClick={() => setTab('invite')}
                >
                  Redeem invite
                </TabButton>
              </div>
            )}

            {(tab === 'password' || !showTabs) && (
              <PasswordForm
                onSuccess={onSuccess}
                prefillIdentifier={passwordPrefill}
              />
            )}
            {showTabs && tab === 'token' && <TokenForm onSuccess={onSuccess} />}
            {showTabs && tab === 'invite' && (
              <InviteForm onRedeemed={setCredentials} />
            )}
          </>
        )}

        {!credentials && (
          <footer className="mt-5 space-y-2 border-t border-slate-100 pt-4 text-center text-sm text-slate-600">
            {ui.openSignupEnabled && (
              <p>
                New here?{' '}
                <a
                  href="/signup"
                  className="font-medium text-blue-600 hover:text-blue-700"
                >
                  Create an account
                </a>
              </p>
            )}
          </footer>
        )}

        {demoError && (
          <p className="mt-3 text-xs text-slate-400">
            (config check: {demoError})
          </p>
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'flex-1 rounded-md py-1.5 font-medium transition ' +
        (active ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500')
      }
    >
      {children}
    </button>
  );
}

function PasswordForm({
  onSuccess,
  prefillIdentifier,
}: {
  onSuccess: () => void;
  prefillIdentifier: string | null;
}) {
  const [identifier, setIdentifier] = useState(prefillIdentifier ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (prefillIdentifier) setIdentifier(prefillIdentifier);
  }, [prefillIdentifier]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!identifier.trim()) throw new Error('Email or username is required.');
      if (!password) throw new Error('Password is required.');
      const json = await loginWithPassword(identifier.trim(), password);
      setStoredSession({
        type: json.type,
        slug: json.slug,
        displayName: json.displayName ?? json.slug,
      });
      onSuccess();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600">
          Email or username
        </span>
        <input
          type="text"
          autoComplete="username"
          autoFocus
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          placeholder="you@company.com"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600">
          Password
        </span>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          placeholder="••••••••"
        />
      </label>
      {error && (
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-slate-300"
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <ShieldCheck className="h-4 w-4" />
        )}
        Sign in
      </button>
    </form>
  );
}

function TokenForm({ onSuccess }: { onSuccess: () => void }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!token.trim()) throw new Error('Auth token is required.');
      const res = await fetch('/api/onboard/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth_token: token.trim() }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(b.error || b.message || `HTTP ${res.status}`);
      }
      const json = (await res.json()) as {
        type: 'user' | 'admin';
        slug: string;
        displayName?: string;
      };
      setStoredSession({
        type: json.type,
        slug: json.slug,
        displayName:
          json.displayName ?? (json.type === 'admin' ? 'admin' : json.slug),
      });
      onSuccess();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600">
          Auth token
        </span>
        <input
          type="password"
          autoComplete="current-password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          placeholder="660e8400-..."
        />
      </label>
      {error && (
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-slate-300"
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <ShieldCheck className="h-4 w-4" />
        )}
        Sign in
      </button>
    </form>
  );
}

function InviteForm({
  onRedeemed,
}: {
  onRedeemed: (creds: RedeemedCredentials) => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const trimmedName = displayName.trim();
      const trimmedCode = code.trim();
      if (!trimmedName) throw new Error('Display name is required.');
      if (trimmedName.length > 60)
        throw new Error('Display name is too long (max 60 chars).');
      if (!trimmedCode) throw new Error('Invite code is required.');

      const res = await redeemInvite(trimmedName, trimmedCode);
      onRedeemed({
        slug: res.slug,
        displayName: res.display_name || trimmedName,
        contactEmail: res.contact_email ?? '',
        presetPassword: res.preset_password ?? '',
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600">
          Display name
        </span>
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          placeholder="Alice Chen"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600">
          Invite code
        </span>
        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          placeholder="INV-XXXXXXXX"
        />
      </label>
      {error && (
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-slate-300"
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        Redeem & start
      </button>
    </form>
  );
}

function CredentialsPanel({
  creds,
  onContinue,
}: {
  creds: RedeemedCredentials;
  onContinue: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copyPassword() {
    try {
      await navigator.clipboard.writeText(creds.presetPassword);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* user can still read password */
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
        <p className="font-medium">Account created.</p>
        <p className="mt-1 text-xs text-emerald-800">
          Write these credentials down — the password is shown only once.
        </p>
      </div>
      <dl className="space-y-2 rounded-lg border border-slate-200 p-3 text-sm">
        <div>
          <dt className="text-xs font-medium text-slate-500">Display name</dt>
          <dd className="text-slate-900">{creds.displayName}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-slate-500">Username (slug)</dt>
          <dd className="font-mono text-slate-900">{creds.slug}</dd>
        </div>
        {creds.contactEmail && (
          <div>
            <dt className="text-xs font-medium text-slate-500">Email</dt>
            <dd className="font-mono text-slate-900">{creds.contactEmail}</dd>
          </div>
        )}
        <div>
          <dt className="text-xs font-medium text-slate-500">Password</dt>
          <dd className="flex items-center justify-between gap-2">
            <span className="font-mono text-slate-900">
              {creds.presetPassword}
            </span>
            <button
              type="button"
              onClick={copyPassword}
              className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50"
            >
              {copied ? (
                <span className="flex items-center gap-1">
                  <Check className="h-3 w-3" /> Copied
                </span>
              ) : (
                <span className="flex items-center gap-1">
                  <Copy className="h-3 w-3" /> Copy
                </span>
              )}
            </button>
          </dd>
        </div>
      </dl>
      <button
        type="button"
        onClick={onContinue}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
      >
        Continue to sign in
      </button>
    </div>
  );
}
