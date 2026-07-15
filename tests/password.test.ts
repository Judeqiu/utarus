import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { stringify } from 'yaml';

const dataRoot = mkdtempSync(join(tmpdir(), 'utarus-password-'));
process.env.UTARUS_DATA_ROOT = dataRoot;
process.env.UTARUS_LOADED_BY_HOST = '1';

const { hashPassword, verifyPassword, generateMemorablePassword } =
  await import('../src/auth/password.js');
const { authenticateUser, createSession } = await import('../src/webapp/auth.js');
const { loadState } = await import('../src/state/index.js');

describe('password primitives', () => {
  it('hashPassword returns a bcrypt hash that verifyPassword accepts', async () => {
    const hash = await hashPassword('hunter2hunter2');
    expect(hash).toMatch(/^\$2[aby]?\$/);
    expect(await verifyPassword('hunter2hunter2', hash)).toBe(true);
    expect(await verifyPassword('wrong-password', hash)).toBe(false);
  });

  it('hashPassword rejects too-short plaintext (no fallback)', async () => {
    await expect(hashPassword('short')).rejects.toThrow(/at least 6 chars/i);
    await expect(hashPassword('')).rejects.toThrow(/at least 6 chars/i);
  });

  it('verifyPassword returns false for empty inputs (no throw)', async () => {
    expect(await verifyPassword('', '$2b$10$abc')).toBe(false);
    expect(await verifyPassword('plain', '')).toBe(false);
  });

  it('generateMemorablePassword emits three lowercase words joined by hyphens', () => {
    const pw = generateMemorablePassword();
    expect(pw).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
    const words = pw.split('-');
    expect(words).toHaveLength(3);
    words.forEach(w => expect(w.length).toBeGreaterThan(0));
  });

  it('generateMemorablePassword returns different values across calls (entropy sanity)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) seen.add(generateMemorablePassword());
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('authenticateUser', () => {
  beforeAll(async () => {
    const usersDir = join(dataRoot, 'users');
    mkdirSync(usersDir, { recursive: true });
    const cyHash = await hashPassword('correct-battery-horse');
    writeFileSync(
      join(usersDir, 'cy.yaml'),
      stringify({
        user: {
          id: '11111111-1111-1111-1111-111111111111',
          slug: 'cy',
          created_at: '2026-07-15',
          auth_token: 'cy-token',
          password_hash: cyHash,
        },
        profile: { display_name: 'CY', contact_email: 'cy@example.com' },
        log: [],
      }),
    );
    writeFileSync(
      join(usersDir, 'david.yaml'),
      stringify({
        user: {
          id: '22222222-2222-2222-2222-222222222222',
          slug: 'david',
          created_at: '2026-07-15',
          auth_token: 'david-token',
          // no password_hash — legacy user
        },
        profile: { display_name: 'David', contact_email: 'david@example.com' },
        log: [],
      }),
    );
  });

  afterAll(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('authenticates by slug + correct password', async () => {
    const user = await authenticateUser('cy', 'correct-battery-horse');
    expect(user).not.toBeNull();
    expect(user?.type).toBe('user');
    expect(user?.slug).toBe('cy');
    expect(user?.displayName).toBe('CY');
    expect(user?.userId).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('authenticates by contact_email + correct password (case-insensitive)', async () => {
    const user = await authenticateUser('CY@EXAMPLE.COM', 'correct-battery-horse');
    expect(user?.slug).toBe('cy');
  });

  it('rejects correct slug + wrong password', async () => {
    const user = await authenticateUser('cy', 'wrong-password');
    expect(user).toBeNull();
  });

  it('rejects unknown identifier', async () => {
    const user = await authenticateUser('nobody', 'whatever-xxxxxx');
    expect(user).toBeNull();
  });

  it('rejects empty identifier', async () => {
    const user = await authenticateUser('', 'whatever-xxxxxx');
    expect(user).toBeNull();
  });

  it('returns null for legacy user without password_hash (no fallback)', async () => {
    // David exists but has no password_hash — cannot authenticate this way.
    const user = await authenticateUser('david', 'anything');
    expect(user).toBeNull();
  });

  it('authenticateUser result is compatible with createSession', async () => {
    const user = await authenticateUser('cy', 'correct-battery-horse');
    expect(user).not.toBeNull();
    const sessionToken = createSession(user!);
    expect(typeof sessionToken).toBe('string');
    expect(sessionToken.length).toBeGreaterThan(0);
  });

  it('persisted hash on disk verifies against original plaintext', async () => {
    const state = loadState('cy');
    expect(state.user.password_hash).toBeTruthy();
    expect(await verifyPassword('correct-battery-horse', state.user.password_hash!)).toBe(true);
  });
});
