/**
 * Admin REST endpoints — invite codes, admin codes, demo mode, user listing,
 * and user reports. All routes require admin session.
 *
 * Spec: docs/webui-chat-design.md §7.6
 */

import { Router, type Request, type Response } from 'express';
import { requireAdmin, type AuthUser } from '../auth.js';
import {
  createInviteCode,
  listInviteCodes,
  createAdminOnboardCode,
  revokeAdminOnboardCode,
  listAdminOnboardCodes,
  listUserSlugs,
  loadState,
  listReports,
} from '../../state/index.js';
import { getDemoModeState, setDemoMode } from '../../onboarding/demo-mode.js';
import {
  isBillingEnabled,
  compUser,
  revokeComp,
  reconcileBilling,
  getBillingAdminView,
  getEntitlement,
  BillingHttpError,
} from '../../billing/index.js';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

function webAdminUsername(req: Request): string {
  const user = (req as any).user as AuthUser | undefined;
  if (user?.type === 'admin' && user.displayName) return user.displayName;
  throw new Error('Admin session missing displayName.');
}

// ── Invite codes ────────────────────────────────────────────────────────

adminRouter.post('/invites', (req: Request, res: Response) => {
  const username = webAdminUsername(req);
  const comment = typeof req.body?.comment === 'string' ? req.body.comment.trim() : undefined;
  try {
    const code = createInviteCode({ createdBy: 0, createdViaWeb: username, comment });
    res.json({ code: code.code, created_at: code.created_at, comment: code.comment });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

adminRouter.get('/invites', (req: Request, res: Response) => {
  const filterRaw = typeof req.query.filter === 'string' ? req.query.filter : 'all';
  const filter = filterRaw === 'unused' || filterRaw === 'used' ? filterRaw : 'all';
  const codes = listInviteCodes(filter);
  res.json({ codes });
});

// ── Admin onboard codes ─────────────────────────────────────────────────

adminRouter.post('/admincodes', (req: Request, res: Response) => {
  const username = webAdminUsername(req);
  const comment = typeof req.body?.comment === 'string' ? req.body.comment.trim() : undefined;
  try {
    const code = createAdminOnboardCode({ createdBy: 0, createdViaWeb: username, comment });
    res.json({ code: code.code, created_at: code.created_at, comment: code.comment });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

adminRouter.get('/admincodes', (req: Request, res: Response) => {
  const filterRaw = typeof req.query.filter === 'string' ? req.query.filter : 'all';
  const filter = filterRaw === 'unused' || filterRaw === 'used' ? filterRaw : 'all';
  const codes = listAdminOnboardCodes(filter);
  res.json({ codes });
});

adminRouter.post('/admincodes/revoke', (req: Request, res: Response) => {
  const code = typeof req.body?.code === 'string' ? req.body.code.trim().toUpperCase() : '';
  if (!code) {
    res.status(400).json({ error: 'code required' });
    return;
  }
  try {
    const revoked = revokeAdminOnboardCode(code);
    res.json({ ok: true, revoked });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Demo mode ───────────────────────────────────────────────────────────

adminRouter.get('/demomode', (_req: Request, res: Response) => {
  res.json(getDemoModeState());
});

adminRouter.post('/demomode', (req: Request, res: Response) => {
  const enabled = req.body?.enabled === true;
  try {
    const next = setDemoMode({ enabled });
    res.json(next);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Users ───────────────────────────────────────────────────────────────

adminRouter.get('/users', (_req: Request, res: Response) => {
  const out: Array<{ slug: string; displayName: string; createdAt: string }> = [];
  for (const slug of listUserSlugs()) {
    try {
      const s = loadState(slug);
      out.push({
        slug: s.user.slug,
        displayName: s.profile.display_name,
        createdAt: s.user.created_at,
      });
    } catch (e) {
      console.warn(`[admin/users] skipping broken state for slug=${slug}: ${(e as Error).message}`);
    }
  }
  res.json({ users: out });
});

adminRouter.get('/users/:slug', (req: Request, res: Response) => {
  const slug = req.params.slug as string;
  try {
    const state = loadState(slug);
    // Never expose secrets over the wire — strip auth_token AND password_hash.
    const safe = {
      ...state,
      user: { ...state.user, auth_token: undefined, password_hash: undefined },
    };
    res.json(safe);
  } catch (e) {
    res.status(404).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Billing admin ───────────────────────────────────────────────────────

adminRouter.get('/billing/:slug', (req: Request, res: Response) => {
  if (!isBillingEnabled()) {
    res.status(404).json({ error: 'billing_disabled' });
    return;
  }
  const slug = req.params.slug as string;
  try {
    const file = getBillingAdminView(slug);
    let entitlement = null;
    try {
      entitlement = getEntitlement(slug);
    } catch {
      entitlement = null;
    }
    res.json({ slug, billing: file, entitlement });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

adminRouter.post('/billing/comp', async (req: Request, res: Response) => {
  if (!isBillingEnabled()) {
    res.status(404).json({ error: 'billing_disabled' });
    return;
  }
  try {
    const username = webAdminUsername(req);
    const slug = typeof req.body?.slug === 'string' ? req.body.slug.trim() : '';
    const planId = typeof req.body?.plan_id === 'string' ? req.body.plan_id.trim() : '';
    if (!slug || !planId) {
      res.status(400).json({ error: 'slug and plan_id required' });
      return;
    }
    const state = await compUser({
      slug,
      planId,
      adminUsername: username,
      acknowledgeActiveSubscription: req.body?.acknowledge_active_subscription === true,
    });
    res.json({ ok: true, billing: state });
  } catch (e) {
    if (e instanceof BillingHttpError) {
      res.status(e.status).json({ error: e.code, message: e.message });
      return;
    }
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

adminRouter.post('/billing/revoke-comp', async (req: Request, res: Response) => {
  if (!isBillingEnabled()) {
    res.status(404).json({ error: 'billing_disabled' });
    return;
  }
  try {
    const slug = typeof req.body?.slug === 'string' ? req.body.slug.trim() : '';
    if (!slug) {
      res.status(400).json({ error: 'slug required' });
      return;
    }
    const state = await revokeComp(slug);
    res.json({ ok: true, billing: state });
  } catch (e) {
    if (e instanceof BillingHttpError) {
      res.status(e.status).json({ error: e.code, message: e.message });
      return;
    }
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

adminRouter.post('/billing/reconcile', async (req: Request, res: Response) => {
  if (!isBillingEnabled()) {
    res.status(404).json({ error: 'billing_disabled' });
    return;
  }
  try {
    const slug = typeof req.body?.slug === 'string' ? req.body.slug.trim() : '';
    if (!slug) {
      res.status(400).json({ error: 'slug required' });
      return;
    }
    const state = await reconcileBilling(slug);
    res.json({ ok: true, billing: state });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── User reports (global reporting.yaml) ────────────────────────────────

adminRouter.get('/reports', (req: Request, res: Response) => {
  try {
    const reporterSlug =
      typeof req.query.reporter_slug === 'string' ? req.query.reporter_slug.trim() : undefined;
    const limitRaw = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined;
    const limit = limitRaw != null && Number.isFinite(limitRaw) ? limitRaw : undefined;
    const reports = listReports({
      reporterSlug: reporterSlug || undefined,
      limit,
    });
    res.json({ reports });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});
