/**
 * App — top-level router.
 *
 *   /login           → <Login>
 *   authenticated    → <Shell> (nav + Chat / domain pages / Admin)
 */

import { useEffect, useState } from 'react';
import { fetchAgentStatus, getStoredSession, setStoredSession, clearStoredSession } from './auth.js';
import type { SessionUser } from './types.js';
import { Login } from './pages/Login.js';
import { Shell } from './pages/Shell.js';
import { Loader2 } from 'lucide-react';

type AppState =
  | { kind: 'boot' }
  | { kind: 'unauth' }
  | { kind: 'auth'; session: SessionUser };

function currentPath(): string {
  return window.location.pathname;
}

function navigate(path: string) {
  if (currentPath() !== path) {
    window.history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
}

export function App() {
  const [state, setState] = useState<AppState>({ kind: 'boot' });
  const [path, setPath] = useState(currentPath);

  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    // Always validate against the server cookie. Never trust localStorage alone —
    // signup/logout can clear the cookie while leaving utarus_session_user set,
    // which produced "logged in" UI with manifest/chat 401s.
    fetchAgentStatus(abort.signal)
      .then((status) => {
        if (cancelled) return;
        if (!status.slug?.trim()) {
          clearStoredSession();
          setState({ kind: 'unauth' });
          return;
        }
        const stored = getStoredSession();
        const session: SessionUser = {
          type:
            stored?.type === 'admin' && stored.slug === status.slug
              ? 'admin'
              : 'user',
          slug: status.slug,
          displayName: status.displayName || status.slug,
        };
        setStoredSession(session);
        setState({ kind: 'auth', session });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (abort.signal.aborted) return;
        clearStoredSession();
        setState({ kind: 'unauth' });
        void err;
      });
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, []);

  useEffect(() => {
    const onPop = () => setPath(currentPath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = (p: string) => {
    navigate(p);
    setPath(p);
  };

  if (state.kind === 'boot') {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-white">
        <Loader2 className="h-6 w-6 animate-spin text-stone-400" />
      </div>
    );
  }
  if (state.kind === 'unauth') {
    return (
      <Login
        onSuccess={() => {
          // Full navigation so the session cookie is definitely attached and
          // boot re-validates via /api/chat/agent (avoids stale client state).
          window.location.assign('/');
        }}
      />
    );
  }

  return <Shell session={state.session} path={path} navigate={go} />;
}
