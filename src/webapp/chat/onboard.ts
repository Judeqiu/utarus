/**
 * Web invite redeem — POST /api/onboard/redeem
 *
 * Onboards a brand-new web user (no chat-platform id) using the framework's
 * `ensureChannelUser({ web: true })` extension (Branch A).
 *
 * Demo mode: when demo mode is enabled and `code` is null, the handler
 * creates a profile directly via ensureChannelUser({ source: 'demo', web: true }).
 *
 * On success: sets the bindrive_session cookie and returns { slug, redirect }.
 * The browser never sees the raw auth_token in the response body.
 *
 * Spec: docs/webui-chat-design.md §4.4, §10 (New user via web invite redeem).
 */

import { Router, type Request, type Response } from 'express';
import {
  createSession,
  resolveByToken,
  authenticateUser,
  requireAuth,
  type AuthUser,
} from '../auth.js';
import {
  redeemInviteInstantly,
  ensureChannelUser,
} from '../../onboarding/instant-invite.js';
import { isDemoModeEnabled } from '../../onboarding/demo-mode.js';
import { resolveUserBySlug, loadState, saveState } from '../../state/index.js';
import { hashPassword } from '../../auth/password.js';
import { config } from '../../config.js';

export const onboardRedeemRouter = Router();

interface RedeemBody {
  display_name?: unknown;
  code?: unknown;
}

interface LoginBody {
  auth_token?: unknown;
  identifier?: unknown;
  password?: unknown;
}

interface ChangePasswordBody {
  new_password?: unknown;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * GET /api/onboard/demo — reports whether demo mode is active.
 *
 * The SPA login screen polls this to decide whether to render the demo
 * (display-name-only) login. Returns { enabled: boolean }. No auth — the
 * login screen is unauthenticated by definition.
 */
onboardRedeemRouter.get('/demo', (_req, res) => {
  res.json({
    enabled: isDemoModeEnabled(),
    agentName: config.agent.name ?? 'Agent',
  });
});

/**
 * POST /api/onboard/login — SPA login (token OR username + password).
 *
 * Two body shapes are accepted; dispatch on which fields are present:
 *   - { auth_token: string }                → legacy token login (resolveByToken)
 *   - { identifier, password }              → username+password (authenticateUser)
 *     identifier is the user slug OR contact_email (case-insensitive)
 *
 * Sets bindrive_session cookie, returns { type, slug, displayName }. JSON in,
 * JSON out — distinct from BinDrive's form-based /login which the SPA cannot
 * consume. Admin username/password login is intentionally NOT supported here
 * (admins use WEBAPP_ADMIN_CREDENTIALS) — surface a clear 400 instead.
 */
onboardRedeemRouter.post('/login', async (req, res) => {
  const body = req.body as LoginBody;
  const hasToken = typeof body.auth_token === 'string' && body.auth_token.trim().length > 0;
  const hasIdentifier =
    typeof body.identifier === 'string' && body.identifier.trim().length > 0;
  const hasPassword = typeof body.password === 'string' && body.password.length > 0;

  if (!hasToken && !(hasIdentifier && hasPassword)) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'Either auth_token or identifier+password required.',
    });
    return;
  }

  let user: AuthUser | null;
  if (hasToken) {
    user = resolveByToken((body.auth_token as string).trim());
    if (!user) {
      res.status(401).json({ error: 'invalid_token', message: 'Invalid auth token.' });
      return;
    }
  } else {
    // identifier + password path. authenticateUser scans user files matching
    // slug OR contact_email and verifies bcrypt hash. Returns null on no-match
    // / wrong-password / legacy-user-without-hash — surface 401 either way.
    user = await authenticateUser(
      (body.identifier as string).trim(),
      body.password as string,
    );
    if (!user) {
      res.status(401).json({
        error: 'invalid_credentials',
        message: 'Invalid username or password.',
      });
      return;
    }
  }

  const sessionToken = createSession(user);
  res.cookie('bindrive_session', sessionToken, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000,
  });
  res.json({
    type: user.type,
    slug: user.slug,
    displayName: user.displayName,
  });
});

