/**
 * User-facing billing HTTP routes (status, checkout, portal, config, enter).
 * Webhook is mounted separately with express.raw on the root app.
 */

import { Router, type Request, type Response } from 'express';
import {
  requireAuth,
  consumeLinkToken,
  createSession,
  getSession,
  SESSION_TTL_MS,
  type AuthUser,
} from './auth.js';
import {
  BillingHttpError,
  createCheckoutSessionUrl,
  createPortalSessionUrl,
} from '../billing/checkout.js';
import {
  getEntitlement,
  getEffectiveCap,
  isBillingEnabled,
  loadPlansCatalog,
  getPlan,
  freePlanId,
  TRIAL_PERIOD_DAYS,
  getStripePublishableKey,
} from '../billing/index.js';
import { loadUsage } from '../usage/usage-file.js';

const ENTER_FULL_PATH = '/api/billing/enter';
const ALLOWED_RETURNS = new Set(['/billing']);

function sessionUser(req: Request): AuthUser {
  const user = (req as Request & { user?: AuthUser }).user;
  if (!user?.slug) {
    throw new BillingHttpError('Authentication required', 401, 'unauthorized');
  }
  return user;
}

function sendBillingError(res: Response, err: unknown): void {
  if (err instanceof BillingHttpError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }
  console.error('[billing]', err instanceof Error ? err.message : String(err));
  res.status(500).json({
    error: 'internal',
    message: err instanceof Error ? err.message : String(err),
  });
}

function safeReturnPath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) {
    return '/billing';
  }
  const pathOnly = raw.split('?')[0] || '/billing';
  if (ALLOWED_RETURNS.has(pathOnly) || pathOnly.startsWith('/billing/')) {
    return pathOnly;
  }
  return '/billing';
}

export function createBillingRouter(): Router {
  const router = Router();

  /**
   * Channel magic-link exchange: always replace session from link token.
   * pathPrefix validation uses full path /api/billing/enter (not mount-relative).
   */
  router.get('/enter', (req: Request, res: Response) => {
    if (!isBillingEnabled()) {
      res.status(404).send('Billing is not enabled');
      return;
    }
    const t = typeof req.query.t === 'string' ? req.query.t : '';
    if (!t) {
      res.status(400).send('Missing t link token');
      return;
    }
    const returnTo = safeReturnPath(req.query.return);
    const fullPath = ENTER_FULL_PATH;
    const tokenUser = consumeLinkToken(t, fullPath);
    if (!tokenUser) {
      res.status(401).send('Invalid or expired link token');
      return;
    }

    const prevCookie = req.cookies?.['bindrive_session'] as string | undefined;
    if (prevCookie) {
      const prev = getSession(prevCookie);
      if (prev && (prev.slug !== tokenUser.slug || prev.type !== tokenUser.type)) {
        console.log(
          `[billing/enter] replaced session prev=${prev.slug} next=${tokenUser.slug}`,
        );
      }
    }

    const sessionToken = createSession(tokenUser);
    res.cookie('bindrive_session', sessionToken, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SESSION_TTL_MS,
    });
    res.redirect(302, returnTo);
  });

  /** Public config for WebUI (no price ids). */
  router.get('/config', (_req: Request, res: Response) => {
    if (!isBillingEnabled()) {
      res.json({
        enabled: false,
        trialPeriodDays: TRIAL_PERIOD_DAYS,
        introTrialDays: 7,
        stripeTrialDays: TRIAL_PERIOD_DAYS,
      });
      return;
    }
    try {
      const catalog = loadPlansCatalog();
      const paid = getPlan(catalog.default_paid_plan_id, catalog);
      res.json({
        enabled: true,
        publishableKey: getStripePublishableKey() ?? null,
        /** Stripe Checkout trial (card) — same as stripeTrialDays. */
        trialPeriodDays: catalog.trial_period_days,
        introTrialDays: catalog.intro_trial_days,
        stripeTrialDays: catalog.trial_period_days,
        introCapsSummary: {
          llm_total_tokens: catalog.intro_caps.llm_total_tokens,
          tools: catalog.intro_caps.tools ?? {},
        },
        defaultPaidPlan: {
          id: paid.id,
          display_name: paid.display_name,
          caps_summary: {
            llm_total_tokens: paid.caps.llm_total_tokens,
            tools: paid.caps.tools ?? {},
          },
        },
      });
    } catch (err) {
      sendBillingError(res, err);
    }
  });

  router.get('/status', requireAuth, (req: Request, res: Response) => {
    if (!isBillingEnabled()) {
      res.status(404).json({ error: 'billing_disabled', message: 'Billing is not enabled' });
      return;
    }
    try {
      const user = sessionUser(req);
      if (user.type === 'admin') {
        res.json({
          admin: true,
          unlimited: true,
          message: 'Admins bypass caps and paywall.',
        });
        return;
      }
      const ent = getEntitlement(user.slug);
      const catalog = loadPlansCatalog();
      const paid = getPlan(catalog.default_paid_plan_id, catalog);
      const usage = loadUsage(user.slug);
      const tokenCap = getEffectiveCap(user.slug, 'llm_total_tokens');
      res.json({
        entitlement: {
          plan_id: ent.plan_id,
          status: ent.status,
          source: ent.source,
          display_name: ent.display_name,
          features: ent.features,
          current_period_end: ent.current_period_end ?? null,
          cancel_at_period_end: ent.cancel_at_period_end ?? false,
          intro_trial_ends_at: ent.intro_trial_ends_at ?? null,
          has_stripe_customer: Boolean(ent.stripe_customer_id),
        },
        usage: {
          period: usage.period,
          llm_total_tokens: usage.period_llm.total_tokens,
          llm_cap: tokenCap ?? null,
        },
        defaultPaidPlan: {
          id: paid.id,
          display_name: paid.display_name,
          caps_summary: {
            llm_total_tokens: paid.caps.llm_total_tokens,
            tools: paid.caps.tools ?? {},
          },
        },
        trialPeriodDays: catalog.trial_period_days,
        introTrialDays: catalog.intro_trial_days,
        stripeTrialDays: catalog.trial_period_days,
        freePlanId: freePlanId(catalog),
      });
    } catch (err) {
      sendBillingError(res, err);
    }
  });

  router.post('/checkout', requireAuth, async (req: Request, res: Response) => {
    try {
      const user = sessionUser(req);
      if (user.type === 'admin') {
        res.status(400).json({
          error: 'admin',
          message: 'Admins do not use Checkout.',
        });
        return;
      }
      const planId =
        typeof req.body?.plan_id === 'string' ? req.body.plan_id.trim() : undefined;
      const url = await createCheckoutSessionUrl(user.slug, planId);
      res.json({ url });
    } catch (err) {
      sendBillingError(res, err);
    }
  });

  router.post('/portal', requireAuth, async (req: Request, res: Response) => {
    try {
      const user = sessionUser(req);
      if (user.type === 'admin') {
        res.status(400).json({
          error: 'admin',
          message: 'Admins do not use the Customer Portal.',
        });
        return;
      }
      const url = await createPortalSessionUrl(user.slug);
      res.json({ url });
    } catch (err) {
      sendBillingError(res, err);
    }
  });

  return router;
}
