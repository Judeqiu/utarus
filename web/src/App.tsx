/**
 * App — top-level router.
 *
 * Routing is path-based with a tiny client-side switch:
 *   /login           → <Login>
 *   /admin           → <Admin>      (admin sessions only)
 *   /                → <Chat>       (default; requires session)
 *
 * On mount, the App validates the session by hitting GET /api/chat/agent.
 * If 401 → Login. If ok → render the right page from window.location.pathname.
 */

import { useEffect, useState } from 'react';
import { fetchAgentStatus, getStoredSession, setStoredSession, clearStoredSession } from './auth.js';
import type { SessionUser } from './types.js';
import { Login } from './pages/Login.js';
import { ChatPage } from './pages/Chat.js';
import { AdminPage } from './pages/Admin.js';
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

  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    fetchAgentStatus(abort.signal)
      .then(() => {
        if (cancelled) return;
        // Session cookie is valid. Prefer the stored session for displayName
        // (the /agent endpoint doesn't return it in Phase 1 — only slug + isStreaming).
        const stored = getStoredSession();
        const path = currentPath();
        const slugFromPath = path.startsWith('/admin') ? null : null;
        if (stored) {
          setState({ kind: 'auth', session: stored });
        } else {
          // Cookie is valid but we have no localStorage. Reconstruct a
          // minimal user session from /agent status. The slug is the only
          // field strictly required; displayName is best-effort.
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
          void slugFromPath;
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.toLowerCase().includes('unauthorized')) {
          clearStoredSession();
          setState({ kind: 'unauth' });
        } else {
          // Treat unexpected errors as unauth — server is unreachable or broken.
          setState({ kind: 'unauth' });
        }
      });
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, []);

  // Listen for popstate so back/forward works.
  useEffect(() => {
    const onPop = () => setState((s) => (s.kind === 'auth' ? { ...s } : s));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

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
          // Re-validate after login; the cookie is now set.
          const stored = getStoredSession();
          if (stored) {
            setState({ kind: 'auth', session: stored });
            navigate('/');
          } else {
            setState({ kind: 'boot' });
          }
        }}
      />
    );
  }

  const path = currentPath();
  if (path.startsWith('/admin')) {
    if (state.session.type !== 'admin') {
      return (
        <div className="flex min-h-dvh items-center justify-center bg-slate-50 text-sm text-slate-600">
          Admins only. <button onClick={() => navigate('/')} className="ml-2 text-blue-600 hover:underline">Back to chat</button>
        </div>
      );
    }
    return <AdminPage session={state.session} onBack={() => navigate('/')} />;
  }

  return <ChatPage session={state.session} />;
}
