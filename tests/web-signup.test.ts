import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  validateWebSignup,
  createWebSignupUser,
  emailTaken,
  SignupValidationError,
  postSignupRedirect,
  withLoginEmail,
  isOpenSignupEnabled,
  openSignupPublicConfig,
  setOpenSignupPageConfig,
  normalizeSignupPageConfig,
} from '../src/onboarding/web-signup.js';
import { loadState } from '../src/state/index.js';

let dataRoot: string;
const prevEnv: Record<string, string | undefined> = {};

function setEnv(k: string, v: string | undefined) {
  if (!(k in prevEnv)) prevEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'utarus-signup-'));
  setEnv('UTARUS_DATA_ROOT', dataRoot);
  setEnv('UTARUS_OPEN_SIGNUP_ENABLED', 'true');
  setEnv('UTARUS_AGENT_NAME', 'TestAgent');
  setOpenSignupPageConfig(undefined);
  mkdirSync(join(dataRoot, 'users'), { recursive: true });
});

afterEach(() => {
  setOpenSignupPageConfig(undefined);
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (existsSync(dataRoot)) rmSync(dataRoot, { recursive: true, force: true });
});

describe('isOpenSignupEnabled', () => {
  it('requires exact true', () => {
    setEnv('UTARUS_OPEN_SIGNUP_ENABLED', 'true');
    expect(isOpenSignupEnabled()).toBe(true);
    setEnv('UTARUS_OPEN_SIGNUP_ENABLED', '1');
    expect(isOpenSignupEnabled()).toBe(false);
    setEnv('UTARUS_OPEN_SIGNUP_ENABLED', undefined);
    expect(isOpenSignupEnabled()).toBe(false);
  });
});

describe('validateWebSignup', () => {
  it('accepts valid body', () => {
    const v = validateWebSignup({
      display_name: ' Acme ',
      email: 'A@B.COM',
      password: 'password1',
    });
    expect(v.display_name).toBe('Acme');
    expect(v.email).toBe('a@b.com');
    expect(v.reference).toBeUndefined();
  });

  it('accepts optional reference', () => {
    const v = validateWebSignup({
      display_name: 'Acme',
      email: 'a@b.com',
      password: 'password1',
      reference: ' partner-acme ',
    });
    expect(v.reference).toBe('partner-acme');
  });

  it('rejects invalid reference', () => {
    expect(() =>
      validateWebSignup({
        display_name: 'A',
        email: 'a@b.co',
        password: 'password1',
        reference: 'bad code!',
      }),
    ).toThrow(SignupValidationError);
  });

  it('rejects short password', () => {
    expect(() =>
      validateWebSignup({
        display_name: 'A',
        email: 'a@b.co',
        password: 'short',
      }),
    ).toThrow(SignupValidationError);
  });
});

describe('createWebSignupUser', () => {
  it('creates user with password_hash', async () => {
    const created = await createWebSignupUser({
      display_name: 'Smoke Seller',
      email: 'smoke@example.com',
      password: 'password1',
    });
    expect(created.slug).toMatch(/^smoke-seller/);
    const state = loadState(created.slug);
    expect(state.profile.contact_email).toBe('smoke@example.com');
    expect(state.user.password_hash).toBeTruthy();
    expect(state.user.reference).toBeUndefined();
    expect(emailTaken('SMOKE@example.com')).toBe(true);
  });

  it('stores reference on user and log', async () => {
    const created = await createWebSignupUser({
      display_name: 'Referred User',
      email: 'ref@example.com',
      password: 'password1',
      reference: 'partner-acme',
    });
    expect(created.reference).toBe('partner-acme');
    const state = loadState(created.slug);
    expect(state.user.reference).toBe('partner-acme');
    const signupLog = state.log.find((e) => e.action === 'web_signup');
    expect(signupLog?.reference).toBe('partner-acme');
  });

  it('rejects duplicate email', async () => {
    await createWebSignupUser({
      display_name: 'One',
      email: 'dupe@example.com',
      password: 'password1',
    });
    await expect(
      createWebSignupUser({
        display_name: 'Two',
        email: 'dupe@example.com',
        password: 'password1',
      }),
    ).rejects.toThrow(/already exists/i);
  });
});

describe('postSignupRedirect', () => {
  it('uses UTARUS_PUBLIC_BASE_URL/login by default', () => {
    setEnv('UTARUS_POST_SIGNUP_REDIRECT', undefined);
    setEnv('UTARUS_PUBLIC_BASE_URL', 'https://chat.example.com');
    expect(postSignupRedirect()).toBe('https://chat.example.com/login');
    expect(withLoginEmail(postSignupRedirect(), 'a@b.co')).toBe(
      'https://chat.example.com/login?email=a%40b.co',
    );
  });

  it('honors explicit redirect', () => {
    setEnv('UTARUS_POST_SIGNUP_REDIRECT', 'https://chat.example.com/login');
    expect(postSignupRedirect()).toBe('https://chat.example.com/login');
  });
});

describe('signupPage customization', () => {
  it('normalizes domain config and merges into public config', () => {
    setOpenSignupPageConfig({
      title: ' Acme ',
      tagline: ' Join us ',
      intro: [' Hello '],
      bullets: [' One ', ' Two '],
      notice: ' Beta ',
      footerNote: ' Footer ',
      submitLabel: ' Go ',
      accentColor: '#0f766e',
      formChrome: false,
    });
    const cfg = openSignupPublicConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.shell).toBe(false);
    expect(cfg.formChrome).toBe(false);
    expect(cfg.title).toBe('Acme');
    expect(cfg.tagline).toBe('Join us');
    expect(cfg.intro).toEqual(['Hello']);
    expect(cfg.bullets).toEqual(['One', 'Two']);
    expect(cfg.notice).toBe('Beta');
    expect(cfg.footerNote).toBe('Footer');
    expect(cfg.submitLabel).toBe('Go');
    expect(cfg.accentColor).toBe('#0f766e');
  });

  it('accepts shell relative path', () => {
    const n = normalizeSignupPageConfig({ shell: 'signup/shell.html' });
    expect(n.shell).toBe('signup/shell.html');
  });

  it('rejects path escape in shell', () => {
    expect(() =>
      normalizeSignupPageConfig({ shell: '../etc/passwd.html' }),
    ).toThrow(/relative path/i);
  });

  it('uses agent name and default tagline without domain page', () => {
    setEnv('UTARUS_SIGNUP_TAGLINE', undefined);
    setOpenSignupPageConfig(undefined);
    const cfg = openSignupPublicConfig();
    expect(cfg.title).toBeTruthy();
    expect(cfg.formChrome).toBe(true);
    expect(cfg.shell).toBe(false);
    expect(cfg.submitLabel).toBe('Create account');
    expect(cfg.intro).toEqual([]);
    expect(cfg.bullets).toEqual([]);
  });

  it('rejects invalid accent color', () => {
    expect(() =>
      normalizeSignupPageConfig({ accentColor: 'red' }),
    ).toThrow(/hex/i);
  });

  it('rejects empty intro entries', () => {
    expect(() =>
      normalizeSignupPageConfig({ intro: ['ok', '  '] }),
    ).toThrow(/intro\[1]/);
  });
});
