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
    fetchAgentStatus(abort.signal)
      .then(() => {
        if (cancelled) return;
        const stored = getStoredSession();
        if (stored) {
          setState({ kind: 'auth', session: stored });
        } else {
          fetchAgentStatus()
            .then((status) => {
              if (cancelled) return;
              const session: SessionUser = {
                type: 'user',
                slug: status.slug,
                displayName: status.displayName,
              };
              setStoredSession(session);
              setState({ kind: 'auth', session });
            })
            .catch(() => {
              if (cancelled) return;
              setState({ kind: 'unauth' });
            });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.toLowerCase().includes('unauthorized')) {
          clearStoredSession();
          setState({ kind: 'unauth' });
        } else {
          setState({ kind: 'unauth' });
        }
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
      <div className="flex min-h-dvh items-center justify-center bg-slate-50">
        <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
      </div>
    );
  }
  if (state.kind === 'unauth') {
    return (
      <Login
        onSuccess={() => {
          const stored = getStoredSession();
          if (stored) {
            setState({ kind: 'auth', session: stored });
            // Prefer domain default via shell after first manifest load; start at /
            go('/');
          } else {
            setState({ kind: 'boot' });
          }
        }}
      />
    );
  }

  return <Shell session={state.session} path={path} navigate={go} />;
}
