/**
 * Open web self-signup (framework-owned).
 *
 * Creates a web-only user with email + password (no Telegram/Slack link).
 * Enabled only when UTARUS_OPEN_SIGNUP_ENABLED=true (explicit opt-in).
 */

import { randomBytes } from 'crypto';
import type { CookieOptions, Request, Response } from 'express';
import { hashPassword } from '../auth/password.js';
import {
  blankState,
  listUserSlugs,
  loadState,
  saveState,
  stateExists,
} from '../state/index.js';
import { destroySession } from '../webapp/auth.js';
import { config } from '../config.js';

export class SignupValidationError extends Error {
  constructor(
    public field: string,
    message: string,
  ) {
    super(message);
    this.name = 'SignupValidationError';
  }
}

export interface WebSignupInput {
  display_name: string;
  email: string;
  password: string;
  /** Optional acquisition/affiliate code from `?reference=` on the signup page. */
  reference?: string;
}

export interface WebSignupResult {
  slug: string;
  displayName: string;
  email: string;
  userId: string;
  reference?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;
/** Affiliate / campaign codes: short, URL-safe, no spaces. */
const REFERENCE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const MAX_REFERENCE = 64;

/** Explicit opt-in — open registration is a product decision per agent. */
export function isOpenSignupEnabled(): boolean {
  return process.env.UTARUS_OPEN_SIGNUP_ENABLED === 'true';
}

export function validateWebSignup(body: unknown): WebSignupInput {
  if (typeof body !== 'object' || body === null) {
    throw new SignupValidationError('body', 'Request body must be a JSON object.');
  }
  const b = body as Record<string, unknown>;

  if (typeof b.display_name !== 'string') {
    throw new SignupValidationError('display_name', 'Display name is required.');
  }
  const displayName = b.display_name.trim();
  if (displayName.length < 1 || displayName.length > 60) {
    throw new SignupValidationError(
      'display_name',
      'Display name must be 1–60 characters.',
    );
  }

  if (typeof b.email !== 'string') {
    throw new SignupValidationError('email', 'Email is required.');
  }
  const email = b.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) {
    throw new SignupValidationError('email', 'Enter a valid email address.');
  }
  if (email.endsWith('.local')) {
    throw new SignupValidationError('email', 'Enter a real email address.');
  }

  if (typeof b.password !== 'string') {
    throw new SignupValidationError('password', 'Password is required.');
  }
  if (b.password.length < MIN_PASSWORD) {
    throw new SignupValidationError(
      'password',
      `Password must be at least ${MIN_PASSWORD} characters.`,
    );
  }
  if (b.password.length > 200) {
    throw new SignupValidationError('password', 'Password is too long.');
  }

  const reference = parseOptionalReference(b.reference);

  return {
    display_name: displayName,
    email,
    password: b.password,
    ...(reference !== undefined ? { reference } : {}),
  };
}

/**
 * Optional signup attribution code. Absent / empty → undefined.
 * Present but invalid → fail fast (no silent drop).
 */
export function parseOptionalReference(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }
  if (typeof raw !== 'string') {
    throw new SignupValidationError('reference', 'Reference must be a string.');
  }
  const reference = raw.trim();
  if (!reference) {
    return undefined;
  }
  if (reference.length > MAX_REFERENCE) {
    throw new SignupValidationError(
      'reference',
      `Reference must be at most ${MAX_REFERENCE} characters.`,
    );
  }
  if (!REFERENCE_RE.test(reference)) {
    throw new SignupValidationError(
      'reference',
      'Reference must be 1–64 characters: letters, digits, dot, underscore, or hyphen (must start with alphanumeric).',
    );
  }
  return reference;
}

export function emailTaken(email: string): boolean {
  const want = email.trim().toLowerCase();
  if (!want) return false;
  for (const slug of listUserSlugs()) {
    try {
      const state = loadState(slug);
      if ((state.profile.contact_email ?? '').toLowerCase() === want) {
        return true;
      }
    } catch {
      // skip broken files
    }
  }
  return false;
}

