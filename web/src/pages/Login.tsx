/**
 * Login — three tabs: username+password (default), auth_token, redeem invite.
 *
 *  1. Existing user (default): slug/email + password → /api/onboard/login.
 *  2. Existing user (token): paste auth_token → /api/onboard/login.
 *  3. New user (invite): display name + INV-XXXXXXXX → /api/onboard/redeem.
 *     The redeem response surfaces a one-shot preset_password so the user
 *     can write it down and sign in next time.
 *
 * Demo mode: if GET /api/onboard/demo shows enabled=true, the invite form
 * collapses to "Try the demo" (display name only, code=null). The demo flow
 * also surfaces the preset password on success.
 *
 * Admin username/password login is not yet wired (utarus admin auth is
 * env-driven only, not exported). The token-tab admin checkbox surfaces a
 * clear error.
 *
 * Spec: docs/webui-chat-design.md §10.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { redeemInvite, loginWithPassword } from '../api.js';
import { setStoredSession } from '../auth.js';
import { Loader2, ShieldCheck, Copy, Check } from 'lucide-react';

interface LoginProps {
  onSuccess: () => void;
}

interface DemoState {
  enabled: boolean;
  agentName: string;
  version?: string;
}

type Tab = 'password' | 'token' | 'invite';

interface RedeemedCredentials {
  slug: string;
  displayName: string;
  contactEmail: string;
  presetPassword: string;
}

export function Login({ onSuccess }: LoginProps) {
  const [tab, setTab] = useState<Tab>('password');
  const [demo, setDemo] = useState<DemoState | null>(null);
  const [agentName, setAgentName] = useState('Agent');
  const [version, setVersion] = useState<string | null>(null);
  const [demoError, setDemoError] = useState<string | null>(null);
  // When the InviteForm surfaces credentials, we render the credentials panel
  // in place of the tab content until the user clicks "Continue".
  const [credentials, setCredentials] = useState<RedeemedCredentials | null>(null);
  // Pre-fill the password tab when the user clicks "Continue to sign in"
  // from the credentials panel.
  const [passwordPrefill, setPasswordPrefill] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/onboard/demo', { credentials: 'include' })
      .then((r) => r.json())
      .then((b: DemoState & { error?: string }) => {
        if (b?.agentName) setAgentName(b.agentName);
        if (typeof b?.version === 'string' && b.version) setVersion(b.version);
        if (b && typeof b.enabled === 'boolean') {
          setDemo({
            enabled: b.enabled,
            agentName: b.agentName ?? 'Agent',
            version: b.version,
          });
        } else if (b?.error) {
          setDemoError(b.error);
        }
        const name = b?.agentName || 'Agent';
        document.title = `${name} · Sign in`;
      })
      .catch((err: unknown) => {
        setDemoError(err instanceof Error ? err.message : String(err));
        document.title = 'Sign in';
      });
  }, []);

  function handleRedeemed(creds: RedeemedCredentials) {
    setCredentials(creds);
  }

  function continueToSignIn(creds: RedeemedCredentials) {
    setCredentials(null);
    setPasswordPrefill(creds.slug);
    setTab('password');
  }

  if (demo?.enabled && tab !== 'password' && tab !== 'token') {
    return (
      <DemoLogin
        agentName={agentName}
        version={version}
        onRedeemed={(creds) => setCredentials(creds)}
        credentials={credentials}
        onContinue={continueToSignIn}
      />
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <header className="mb-5 text-center">
          <h1 className="text-xl font-semibold text-slate-900">{agentName} · Web</h1>
          <p className="mt-1 text-sm text-slate-500">
            Sign in to chat with your agent.
          </p>
          {version && (
            <p className="mt-1 font-mono text-[11px] text-slate-400" title="Utarus framework version">
              v{version}
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
            <div className="mb-4 flex rounded-lg bg-slate-100 p-0.5 text-sm">
              <TabButton active={tab === 'password'} onClick={() => setTab('password')}>
                Sign in
              </TabButton>
              <TabButton active={tab === 'token'} onClick={() => setTab('token')}>
                Auth token
              </TabButton>
              <TabButton active={tab === 'invite'} onClick={() => setTab('invite')}>
                Redeem invite
              </TabButton>
            </div>

            {tab === 'password' && (
              <PasswordForm
                onSuccess={onSuccess}
                prefillIdentifier={passwordPrefill}
              />
            )}
            {tab === 'token' && <TokenForm onSuccess={onSuccess} />}
            {tab === 'invite' && (
              <InviteForm onRedeemed={handleRedeemed} />
            )}
          </>
        )}

        {demoError && (
          <p className="mt-3 text-xs text-slate-400">(demo state check skipped: {demoError})</p>
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

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!identifier.trim()) throw new Error('Username (slug or email) is required.');
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
          Username
        </span>
        <input
          type="text"
          autoComplete="username"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          placeholder="slug or email"
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
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
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
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-slate-300"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
        Sign in
      </button>
    </form>
  );
}

function TokenForm({ onSuccess }: { onSuccess: () => void }) {
  const [token, setToken] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    try {
      if (isAdmin) {
        throw new Error('Admin username/password login is not supported via web yet. Paste your auth_token instead.');
      }
      if (!token.trim()) {
        throw new Error('Auth token is required.');
      }
      const body = { auth_token: token.trim() };
      const res = await fetch('/api/onboard/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
        displayName: json.displayName ?? (json.type === 'admin' ? 'admin' : json.slug),
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
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          placeholder="660e8400-..."
        />
      </label>

      <label className="flex items-center gap-2 text-xs text-slate-600">
        <input
          type="checkbox"
          checked={isAdmin}
          onChange={(e) => setIsAdmin(e.target.checked)}
        />
        Admin login
      </label>

      {error && (
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-slate-300"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
        {isAdmin ? 'Sign in as admin' : 'Sign in'}
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
      if (trimmedName.length > 60) throw new Error('Display name is too long (max 60 chars).');
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
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
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
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
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
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-slate-300"
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
      // Fall through silently — user can still read+type the password.
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
            <dt className="text-xs font-medium text-slate-500">Email (also works as username)</dt>
            <dd className="font-mono text-slate-900">{creds.contactEmail}</dd>
          </div>
        )}
        <div>
          <dt className="text-xs font-medium text-slate-500">Password</dt>
          <dd className="flex items-center justify-between gap-2">
            <span className="font-mono text-slate-900">{creds.presetPassword}</span>
            <button
              type="button"
              onClick={copyPassword}
              className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50"
            >
              {copied ? (
                <span className="flex items-center gap-1"><Check className="h-3 w-3" /> Copied</span>
              ) : (
                <span className="flex items-center gap-1"><Copy className="h-3 w-3" /> Copy</span>
              )}
            </button>
          </dd>
        </div>
      </dl>
      <button
        type="button"
        onClick={onContinue}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
      >
        Continue to sign in
      </button>
    </div>
  );
}

function DemoLogin({
  agentName,
  version,
  onRedeemed,
  credentials,
  onContinue,
}: {
  agentName: string;
  version: string | null;
  onRedeemed: (creds: RedeemedCredentials) => void;
  credentials: RedeemedCredentials | null;
  onContinue: (creds: RedeemedCredentials) => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const trimmed = displayName.trim();
      if (!trimmed) throw new Error('Display name is required.');
      if (trimmed.length > 60) throw new Error('Display name is too long (max 60 chars).');
      const res = await redeemInvite(trimmed, null);
      onRedeemed({
        slug: res.slug,
        displayName: res.display_name || trimmed,
        contactEmail: res.contact_email ?? '',
        presetPassword: res.preset_password ?? '',
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (credentials) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-slate-50 px-4">
        <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <CredentialsPanel creds={credentials} onContinue={() => onContinue(credentials)} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-slate-50 px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-md space-y-3 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <header className="mb-2 text-center">
          <h1 className="text-xl font-semibold text-slate-900">{agentName} · Demo</h1>
          <p className="mt-1 text-sm text-slate-500">
            Enter your name to try the agent.
          </p>
          {version && (
            <p className="mt-1 font-mono text-[11px] text-slate-400" title="Utarus framework version">
              v{version}
            </p>
          )}
        </header>
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          placeholder="Your name"
        />
        {error && (
          <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-slate-300"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          Try the demo
        </button>
      </form>
    </div>
  );
}