onboardRedeemRouter.post('/redeem', async (req, res) => {
  const body = req.body as RedeemBody;

  if (!isNonEmptyString(body.display_name) || body.display_name.trim().length > 60) {
    res.status(400).json({ error: 'invalid_display_name', message: 'Display name must be 1–60 chars.' });
    return;
  }
  const displayName = body.display_name.trim();

  const demoActive = isDemoModeEnabled();
  const hasCode = isNonEmptyString(body.code);

  if (!hasCode && !demoActive) {
    res.status(400).json({ error: 'invalid_code', message: 'Invite code required (or ask an admin to enable demo mode).' });
    return;
  }

  let slug: string;
  let displayOut: string;
  let presetPassword = '';

  try {
    if (hasCode) {
      const code = (body.code as string).trim().toUpperCase();
      const result = await redeemInviteInstantly({
        code,
        displayName,
        web: true,
      });
      slug = result.slug;
      displayOut = result.displayName;
      presetPassword = result.presetPassword;
    } else {
      // Demo mode + no code → auto-create.
      const result = await ensureChannelUser({
        displayName,
        web: true,
        source: 'demo',
      });
      slug = result.slug;
      displayOut = result.displayName;
      presetPassword = result.presetPassword;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/already used|revoked|not found|not redeemable/i.test(msg)) {
      res.status(409).json({ error: 'code_not_redeemable', message: msg });
      return;
    }
    if (/slug/i.test(msg) && /exist|collision/i.test(msg)) {
      res.status(409).json({ error: 'slug_taken', message: msg });
      return;
    }
    res.status(400).json({ error: 'redeem_failed', message: msg });
    return;
  }

  // Verify the freshly-created state file is loadable (fail fast — no fallback).
  const state = resolveUserBySlug(slug);
  if (!state) {
    res.status(500).json({ error: 'redeem_failed', message: `User "${slug}" was not created on disk.` });
    return;
  }
  if (!state.user.auth_token) {
    res.status(500).json({ error: 'redeem_failed', message: `User "${slug}" missing auth_token.` });
    return;
  }

  const user: AuthUser = {
    type: 'user',
    slug,
    displayName: displayOut,
    userId: state.user.id,
  };
  const sessionToken = createSession(user);
  res.cookie('bindrive_session', sessionToken, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000,
  });
  // preset_password is plaintext and one-shot — surfaced only here so the SPA
  // can render it once on the redeem-confirmation screen. The hash is on disk
  // in user.password_hash; the plaintext is never recoverable after this.
  res.json({
    slug,
    display_name: displayOut,
    contact_email: state.profile.contact_email,
    preset_password: presetPassword,
    redirect: '/',
  });
});

/**
 * POST /api/profile/password — change the signed-in user's password.
 *
 * Body: { new_password: string }. Requires an active session (any user type).
 * Validates ≥6 chars (bcrypt/hashPassword constraint), hashes, writes to
 * user.password_hash, pushes a log entry, returns { ok: true }.
 *
 * Fail-fast: short passwords return 400 with the raw error message — no
 * silent padding or coercion.
 */
onboardRedeemRouter.post(
  '/profile/password',
  requireAuth,
  async (req: Request, res: Response) => {
    const body = req.body as ChangePasswordBody;
    if (typeof body.new_password !== 'string' || body.new_password.length < 6) {
      res.status(400).json({
        error: 'invalid_password',
        message: 'Password must be at least 6 characters.',
      });
      return;
    }
    const sessionUser = (req as unknown as { user: AuthUser }).user;
    if (sessionUser.type !== 'user') {
      res.status(403).json({
        error: 'forbidden',
        message: 'Only domain users may set a password (admin auth is env-driven).',
      });
      return;
    }
    const slug = sessionUser.slug;
    const state = loadState(slug);
    let hash: string;
    try {
      hash = await hashPassword(body.new_password);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(400).json({ error: 'hash_failed', message: msg });
      return;
    }
    state.user.password_hash = hash;
    state.log.push({
      ts: new Date().toISOString().slice(0, 10),
      action: 'password_changed',
    });
    saveState(state);
    res.json({ ok: true });
  },
);
