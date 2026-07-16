/**
 * Generic notifications inbox — data from domain apiBase.
 *
 * Contract:
 *   GET  {apiBase}              → { items: NotificationItem[] }
 *   POST {apiBase}/:id/read     → { ok: true }
 *   GET  {apiBase}/unread-count → { count: number }  (nav badge)
 */

import { useCallback, useEffect, useState } from 'react';
import { Bell, CheckCheck, ExternalLink, Loader2, RefreshCw } from 'lucide-react';

export interface NotificationItem {
  id: string;
  title: string;
  body?: string;
  severity?: 'info' | 'medium' | 'high';
  created_at: string;
  read: boolean;
  href?: string;
}

interface NotificationsPageProps {
  apiBase: string;
  title: string;
  navigate: (path: string) => void;
  onChanged?: () => void;
}

function severityClass(s?: string) {
  if (s === 'high') return 'border-rose-200 bg-rose-50 text-rose-800';
  if (s === 'medium') return 'border-amber-200 bg-amber-50 text-amber-900';
  return 'border-slate-200 bg-white text-slate-800';
}

export function NotificationsPage({ apiBase, title, navigate, onChanged }: NotificationsPageProps) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!apiBase) {
      setError('apiBase not configured for notifications page');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(apiBase, { credentials: 'include' });
      if (!res.ok) throw new Error(`Failed to load notifications (${res.status})`);
      const data = (await res.json()) as { items?: NotificationItem[] };
      setItems(Array.isArray(data.items) ? data.items : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    void load();
  }, [load]);

  const markRead = async (id: string) => {
    try {
      const res = await fetch(`${apiBase}/${encodeURIComponent(id)}/read`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`mark read failed (${res.status})`);
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, read: true } : it)));
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const markAllRead = async () => {
    const unread = items.filter((i) => !i.read);
    for (const it of unread) {
      await markRead(it.id);
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-3 py-6 sm:px-4">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Bell className="h-5 w-5 text-slate-700" />
          <h1 className="text-lg font-semibold text-slate-900">{title}</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
          <button
            type="button"
            onClick={() => void markAllRead()}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
          >
            <CheckCheck className="h-3.5 w-3.5" /> Mark all read
          </button>
        </div>
      </div>

      {loading && (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
        </div>
      )}

      {error && (
        <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </div>
      )}

      {!loading && !error && items.length === 0 && (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white px-4 py-12 text-center text-sm text-slate-500">
          No notifications yet. When your account manager has something to share, it will show up
          here.
        </div>
      )}

      <ul className="space-y-2">
        {items.map((it) => (
          <li
            key={it.id}
            className={`rounded-xl border px-3 py-3 shadow-sm ${severityClass(it.severity)} ${
              it.read ? 'opacity-70' : ''
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">{it.title}</span>
                  {!it.read && (
                    <span className="rounded-full bg-slate-900 px-1.5 text-[10px] font-medium text-white">
                      new
                    </span>
                  )}
                </div>
                {it.body && <p className="mt-1 whitespace-pre-wrap text-sm opacity-90">{it.body}</p>}
                <p className="mt-2 text-[11px] opacity-60">
                  {new Date(it.created_at).toLocaleString()}
                </p>
              </div>
              <div className="flex shrink-0 flex-col gap-1">
                {!it.read && (
                  <button
                    type="button"
                    onClick={() => void markRead(it.id)}
                    className="rounded-md border border-slate-300 bg-white/80 px-2 py-1 text-[11px] hover:bg-white"
                  >
                    Mark read
                  </button>
                )}
                {it.href && (
                  <a
                    href={it.href}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center justify-center gap-0.5 rounded-md border border-slate-300 bg-white/80 px-2 py-1 text-[11px] hover:bg-white"
                  >
                    Open <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>

      <p className="mt-6 text-center text-xs text-slate-400">
        <button type="button" className="hover:underline" onClick={() => navigate('/')}>
          Back to chat
        </button>
      </p>
    </div>
  );
}
