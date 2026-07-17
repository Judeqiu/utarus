/**
 * Authenticated shell — top nav from /api/webui/manifest + page outlet.
 */

import { useCallback, useEffect, useState } from 'react';
import type { SessionUser } from '../types.js';
import { logout } from '../auth.js';
import { ChatPage } from './Chat.js';
import { AdminPage } from './Admin.js';
import { NotificationsPage } from './NotificationsPage.js';
import { TasksPage } from './TasksPage.js';
import {
  Bell,
  LayoutDashboard,
  List,
  Loader2,
  LogOut,
  MessageSquare,
  Shield,
} from 'lucide-react';

export interface ManifestNavItem {
  id: string;
  label: string;
  path: string;
  icon?: string;
  order?: number;
  adminOnly?: boolean;
  badgePath?: string;
  framework?: boolean;
}

export interface ManifestRoute {
  path: string;
  pageKind: 'notifications' | 'tasks' | 'iframe';
  apiBase?: string;
  iframeSrc?: string;
  title?: string;
}

export interface WebUiManifest {
  agentKey: string | null;
  productName: string;
  defaultPath: string;
  nav: ManifestNavItem[];
  routes: ManifestRoute[];
}

interface ShellProps {
  session: SessionUser;
  path: string;
  navigate: (path: string) => void;
}

function iconFor(name?: string) {
  switch (name) {
    case 'bell':
      return Bell;
    case 'layout-dashboard':
      return LayoutDashboard;
    case 'list':
      return List;
    case 'shield':
      return Shield;
    case 'message-square':
    default:
      return MessageSquare;
  }
}

function matchRoute(path: string, routes: ManifestRoute[]): ManifestRoute | null {
  for (const r of routes) {
    if (r.path === path) return r;
    // prefix match for /tasks/:id later
    if (path.startsWith(r.path + '/')) return r;
  }
  return null;
}

export function Shell({ session, path, navigate }: ShellProps) {
  const [manifest, setManifest] = useState<WebUiManifest | null>(null);
  const [badges, setBadges] = useState<Record<string, number>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadManifest = useCallback(async () => {
    try {
      const res = await fetch('/api/webui/manifest', { credentials: 'include' });
      if (!res.ok) throw new Error(`manifest ${res.status}`);
      const data = (await res.json()) as WebUiManifest;
      setManifest(data);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      // Fallback: chat only
      setManifest({
        agentKey: null,
        productName: 'Agent',
        defaultPath: '/',
        nav: [
          { id: 'chat', label: 'Chat', path: '/', icon: 'message-square', framework: true },
        ],
        routes: [],
      });
    }
  }, []);

  useEffect(() => {
    void loadManifest();
  }, [loadManifest]);

  // Badge polling
  useEffect(() => {
    if (!manifest) return;
    let cancelled = false;
    const poll = async () => {
      const next: Record<string, number> = {};
      await Promise.all(
        manifest.nav
          .filter((n) => n.badgePath)
          .map(async (n) => {
            try {
              const res = await fetch(n.badgePath!, { credentials: 'include' });
              if (!res.ok) return;
              const data = (await res.json()) as { count?: number };
              if (typeof data.count === 'number') next[n.id] = data.count;
            } catch {
              /* ignore badge errors */
            }
          }),
      );
      if (!cancelled) setBadges(next);
    };
    void poll();
    const t = setInterval(() => void poll(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [manifest]);

  // After login (session flag), land on domain defaultPath once if configured.
  useEffect(() => {
    if (!manifest?.defaultPath || manifest.defaultPath === '/') return;
    const ok = manifest.nav.some((n) => n.path === manifest.defaultPath);
    if (!ok) return;
    try {
      if (sessionStorage.getItem('utarus_default_landed') === '1') return;
      // Only auto-land if we are on chat home
      if (path !== '/' && path !== '') return;
      sessionStorage.setItem('utarus_default_landed', '1');
      navigate(manifest.defaultPath);
    } catch {
      /* private mode */
    }
  }, [manifest, path, navigate]);

  if (!manifest) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-white">
        <Loader2 className="h-6 w-6 animate-spin text-stone-400" />
      </div>
    );
  }

  if (path.startsWith('/admin')) {
    if (session.type !== 'admin') {
      return (
        <div className="flex min-h-dvh items-center justify-center bg-white text-sm text-stone-600">
          Admins only.{' '}
          <button onClick={() => navigate('/')} className="ml-2 text-stone-900 underline hover:text-stone-600">
            Back to chat
          </button>
        </div>
      );
    }
    return <AdminPage session={session} onBack={() => navigate('/')} />;
  }

  const route = matchRoute(path, manifest.routes);
  const showChat = path === '/' || path === '';

  return (
    <div className="flex min-h-dvh flex-col bg-white">
      <header className="sticky top-0 z-20 border-b border-stone-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-12 max-w-6xl items-center gap-3 px-3 sm:px-4">
          <div className="truncate font-serif text-sm font-semibold text-stone-900">
            {manifest.productName}
          </div>
          <nav className="flex flex-1 items-center gap-1 overflow-x-auto">
            {manifest.nav.map((item) => {
              const Icon = iconFor(item.icon);
              const active =
                item.path === '/'
                  ? showChat
                  : path === item.path || path.startsWith(item.path + '/');
              const badge = badges[item.id] ?? 0;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => navigate(item.path)}
                  className={`relative inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
                    active
                      ? 'bg-stone-900 text-white'
                      : 'text-stone-600 hover:bg-stone-100 hover:text-stone-900'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span>{item.label}</span>
                  {badge > 0 && (
                    <span
                      className={`ml-0.5 min-w-[1.1rem] rounded-full px-1 text-[10px] font-semibold leading-4 ${
                        active ? 'bg-white text-stone-900' : 'bg-rose-500 text-white'
                      }`}
                    >
                      {badge > 99 ? '99+' : badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
          <div className="hidden text-xs text-stone-500 sm:block">
            {session.displayName || session.slug}
          </div>
          <button
            type="button"
            onClick={() => void logout()}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-stone-600 hover:bg-stone-100"
            title="Log out"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
        {loadError && (
          <div className="border-t border-amber-100 bg-amber-50 px-3 py-1 text-center text-[11px] text-amber-800">
            Manifest fallback: {loadError}
          </div>
        )}
      </header>

      <main className="flex min-h-0 flex-1 flex-col">
        {showChat && <ChatPage session={session} />}
        {!showChat && route?.pageKind === 'notifications' && (
          <NotificationsPage
            apiBase={route.apiBase || ''}
            title={route.title || 'Notifications'}
            navigate={navigate}
            onChanged={() => {
              // force badge refresh
              setManifest((m) => (m ? { ...m } : m));
            }}
          />
        )}
        {!showChat && route?.pageKind === 'tasks' && (
          <TasksPage apiBase={route.apiBase || ''} title={route.title || 'Tasks'} navigate={navigate} />
        )}
        {!showChat && route?.pageKind === 'iframe' && route.iframeSrc && (
          <iframe title={route.title || 'Domain'} src={route.iframeSrc} className="h-[calc(100dvh-3rem)] w-full border-0" />
        )}
        {!showChat && !route && (
          <div className="flex min-h-[50vh] flex-col items-center justify-center gap-2 text-sm text-stone-600">
            <p>Page not found.</p>
            <button type="button" className="text-stone-900 underline hover:text-stone-600" onClick={() => navigate('/')}>
              Back to chat
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
