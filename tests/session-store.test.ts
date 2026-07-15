/**
 * Disk-backed browser sessions — survive process restart simulation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const dataRoot = mkdtempSync(join(tmpdir(), 'utarus-session-'));
process.env.UTARUS_DATA_ROOT = dataRoot;

const {
  createSession,
  getSession,
  destroySession,
  setSessionStorePathForTests,
} = await import('../src/webapp/auth.js');

describe('disk-backed sessions', () => {
  const storePath = join(dataRoot, '.sessions.json');

  beforeEach(() => {
    setSessionStorePathForTests(storePath);
  });

  afterEach(() => {
    setSessionStorePathForTests(null);
  });

  it('createSession persists to disk and getSession returns user', () => {
    const token = createSession({
      type: 'user',
      slug: 'seller-a',
      displayName: 'Seller A',
    });
    expect(existsSync(storePath)).toBe(true);
    const user = getSession(token);
    expect(user?.slug).toBe('seller-a');
    expect(user?.displayName).toBe('Seller A');
  });

  it('survives in-memory clear (restart simulation)', () => {
    const token = createSession({
      type: 'admin',
      slug: 'admin-1',
      displayName: 'Admin',
    });
    // Simulate new process: drop memory, keep disk file.
    setSessionStorePathForTests(storePath);
    const user = getSession(token);
    expect(user?.slug).toBe('admin-1');
    expect(user?.type).toBe('admin');
  });

  it('destroySession removes token from disk', () => {
    const token = createSession({
      type: 'user',
      slug: 'gone',
      displayName: 'Gone',
    });
    destroySession(token);
    expect(getSession(token)).toBeNull();
    const raw = readFileSync(storePath, 'utf-8');
    expect(raw).not.toContain(token);
  });

  it('returns null for unknown token', () => {
    expect(getSession('not-a-real-session-token')).toBeNull();
  });
});

// cleanup data root after suite
afterEach(() => {
  // keep dir for other tests in file; final cleanup below
});

// vitest runs file once — remove temp dir at end of process
process.on('exit', () => {
  try {
    rmSync(dataRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
