/**
 * User Billing page — plan status, upgrade (Checkout), manage (Portal).
 * Polls entitlement briefly after checkout=success until paid plan appears.
 */

import { useCallback, useEffect, useState } from 'react';
import type { SessionUser } from '../types.js';
import { ArrowLeft, CreditCard, Loader2 } from 'lucide-react';

interface BillingPageProps {
  session: SessionUser;
  onBack: () => void;
}

interface BillingStatus {
  admin?: boolean;
  unlimited?: boolean;
  message?: string;
  entitlement?: {
    plan_id: string;
    status: string;
    source: string;
    display_name: string;
    current_period_end?: string | null;
    intro_trial_ends_at?: string | null;
    has_stripe_customer?: boolean;
  };
  usage?: {
    period: string;
    llm_total_tokens: number;
    llm_cap: number | null;
  };
  defaultPaidPlan?: {
    id: string;
    display_name: string;
    caps_summary: { llm_total_tokens: number };
  };
  trialPeriodDays?: number;
  introTrialDays?: number;
  stripeTrialDays?: number;
}

export function BillingPage({ session, onBack }: BillingPageProps) {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pollHint, setPollHint] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/billing/status', { credentials: 'include' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body.message || body.error || `HTTP ${res.status}`);
    }
    setStatus(body as BillingStatus);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load()
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  // Success poll after Checkout redirect
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('checkout') !== 'success') return;

    setPollHint('Confirming payment…');
    let attempts = 0;
    const max = 15;
    const t = setInterval(() => {
      attempts += 1;
      void load()
        .then(() => {
          setStatus((cur) => {
            if (
              cur?.entitlement &&
              cur.entitlement.plan_id !== 'free' &&
              (cur.entitlement.status === 'active' ||
                cur.entitlement.status === 'trialing' ||
                cur.entitlement.status === 'comped')
            ) {
              setPollHint('Subscription active.');
              clearInterval(t);
              const url = new URL(window.location.href);
              url.searchParams.delete('checkout');
              window.history.replaceState({}, '', url.pathname + url.search);
            }
            return cur;
          });
        })
        .catch(() => {
          /* keep polling */
        });
      if (attempts >= max) {
        clearInterval(t);
        setPollHint(
          'Still waiting for Stripe webhook. Refresh this page in a moment.',
        );
      }
    }, 2000);

    return () => clearInterval(t);
  }, [load]);

  async function startCheckout() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || body.error || `HTTP ${res.status}`);
      if (!body.url) throw new Error('Checkout URL missing');
      window.location.href = body.url as string;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function openPortal() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/billing/portal', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || body.error || `HTTP ${res.status}`);
      if (!body.url) throw new Error('Portal URL missing');
      window.location.href = body.url as string;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const paidName = status?.defaultPaidPlan?.display_name ?? 'Pro';
  const source = status?.entitlement?.source;
  const isIntro = source === 'intro_trial';
  const isBeta = source === 'beta';
  const isStripePaid =
    source === 'stripe' ||
    source === 'admin_comp' ||
    source === 'beta' ||
    status?.entitlement?.status === 'active' ||
    (status?.entitlement?.status === 'trialing' && source === 'stripe');
  const showUpgrade = !status?.admin && !isStripePaid && !isBeta;
  const stripeTrialDays = status?.stripeTrialDays ?? status?.trialPeriodDays ?? 30;

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
            <CreditCard className="h-4 w-4 text-blue-600" />
            <span className="text-sm font-semibold text-slate-900">
              Billing · {session.displayName}
            </span>
          </div>
        </div>
      </header>

      {error && (
        <div className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-800">
          {error}
        </div>
      )}
      {pollHint && (
        <div className="border-b border-blue-100 bg-blue-50 px-4 py-2 text-xs text-blue-800">
          {pollHint}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12 text-sm text-slate-500">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <main className="mx-auto max-w-lg space-y-4 px-4 py-6">
          {status?.admin ? (
            <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-700">
              {status.message || 'Admins bypass caps and paywall.'}
            </div>
          ) : (
            <>
              <section className="rounded-lg border border-slate-200 bg-white p-4">
                <h2 className="text-sm font-semibold text-slate-900">Current plan</h2>
                <p className="mt-1 text-lg font-medium text-slate-800">
                  {status?.entitlement?.display_name ?? 'Free'}
                </p>
                <p className="text-xs text-slate-500">
                  status: {status?.entitlement?.status ?? 'none'} · source:{' '}
                  {status?.entitlement?.source ?? 'default_free'}
                </p>
                {isBeta && (
                  <p className="mt-2 text-xs text-emerald-800">
                    Beta access: unlimited usage, no expiry. Thank you for early support.
                  </p>
                )}
                {isIntro && status?.entitlement?.intro_trial_ends_at && (
                  <p className="mt-2 text-xs text-amber-800">
                    Free intro trial (no card) until{' '}
                    {new Date(status.entitlement.intro_trial_ends_at).toLocaleString()}.
                    Caps are limited; upgrade for full {paidName} with a{' '}
                    {stripeTrialDays}-day free period (card required).
                  </p>
                )}
                {source === 'default_free' && (
                  <p className="mt-2 text-xs text-rose-800">
                    Intro trial ended. Upgrade to {paidName} to keep using the agent (
                    {stripeTrialDays} days free with card, then billing starts).
                  </p>
                )}
                {status?.usage && (
                  <p className="mt-2 text-xs text-slate-600">
                    Usage this month ({status.usage.period}):{' '}
                    {status.usage.llm_total_tokens.toLocaleString()} tokens
                    {status.usage.llm_cap != null
                      ? ` / ${status.usage.llm_cap.toLocaleString()} cap`
                      : ' (unlimited)'}
                  </p>
                )}
              </section>

              <section className="rounded-lg border border-slate-200 bg-white p-4">
                <h2 className="text-sm font-semibold text-slate-900">
                  {paidName}
                </h2>
                <p className="mt-1 text-xs text-slate-600">
                  Full monthly caps
                  {status?.defaultPaidPlan?.caps_summary?.llm_total_tokens != null
                    ? ` (${status.defaultPaidPlan.caps_summary.llm_total_tokens.toLocaleString()} tokens)`
                    : ''}
                  . After you add a card: {stripeTrialDays} days free, then charged.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {showUpgrade ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void startCheckout()}
                      className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {busy ? 'Redirecting…' : `Upgrade to ${paidName}`}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void openPortal()}
                      className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                    >
                      {busy ? 'Redirecting…' : 'Manage subscription'}
                    </button>
                  )}
                  {!showUpgrade && status?.entitlement?.has_stripe_customer && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void openPortal()}
                      className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-700"
                    >
                      Customer Portal
                    </button>
                  )}
                </div>
              </section>
            </>
          )}
        </main>
      )}
    </div>
  );
}
