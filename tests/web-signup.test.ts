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
  mkdirSync(join(dataRoot, 'users'), { recursive: true });
});

afterEach(() => {
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
    expect(emailTaken('SMOKE@example.com')).toBe(true);
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
