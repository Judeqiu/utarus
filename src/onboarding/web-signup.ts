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
import type { SignupPageConfig } from '../extension.js';

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

/** Public JSON for GET /api/onboard/signup-config (static page consumes this). */
export interface OpenSignupPublicConfig {
  enabled: boolean;
  agentName: string;
  /** True when domain supplies a full-page HTML shell. */
  shell: boolean;
  /** Whether form mount includes title/intro chrome (default true). */
  formChrome: boolean;
  /** Base path for domain static assets, e.g. `/domain-assets/demo`. */
  domainAssetsBase?: string;
  /** Page/form h1 — domain title or agent name. */
  title: string;
  tagline: string;
  intro: string[];
  bullets: string[];
  notice?: string;
  footerNote?: string;
  submitLabel: string;
  accentColor?: string;
}

/** Resolved domain shell HTML for GET /signup (absolute filesystem path). */
export interface OpenSignupShellRegistration {
  absolutePath: string;
  agentKey: string;
}

const MAX_TITLE = 80;
const MAX_TAGLINE = 240;
const MAX_INTRO = 6;
const MAX_INTRO_LEN = 500;
const MAX_BULLETS = 10;
const MAX_BULLET_LEN = 200;
const MAX_NOTICE = 400;
const MAX_FOOTER = 240;
const MAX_SUBMIT = 40;
const MAX_SHELL_PATH = 200;
const ACCENT_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
/** Relative path under staticDir: no leading slash, no `..`. */
const SHELL_PATH_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*\.(html|htm)$/;

/** Domain signup page copy registered at createFramework time. */
let registeredSignupPage: SignupPageConfig | undefined;
let registeredShell: OpenSignupShellRegistration | undefined;

/**
 * Register domain `webUi.signupPage` (called from createFramework).
 * Pass undefined to clear (tests). Does not resolve shell file path —
 * use {@link setOpenSignupShell} after validating the file on disk.
 */
export function setOpenSignupPageConfig(cfg: SignupPageConfig | undefined): void {
  if (cfg === undefined) {
    registeredSignupPage = undefined;
    return;
  }
  registeredSignupPage = normalizeSignupPageConfig(cfg);
}

export function getOpenSignupPageConfig(): SignupPageConfig | undefined {
  return registeredSignupPage;
}

/** Register resolved shell HTML path (or clear). */
export function setOpenSignupShell(
  shell: OpenSignupShellRegistration | undefined,
): void {
  registeredShell = shell;
}

export function getOpenSignupShell(): OpenSignupShellRegistration | undefined {
  return registeredShell;
}

/**
 * Validate + normalize domain signup page config. Fail fast on bad shapes
 * (boot-time) so agents see clear errors instead of silent drops.
 */
