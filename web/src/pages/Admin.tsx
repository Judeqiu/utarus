/**
 * Admin — invites / users / reports management.
 *
 * Spec: docs/webui-chat-design.md §7.6 (admin REST).
 *
 * Routes:
 *   GET    /api/admin/invites?filter=…
 *   POST   /api/admin/invites   { comment? }
 *   GET    /api/admin/users
 *   POST   /api/admin/admincodes
 *   GET    /api/admin/admincodes
 *   POST   /api/admin/admincodes/revoke
 *   POST   /api/admin/demomode  { enabled }
 *   GET    /api/admin/demomode
 *   GET    /api/admin/reports
 */

import { useEffect, useState } from 'react';
import { createInvite, listInvites, listUsers } from '../api.js';
import type { AdminUserSummary, InviteCode, SessionUser } from '../types.js';
import { ArrowLeft, Loader2, Sparkles } from 'lucide-react';

interface AdminPageProps {
  session: SessionUser;
  onBack: () => void;
}

interface AdminCode {
  code: string;
  created_at: string;
  comment?: string;
}

interface DemoState {
  enabled: boolean;
  updatedAt?: string;
}

interface UserReportRow {
  id: string;
  created_at: string;
  reporter_slug: string;
  text: string;
  category?: string;
}

export function AdminPage({ session, onBack }: AdminPageProps) {
  const [invites, setInvites] = useState<InviteCode[]>([]);
  const [users, setUsers] = useState<AdminUserSummary[]>([]);
  const [adminCodes, setAdminCodes] = useState<AdminCode[]>([]);
  const [reports, setReports] = useState<UserReportRow[]>([]);
  const [demo, setDemo] = useState<DemoState | null>(null);
  const [billingSlug, setBillingSlug] = useState('');
  const [billingView, setBillingView] = useState<{
    billing: Record<string, unknown> | null;
    entitlement: Record<string, unknown> | null;
  } | null>(null);
  const [billingEnabled, setBillingEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [iv, us, ac, dm, rp, billingCfg] = await Promise.all([
          listInvites('all'),
          listUsers(),
          listAdminCodes(),
          getDemoState(),
          listUserReports(),
          fetch('/api/billing/config', { credentials: 'include' })
            .then((r) => (r.ok ? r.json() : { enabled: false }))
            .catch(() => ({ enabled: false })),
        ]);
        if (cancelled) return;
        setInvites(iv);
        setUsers(us);
        setAdminCodes(ac);
        setDemo(dm);
        setReports(rp);
        setBillingEnabled(Boolean(billingCfg?.enabled));
      } catch (err: unknown) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCreateInvite() {
    try {
      const comment = window.prompt('Comment for this invite (optional):', '');
      if (comment === null) return;
      const created = await createInvite(comment || undefined);
      setInvites((prev) => [created, ...prev]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleCreateAdminCode() {
    try {
      const comment = window.prompt('Comment for this admin code (optional):', '');
      if (comment === null) return;
      const created = await createAdminCode(comment || undefined);
      setAdminCodes((prev) => [created, ...prev]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRevokeAdminCode(code: string) {
    if (!window.confirm(`Revoke admin code ${code}?`)) return;
    try {
      await revokeAdminCode(code);
      setAdminCodes((prev) => prev.filter((c) => c.code !== code));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleToggleDemo(next: boolean) {
    try {
      const updated = await setDemoMode(next);
      setDemo(updated);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleLoadBilling() {
    const slug = billingSlug.trim();
    if (!slug) return;
    try {
      setError(null);
      const res = await fetch(`/api/admin/billing/${encodeURIComponent(slug)}`, {
        credentials: 'include',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || body.error || `HTTP ${res.status}`);
      setBillingView({ billing: body.billing ?? null, entitlement: body.entitlement ?? null });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleComp() {
    const slug = billingSlug.trim();
    const planId = window.prompt('Plan id to comp (e.g. pro):', 'pro');
    if (!planId) return;
    const ack = window.confirm(
      'If this user has an active Stripe subscription, they may still be charged until you cancel it in Stripe. Continue?',
    );
    try {
      setError(null);
      const res = await fetch('/api/admin/billing/comp', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug,
          plan_id: planId,
          acknowledge_active_subscription: ack,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || body.error || `HTTP ${res.status}`);
      await handleLoadBilling();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRevokeComp() {
    const slug = billingSlug.trim();
    if (!window.confirm(`Revoke comp for ${slug}?`)) return;
    try {
      setError(null);
      const res = await fetch('/api/admin/billing/revoke-comp', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || body.error || `HTTP ${res.status}`);
      await handleLoadBilling();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleReconcile() {
    const slug = billingSlug.trim();
    try {
      setError(null);
      const res = await fetch('/api/admin/billing/reconcile', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || body.error || `HTTP ${res.status}`);
      await handleLoadBilling();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="min-h-dvh bg-slate-50">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2.5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
          >
            <ArrowLeft className="h-3 w-3" /> Back
          </button>
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-blue-600" />
            <span className="text-sm font-semibold text-slate-900">
              Admin · {session.displayName}
            </span>
          </div>
        </div>
      </header>

      {error && (
        <div className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-800">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12 text-sm text-slate-500">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <main className="mx-auto max-w-4xl px-4 py-6 space-y-8">
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">
                Invite codes ({invites.length})
              </h2>
              <button
                type="button"
                onClick={() => void handleCreateInvite()}
                className="rounded-lg bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
              >
                + New invite
              </button>
            </div>
            <CodeTable
              codes={invites.map((i) => ({
                code: i.code,
                created_at: i.created_at,
                comment: i.comment,
                state: i.used_at ? 'used' : 'unused',
                usedBy: i.used_by_slack ?? i.slug,
              }))}
            />
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">
                Admin onboard codes ({adminCodes.length})
              </h2>
              <button
                type="button"
                onClick={() => void handleCreateAdminCode()}
                className="rounded-lg bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
              >
                + New admin code
              </button>
            </div>
            <CodeTable
              codes={adminCodes.map((a) => ({
                code: a.code,
                created_at: a.created_at,
                comment: a.comment,
                state: '',
                usedBy: undefined,
                onRevoke: () => void handleRevokeAdminCode(a.code),
              }))}
            />
          </section>

          <section>
            <h2 className="mb-2 text-sm font-semibold text-slate-900">Demo mode</h2>
            {demo ? (
              <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2">
                <label className="inline-flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={demo.enabled}
                    onChange={(e) => void handleToggleDemo(e.target.checked)}
                  />
                  Enabled
                </label>
                {demo.updatedAt && (
                  <span className="text-xs text-slate-500">
                    updated {new Date(demo.updatedAt).toLocaleString()}
                  </span>
                )}
              </div>
            ) : (
              <p className="text-sm text-slate-500">No demo state available.</p>
            )}
          </section>

          {billingEnabled && (
            <section>
              <h2 className="mb-2 text-sm font-semibold text-slate-900">Billing</h2>
              <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    value={billingSlug}
                    onChange={(e) => setBillingSlug(e.target.value)}
                    placeholder="user slug"
                    className="rounded border border-slate-200 px-2 py-1 font-mono text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => void handleLoadBilling()}
                    className="rounded-lg bg-slate-800 px-2 py-1 text-xs font-medium text-white"
                  >
                    Load
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleComp()}
                    className="rounded-lg bg-blue-600 px-2 py-1 text-xs font-medium text-white"
                  >
                    Comp
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleRevokeComp()}
                    className="rounded-lg border border-slate-200 px-2 py-1 text-xs"
                  >
                    Revoke comp
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleReconcile()}
                    className="rounded-lg border border-slate-200 px-2 py-1 text-xs"
                  >
                    Reconcile
                  </button>
                </div>
                {billingView && (
                  <pre className="max-h-64 overflow-auto rounded bg-slate-50 p-2 text-[11px] text-slate-700">
                    {JSON.stringify(billingView, null, 2)}
                  </pre>
                )}
              </div>
            </section>
          )}

          <section>
            <h2 className="mb-2 text-sm font-semibold text-slate-900">
              Users ({users.length})
            </h2>
            <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
              <table className="w-full border-collapse text-sm">
                <thead className="bg-slate-100 text-xs text-slate-700">
                  <tr>
                    <th className="px-3 py-2 text-left">Slug</th>
                    <th className="px-3 py-2 text-left">Display name</th>
                    <th className="px-3 py-2 text-left">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.slug} className="border-t border-slate-100">
                      <td className="px-3 py-2 font-mono text-xs">{u.slug}</td>
                      <td className="px-3 py-2">{u.displayName}</td>
                      <td className="px-3 py-2 text-xs text-slate-500">
                        {new Date(u.createdAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h2 className="mb-2 text-sm font-semibold text-slate-900">
              User reports ({reports.length})
            </h2>
            {reports.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-200 bg-white px-3 py-4 text-center text-xs text-slate-400">
                No reports yet. Users can say &quot;report …&quot; in chat.
              </div>
            ) : (
              <div className="space-y-2">
                {reports.map((r) => (
                  <article
                    key={r.id}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-2.5"
                  >
                    <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span className="font-mono text-slate-700">{r.reporter_slug}</span>
                      {r.category && (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">
                          {r.category}
                        </span>
                      )}
                      <span>{new Date(r.created_at).toLocaleString()}</span>
                      <span className="font-mono text-[10px] text-slate-400">{r.id}</span>
                    </div>
                    <p className="whitespace-pre-wrap text-sm text-slate-800">{r.text}</p>
                  </article>
                ))}
              </div>
            )}
          </section>
        </main>
      )}
    </div>
  );
}

interface CodeTableRow {
  code: string;
  created_at: string;
  comment?: string;
  state: string;
  usedBy?: string;
  onRevoke?: () => void;
}

function CodeTable({ codes }: { codes: CodeTableRow[] }) {
  if (codes.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 bg-white px-3 py-4 text-center text-xs text-slate-400">
        No codes yet.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="w-full border-collapse text-xs">
        <thead className="bg-slate-100 text-slate-700">
          <tr>
            <th className="px-3 py-2 text-left">Code</th>
            <th className="px-3 py-2 text-left">State</th>
            <th className="px-3 py-2 text-left">Comment</th>
            <th className="px-3 py-2 text-left">Used by</th>
            <th className="px-3 py-2 text-left">Created</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {codes.map((c) => (
            <tr key={c.code} className="border-t border-slate-100">
              <td className="px-3 py-2 font-mono">{c.code}</td>
              <td className="px-3 py-2">{c.state}</td>
              <td className="px-3 py-2 text-slate-600">{c.comment ?? '—'}</td>
              <td className="px-3 py-2 text-slate-600">{c.usedBy ?? '—'}</td>
              <td className="px-3 py-2 text-slate-500">
                {new Date(c.created_at).toLocaleString()}
              </td>
              <td className="px-3 py-2">
                {c.onRevoke && (
                  <button
                    type="button"
                    onClick={c.onRevoke}
                    className="text-xs text-rose-600 hover:underline"
                  >
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── thin admin REST wrappers (kept here to keep api.ts focused on chat) ──

async function listAdminCodes(): Promise<AdminCode[]> {
  const res = await fetch('/api/admin/admincodes?filter=all', { credentials: 'include' });
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return (body.codes ?? []) as AdminCode[];
}

async function createAdminCode(comment?: string): Promise<AdminCode> {
  const res = await fetch('/api/admin/admincodes', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment }),
  });
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body as AdminCode;
}

async function revokeAdminCode(code: string): Promise<void> {
  const res = await fetch('/api/admin/admincodes/revoke', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
}

async function getDemoState(): Promise<DemoState> {
  const res = await fetch('/api/admin/demomode', { credentials: 'include' });
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body as DemoState;
}

async function setDemoMode(enabled: boolean): Promise<DemoState> {
  const res = await fetch('/api/admin/demomode', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body as DemoState;
}

async function listUserReports(): Promise<UserReportRow[]> {
  const res = await fetch('/api/admin/reports', { credentials: 'include' });
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return (body.reports ?? []) as UserReportRow[];
}
