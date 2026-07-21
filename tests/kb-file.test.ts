import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const dataRoot = mkdtempSync(join(tmpdir(), 'utarus-kb-file-'));
process.env.UTARUS_LOADED_BY_HOST = '1';
process.env.UTARUS_DATA_ROOT = dataRoot;

const {
  ensureUserKbFileForCreate,
  listEntriesForUser,
  loadUserKbFile,
  loadSharedKbFile,
  saveUserKbFile,
  saveSharedKbFile,
  userKbFilePath,
  sharedKbFilePath,
  withKbFileLock,
} = await import('../src/kb/kb-file.js');
const { blankState, saveState } = await import('../src/state/state-file.js');
const {
  MAX_ENTRIES_PER_USER,
  emptyUserKbFile,
  emptySharedKbFile,
} = await import('../src/kb/types.js');

function seedUser(slug: string): void {
  saveState(
    blankState({
      slug,
      displayName: slug,
      contactEmail: `${slug}@example.com`,
    }),
  );
}

describe('kb-file I/O', () => {
  beforeEach(() => {
    rmSync(dataRoot, { recursive: true, force: true });
    mkdirSync(join(dataRoot, 'users'), { recursive: true });
    mkdirSync(join(dataRoot, 'kb', 'users'), { recursive: true });
  });

  afterAll(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('listEntriesForUser returns [] when file missing (no write)', () => {
    seedUser('alice');
    expect(listEntriesForUser('alice')).toEqual([]);
    expect(existsSync(userKbFilePath('alice'))).toBe(false);
  });

  it('loadUserKbFile throws when missing', () => {
    seedUser('alice');
    expect(() => loadUserKbFile('alice')).toThrow(/KB file not found/);
  });

  it('ensureUserKbFileForCreate requires user state then creates empty file', () => {
    expect(() => ensureUserKbFileForCreate('nobody')).toThrow(/not found|User state/);
    seedUser('alice');
    const file = ensureUserKbFileForCreate('alice');
    expect(file.user_slug).toBe('alice');
    expect(file.entries).toEqual([]);
    expect(existsSync(userKbFilePath('alice'))).toBe(true);
    // second call loads existing
    const again = ensureUserKbFileForCreate('alice');
    expect(again.user_slug).toBe('alice');
  });

  it('loadSharedKbFile returns empty in-memory without writing when missing', () => {
    const file = loadSharedKbFile();
    expect(file.entries).toEqual([]);
    expect(existsSync(sharedKbFilePath())).toBe(false);
  });

  it('saveSharedKbFile creates shared.yaml', () => {
    const now = new Date().toISOString();
    const file = emptySharedKbFile(now);
    saveSharedKbFile(file);
    expect(existsSync(sharedKbFilePath())).toBe(true);
    expect(loadSharedKbFile().entries).toEqual([]);
  });

  it('throws on corrupt private file', () => {
    seedUser('alice');
    const path = userKbFilePath('alice');
    mkdirSync(join(dataRoot, 'kb', 'users'), { recursive: true });
    writeFileSync(path, 'version: 99\nentries: []\n', 'utf-8');
    expect(() => loadUserKbFile('alice')).toThrow(/version/);
  });

  it('rejects save over cap', () => {
    seedUser('alice');
    const now = new Date().toISOString();
    const file = emptyUserKbFile('alice', now);
    for (let i = 0; i < MAX_ENTRIES_PER_USER + 1; i++) {
      file.entries.push({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        scope: 'private',
        owner_slug: 'alice',
        title: `t${i}`,
        body: `b${i}`,
        tags: [],
        source: null,
        provenance: 'chat_tool',
        domain_tag: null,
        refs: [],
        created_at: now,
        updated_at: now,
      });
    }
    expect(() => saveUserKbFile(file)).toThrow(/200/);
  });

  it('withKbFileLock serializes concurrent work on same key', async () => {
    const order: number[] = [];
    await Promise.all([
      withKbFileLock('shared', async () => {
        order.push(1);
        await new Promise((r) => setTimeout(r, 30));
        order.push(2);
      }),
      withKbFileLock('shared', async () => {
        order.push(3);
        order.push(4);
      }),
    ]);
    expect(order).toEqual([1, 2, 3, 4]);
  });
});
