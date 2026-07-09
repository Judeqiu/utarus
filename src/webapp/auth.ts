/**
 * Utarus BinDrive authentication — token-based.
 *
 * User auth: auth_token from user YAML (UserState.user.auth_token), via
 *   Authorization header or query param or browser session cookie.
 * Admin auth: WEBAPP_ADMIN_CREDENTIALS from .env (or single USERNAME/PASSWORD).
 *
 * Link tokens: short-lived, attachable to URLs as `?t=<token>` so Slack /
 * Telegram deep links work without a separate login step. On first browser
 * hit the token is exchanged for a normal session cookie and stripped from
 * the URL (so it does not linger in history/referrers).
 */

import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { listUserSlugs, loadState, type UserState } from '../state/index.js';
import type { Request, Response, NextFunction } from 'express';

export interface AuthUser {
  type: 'admin' | 'user';
  slug: string;
  displayName: string;
}

// In-memory sessions (browser cookie-based flow)
const sessions = new Map<string, { user: AuthUser; expiresAt: number }>();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export function createSession(user: AuthUser): string {
  const token = randomUUID();
  sessions.set(token, { user, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

export function getSession(token: string): AuthUser | null {
  const entry = sessions.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return entry.user;
}

export function destroySession(token: string): void {
  sessions.delete(token);
}

// ── Short-lived link tokens ─────────────────────────────────────────

export const DEFAULT_LINK_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
export const MAX_LINK_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const MIN_LINK_TOKEN_TTL_MS = 60 * 1000; // 1 minute

interface LinkTokenRecord {
  user: AuthUser;
  expiresAt: number;
  /** If set, only valid when request path starts with this prefix. */
  pathPrefix?: string;
  /** Optional cap on redemptions (undefined = unlimited until expiry). */
  maxUses?: number;
  uses: number;
}

const linkTokens = new Map<string, LinkTokenRecord>();

export interface CreateLinkTokenParams {
  user: AuthUser;
  /** Lifetime in ms. Default 1h, max 24h, min 1m. */
  ttlMs?: number;
  /** Restrict to paths under this prefix (e.g. "/dashboard"). */
  pathPrefix?: string;
  /** Cap how many times the token can be redeemed. */
  maxUses?: number;
}

export interface LinkTokenResult {
  token: string;
  expiresAt: number;
  expiresInMs: number;
}

/**
 * Mint a short-lived link token for deep links (Slack buttons, chat messages).
 * Attach as query param `t=<token>` — see appendLinkToken / buildLinkUrl.
 */
export function createLinkToken(params: CreateLinkTokenParams): LinkTokenResult {
  if (!params.user?.slug) {
    throw new Error('createLinkToken requires user.slug');
  }
  let ttl = params.ttlMs ?? DEFAULT_LINK_TOKEN_TTL_MS;
  if (ttl < MIN_LINK_TOKEN_TTL_MS) {
    throw new Error(`link token ttl must be at least ${MIN_LINK_TOKEN_TTL_MS}ms`);
  }
  if (ttl > MAX_LINK_TOKEN_TTL_MS) {
    ttl = MAX_LINK_TOKEN_TTL_MS;
  }

  const token = randomUUID();
  const expiresAt = Date.now() + ttl;
  linkTokens.set(token, {
    user: params.user,
    expiresAt,
    pathPrefix: params.pathPrefix,
    maxUses: params.maxUses,
    uses: 0,
  });
  return { token, expiresAt, expiresInMs: ttl };
}

/**
 * Resolve a link token without consuming a use. Returns null if missing/expired
 * or pathPrefix mismatch.
 */
export function peekLinkToken(token: string, path?: string): AuthUser | null {
  const rec = linkTokens.get(token);
  if (!rec) return null;
  if (Date.now() > rec.expiresAt) {
    linkTokens.delete(token);
    return null;
  }
  if (rec.pathPrefix && path) {
    const bare = path.split('?')[0] || path;
    if (!bare.startsWith(rec.pathPrefix)) return null;
  }
  return rec.user;
}

/**
 * Resolve and count one use of a link token. Deletes the record when maxUses
 * is reached or the token is expired.
 */
export function consumeLinkToken(token: string, path?: string): AuthUser | null {
  const rec = linkTokens.get(token);
  if (!rec) return null;
  if (Date.now() > rec.expiresAt) {
    linkTokens.delete(token);
    return null;
  }
  if (rec.pathPrefix && path) {
    const bare = path.split('?')[0] || path;
    if (!bare.startsWith(rec.pathPrefix)) return null;
  }
  rec.uses += 1;
  if (rec.maxUses !== undefined && rec.uses >= rec.maxUses) {
    linkTokens.delete(token);
  }
  return rec.user;
}

/** Append `t=<token>` to a relative or absolute URL. */
export function appendLinkToken(url: string, token: string): string {
  const hasQuery = url.includes('?');
  const joiner = hasQuery ? '&' : '?';
  return `${url}${joiner}t=${encodeURIComponent(token)}`;
}

/**
 * Build an absolute authed deep link: mint token + attach to path.
 * `baseUrl` is e.g. https://host:3001 (no trailing slash).
 * `path` is e.g. /dashboard or /dl/file.mp4?slug=x
 */
export function buildAuthedUrl(
  baseUrl: string,
  path: string,
  params: CreateLinkTokenParams,
): { url: string; token: string; expiresAt: number; expiresInMs: number } {
  const minted = createLinkToken(params);
  const base = baseUrl.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return {
    url: appendLinkToken(`${base}${p}`, minted.token),
    token: minted.token,
    expiresAt: minted.expiresAt,
    expiresInMs: minted.expiresInMs,
  };
}

/** Test helper — clear all link tokens. */
export function _clearLinkTokensForTests(): void {
  linkTokens.clear();
}

function findUserByAuthToken(authToken: string): UserState | null {
  const slugs = listUserSlugs();
  for (const slug of slugs) {
    try {
      const state = loadState(slug);
      if (state.user.auth_token && state.user.auth_token === authToken) {
        return state;
      }
    } catch {
      // skip broken state files
    }
  }
  return null;
}

/**
 * Resolve user by auth_token. Returns null if not found.
 */
export function resolveByToken(authToken: string): AuthUser | null {
  const state = findUserByAuthToken(authToken);
  if (!state) return null;
  return { type: 'user', slug: state.user.slug, displayName: state.profile.display_name };
}

/**
 * Authenticate admin credentials.
 */
export function authenticateAdmin(username: string, password: string): AuthUser | null {
  const expected = config.webapp.adminCredentials[username];
  if (expected !== undefined && password === expected) {
    return { type: 'admin', slug: 'admin', displayName: username };
  }
  return null;
}

/**
 * Extract auth from request — checks:
 * 1. Authorization: Bearer <token> header (API — permanent auth_token or session)
 * 2. Query param ?t=<linkToken> (short-lived deep links)
 * 3. Query param ?token=<auth_token> (API convenience, permanent)
 * 4. Cookie bindrive_session (browser)
 */
function extractAuth(req: Request): { user: AuthUser | null; method: string } {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const user = resolveByToken(token);
    if (user) return { user, method: 'bearer' };
    const session = getSession(token);
    if (session) return { user: session, method: 'session' };
    const linkUser = peekLinkToken(token, req.path);
    if (linkUser) return { user: linkUser, method: 'link-bearer' };
  }

  const queryT = (req.query.t as string) || (req.query.access_token as string);
  if (queryT) {
    const user = peekLinkToken(queryT, req.path);
    if (user) return { user, method: 'link' };
  }

  const queryToken = req.query.token as string;
  if (queryToken) {
    const user = resolveByToken(queryToken);
    if (user) return { user, method: 'query' };
  }

  const cookieToken = req.cookies?.['bindrive_session'];
  if (cookieToken) {
    const session = getSession(cookieToken);
    if (session) return { user: session, method: 'cookie' };
  }

  return { user: null, method: 'none' };
}

/**
 * If the request carries a valid `?t=` link token and no session cookie yet,
 * exchange it for a session cookie and redirect to the same path without `t`.
 * Call this early in the request pipeline (or from requireAuth).
 *
 * Returns true when a redirect was issued (caller must stop).
 */
export function tryExchangeLinkToken(req: Request, res: Response): boolean {
  const t = (req.query.t as string) || (req.query.access_token as string);
  if (!t) return false;

  // Already have a live session cookie — drop t from URL if present.
  const cookieToken = req.cookies?.['bindrive_session'];
  if (cookieToken && getSession(cookieToken)) {
    return redirectStrippingToken(req, res);
  }

  const user = consumeLinkToken(t, req.path);
  if (!user) return false;

  const sessionToken = createSession(user);
  res.cookie('bindrive_session', sessionToken, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
  });
  return redirectStrippingToken(req, res);
}

function redirectStrippingToken(req: Request, res: Response): boolean {
  const url = new URL(req.originalUrl, 'http://localhost');
  if (!url.searchParams.has('t') && !url.searchParams.has('access_token')) {
    return false;
  }
  url.searchParams.delete('t');
  url.searchParams.delete('access_token');
  const next = url.pathname + (url.search || '');
  res.redirect(next);
  return true;
}

/**
 * Middleware — require any valid auth (user token, link token, or admin session).
 * Browser requests with `?t=` get a session cookie and a clean redirect first.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // Prefer exchanging link tokens on browser navigations so the rest of the
  // request pipeline sees a normal session cookie.
  const acceptsHtml = (req.headers.accept || '').includes('text/html');
  if (acceptsHtml || req.path === '/' || !req.path.startsWith('/api/')) {
    if (tryExchangeLinkToken(req, res)) return;
  }

  const { user } = extractAuth(req);
  if (!user) {
    if (req.path.endsWith('/view') || req.path.startsWith('/dl')) {
      const returnUrl = encodeURIComponent(req.originalUrl);
      res.redirect(`/login?return=${returnUrl}`);
      return;
    }
    if (req.path.startsWith('/api/')) {
      res.status(401).json({
        error: 'Unauthorized. Provide auth_token via Authorization: Bearer <token>, or a short-lived link token via ?t=',
      });
      return;
    }
    res.redirect('/login');
    return;
  }
  (req as any).user = user;
  next();
}

/**
 * Middleware — require admin role.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = (req as any).user as AuthUser;
  if (!user || user.type !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

/**
 * Get the slug for the current user. Admin can access any slug via ?slug= param.
 */
export function targetSlug(req: Request, user: AuthUser): string {
  if (user.type === 'admin') {
    const slug = req.query.slug as string;
    if (!slug) throw new Error('Admin must specify ?slug=<slug>');
    if (!listUserSlugs().includes(slug)) throw new Error(`Slug "${slug}" not found`);
    return slug;
  }
  return user.slug;
}
