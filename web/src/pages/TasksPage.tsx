/**
 * Generic tasks list — data from domain apiBase.
 *
 * Contract:
 *   GET {apiBase} → { items: TaskItem[] }
 */

import { useCallback, useEffect, useState } from 'react';
import { List, Loader2, RefreshCw } from 'lucide-react';

export interface TaskItem {
  id: string;
  title: string;
  status: string;
  subtitle?: string;
  next_run_at?: string;
  last_run_at?: string | null;
  meta?: string;
}

interface TasksPageProps {
  apiBase: string;
  title: string;
  navigate: (path: string) => void;
}

function statusDot(status: string) {
  if (status === 'active') return 'bg-emerald-500';
  if (status === 'paused') return 'bg-slate-400';
  if (status === 'failed' || status === 'disabled') return 'bg-rose-500';
  return 'bg-amber-400';
}

export function TasksPage({ apiBase, title, navigate }: TasksPageProps) {
  const [items, setItems] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!apiBase) {
      setError('apiBase not configured for tasks page');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(apiBase, { credentials: 'include' });
      if (!res.ok) throw new Error(`Failed to load tasks (${res.status})`);
      const data = (await res.json()) as { items?: TaskItem[] };
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

  return (
    <div className="mx-auto max-w-3xl px-3 py-6 sm:px-4">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <List className="h-5 w-5 text-slate-700" />
          <h1 className="text-lg font-semibold text-slate-900">{title}</h1>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>

      <p className="mb-4 text-sm text-slate-600">
        Your scheduled account-manager work. Each user has their own list.
      </p>

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
          Nothing scheduled yet. In Telegram, try{' '}
          <code className="rounded bg-slate-100 px-1">/daily on</code> to create your personal daily
          check-in.
        </div>
      )}

      <ul className="space-y-2">
        {items.map((it) => (
          <li
            key={it.id}
            className="rounded-xl border border-slate-200 bg-white px-3 py-3 shadow-sm"
          >
            <div className="flex items-start gap-2">
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${statusDot(it.status)}`} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-slate-900">{it.title}</div>
                {it.subtitle && <div className="text-xs text-slate-500">{it.subtitle}</div>}
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
                  <span>Status: {it.status}</span>
                  {it.next_run_at && <span>Next: {new Date(it.next_run_at).toLocaleString()}</span>}
                  {it.last_run_at && <span>Last: {new Date(it.last_run_at).toLocaleString()}</span>}
                </div>
                {it.meta && <p className="mt-1 text-xs text-slate-600">{it.meta}</p>}
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