export function normalizeSignupPageConfig(raw: SignupPageConfig): SignupPageConfig {
  if (!raw || typeof raw !== 'object') {
    throw new Error('webUi.signupPage must be an object when set.');
  }
  const out: SignupPageConfig = {};

  if (raw.shell !== undefined) {
    if (typeof raw.shell !== 'string' || !raw.shell.trim()) {
      throw new Error('webUi.signupPage.shell must be a non-empty string when set.');
    }
    const shell = raw.shell.trim().replace(/^\/+/, '');
    if (shell.length > MAX_SHELL_PATH) {
      throw new Error(`webUi.signupPage.shell must be ≤${MAX_SHELL_PATH} characters.`);
    }
    if (shell.includes('..') || shell.includes('\\') || !SHELL_PATH_RE.test(shell)) {
      throw new Error(
        'webUi.signupPage.shell must be a relative path under staticDir ' +
          '(e.g. "signup/shell.html"); no ".." or absolute paths.',
      );
    }
    out.shell = shell;
  }

  if (raw.formChrome !== undefined) {
    if (typeof raw.formChrome !== 'boolean') {
      throw new Error('webUi.signupPage.formChrome must be a boolean when set.');
    }
    out.formChrome = raw.formChrome;
  }

  if (raw.title !== undefined) {
    if (typeof raw.title !== 'string' || !raw.title.trim()) {
      throw new Error('webUi.signupPage.title must be a non-empty string when set.');
    }
    const title = raw.title.trim();
    if (title.length > MAX_TITLE) {
      throw new Error(`webUi.signupPage.title must be ≤${MAX_TITLE} characters.`);
    }
    out.title = title;
  }

  if (raw.tagline !== undefined) {
    if (typeof raw.tagline !== 'string' || !raw.tagline.trim()) {
      throw new Error('webUi.signupPage.tagline must be a non-empty string when set.');
    }
    const tagline = raw.tagline.trim();
    if (tagline.length > MAX_TAGLINE) {
      throw new Error(`webUi.signupPage.tagline must be ≤${MAX_TAGLINE} characters.`);
    }
    out.tagline = tagline;
  }

  if (raw.intro !== undefined) {
    if (!Array.isArray(raw.intro) || raw.intro.length === 0) {
      throw new Error('webUi.signupPage.intro must be a non-empty string array when set.');
    }
    if (raw.intro.length > MAX_INTRO) {
      throw new Error(`webUi.signupPage.intro supports at most ${MAX_INTRO} paragraphs.`);
    }
    out.intro = raw.intro.map((p, i) => {
      if (typeof p !== 'string' || !p.trim()) {
        throw new Error(`webUi.signupPage.intro[${i}] must be a non-empty string.`);
      }
      const t = p.trim();
      if (t.length > MAX_INTRO_LEN) {
        throw new Error(
          `webUi.signupPage.intro[${i}] must be ≤${MAX_INTRO_LEN} characters.`,
        );
      }
      return t;
    });
  }

  if (raw.bullets !== undefined) {
    if (!Array.isArray(raw.bullets) || raw.bullets.length === 0) {
      throw new Error('webUi.signupPage.bullets must be a non-empty string array when set.');
    }
    if (raw.bullets.length > MAX_BULLETS) {
      throw new Error(`webUi.signupPage.bullets supports at most ${MAX_BULLETS} items.`);
    }
    out.bullets = raw.bullets.map((b, i) => {
      if (typeof b !== 'string' || !b.trim()) {
        throw new Error(`webUi.signupPage.bullets[${i}] must be a non-empty string.`);
      }
      const t = b.trim();
      if (t.length > MAX_BULLET_LEN) {
        throw new Error(
          `webUi.signupPage.bullets[${i}] must be ≤${MAX_BULLET_LEN} characters.`,
        );
      }
      return t;
    });
  }

  if (raw.notice !== undefined) {
    if (typeof raw.notice !== 'string' || !raw.notice.trim()) {
      throw new Error('webUi.signupPage.notice must be a non-empty string when set.');
    }
    const notice = raw.notice.trim();
    if (notice.length > MAX_NOTICE) {
      throw new Error(`webUi.signupPage.notice must be ≤${MAX_NOTICE} characters.`);
    }
    out.notice = notice;
  }

  if (raw.footerNote !== undefined) {
    if (typeof raw.footerNote !== 'string' || !raw.footerNote.trim()) {
      throw new Error('webUi.signupPage.footerNote must be a non-empty string when set.');
    }
    const footerNote = raw.footerNote.trim();
    if (footerNote.length > MAX_FOOTER) {
      throw new Error(`webUi.signupPage.footerNote must be ≤${MAX_FOOTER} characters.`);
    }
    out.footerNote = footerNote;
  }

  if (raw.submitLabel !== undefined) {
    if (typeof raw.submitLabel !== 'string' || !raw.submitLabel.trim()) {
      throw new Error('webUi.signupPage.submitLabel must be a non-empty string when set.');
    }
    const submitLabel = raw.submitLabel.trim();
    if (submitLabel.length > MAX_SUBMIT) {
      throw new Error(`webUi.signupPage.submitLabel must be ≤${MAX_SUBMIT} characters.`);
    }
    out.submitLabel = submitLabel;
  }

  if (raw.accentColor !== undefined) {
    if (typeof raw.accentColor !== 'string' || !ACCENT_RE.test(raw.accentColor.trim())) {
      throw new Error(
        'webUi.signupPage.accentColor must be a CSS hex color (#rgb, #rrggbb, or #rrggbbaa).',
      );
    }
    out.accentColor = raw.accentColor.trim();
  }

  return out;
}

export function openSignupPublicConfig(): OpenSignupPublicConfig {
  const agentName = (config.agent.name || 'Agent').trim() || 'Agent';
  const page = registeredSignupPage;

  const title = page?.title ?? agentName;
  const envTagline = (process.env.UTARUS_SIGNUP_TAGLINE || '').trim();
  const tagline =
    page?.tagline
    ?? (envTagline || `Sign up to chat with ${agentName}.`);

  const formChrome = page?.formChrome !== false;
  const domainAssetsBase = registeredShell
    ? `/domain-assets/${registeredShell.agentKey}`
    : undefined;

  return {
    enabled: isOpenSignupEnabled(),
    agentName,
    shell: Boolean(registeredShell),
    formChrome,
    ...(domainAssetsBase ? { domainAssetsBase } : {}),
    title,
    tagline,
    intro: page?.intro ? [...page.intro] : [],
    bullets: page?.bullets ? [...page.bullets] : [],
    ...(page?.notice ? { notice: page.notice } : {}),
    ...(page?.footerNote ? { footerNote: page.footerNote } : {}),
    submitLabel: page?.submitLabel ?? 'Create account',
    ...(page?.accentColor ? { accentColor: page.accentColor } : {}),
  };
}