function cryptoRandom(n: number): string {
  return randomBytes(Math.ceil(n / 2))
    .toString('hex')
    .slice(0, n);
}

function slugBaseFromDisplayName(displayName: string): string {
  const fromName = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (fromName) return fromName;
  return `user-${cryptoRandom(8)}`;
}

function uniqueSlug(base: string): string {
  if (!stateExists(base)) return base;
  for (let i = 0; i < 8; i++) {
    const candidate = `${base}-${cryptoRandom(4)}`;
    if (!stateExists(candidate)) return candidate;
  }
  throw new Error(
    `Could not allocate a unique slug for base "${base}". Contact support.`,
  );
}

export async function createWebSignupUser(
  input: WebSignupInput,
): Promise<WebSignupResult> {
  if (emailTaken(input.email)) {
    throw new SignupValidationError(
      'email',
      'An account with this email already exists. Log in instead.',
    );
  }

  const slug = uniqueSlug(slugBaseFromDisplayName(input.display_name));
  const state = blankState({
    slug,
    displayName: input.display_name,
    contactEmail: input.email,
  });
  state.user.password_hash = await hashPassword(input.password);
  if (input.reference) {
    state.user.reference = input.reference;
  }
  state.log.push({
    ts: new Date().toISOString().slice(0, 10),
    action: 'web_signup',
    web: true,
    ...(input.reference ? { reference: input.reference } : {}),
  });
  saveState(state);

  return {
    slug,
    displayName: input.display_name,
    email: input.email,
    userId: state.user.id,
    ...(input.reference ? { reference: input.reference } : {}),
  };
}

export function signOutRequest(req: Request, res: Response): void {
  const token =
    typeof req.cookies?.bindrive_session === 'string'
      ? req.cookies.bindrive_session
      : undefined;
  if (token) {
    try {
      destroySession(token);
    } catch {
      // cookie clear still forces browser sign-out
    }
  }

  const hostOnly: CookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
  };
  res.clearCookie('bindrive_session', hostOnly);

  const domain = (
    process.env.UTARUS_SESSION_COOKIE_DOMAIN ||
    process.env.BINARY_SESSION_COOKIE_DOMAIN ||
    ''
  ).trim();
  if (domain) {
    res.clearCookie('bindrive_session', {
      ...hostOnly,
      domain,
      secure: true,
    });
  }
}

/**
 * After signup: prefer UTARUS_POST_SIGNUP_REDIRECT (or legacy BINARY_*),
 * else UTARUS_PUBLIC_BASE_URL/login. Domains with a separate signup host
 * should point at the chat-origin login URL.
 */
export function postSignupRedirect(): string {
  const explicit = (
    process.env.UTARUS_POST_SIGNUP_REDIRECT ||
    process.env.BINARY_POST_SIGNUP_REDIRECT ||
    ''
  ).trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const chatBase = (process.env.UTARUS_PUBLIC_BASE_URL || '')
    .trim()
    .replace(/\/+$/, '');
  if (chatBase) return `${chatBase}/login`;

  return '/login';
}

export function withLoginEmail(redirect: string, email: string): string {
  const base = redirect.trim();
  if (!base) return `/login?email=${encodeURIComponent(email)}`;
  const isLogin =
    base === '/login' ||
    base.endsWith('/login') ||
    /\/login(\?|$)/.test(base);
  if (!isLogin) return base;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}email=${encodeURIComponent(email)}`;
}

export function openSignupPublicConfig(): {
  enabled: boolean;
  agentName: string;
  tagline: string;
} {
  const agentName = (config.agent.name || 'Agent').trim() || 'Agent';
  const tagline = (process.env.UTARUS_SIGNUP_TAGLINE || '').trim()
    || `Sign up to chat with ${agentName}.`;
  return {
    enabled: isOpenSignupEnabled(),
    agentName,
    tagline,
  };
}
