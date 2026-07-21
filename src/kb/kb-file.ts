/**
 * Knowledge Base file I/O under DATA_ROOT/kb/.
 *
 * - Private: data/kb/users/<slug>.yaml
 * - Shared: data/kb/shared.yaml
 * - No create-on-miss on read paths (unlike usage-file).
 * - Atomic tmp+rename saves; chain-promise locks like billing.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { parse, stringify } from 'yaml';
import { resolveDataRoot } from '../config.js';
import { assertValidSlug, loadState } from '../state/state-file.js';
import {
  assertSharedKbFileCoherent,
  assertUserKbFileCoherent,
  emptySharedKbFile,
  emptyUserKbFile,
  type SharedKbFile,
  type UserKbFile,
} from './types.js';

const locks = new Map<string, Promise<unknown>>();

export function kbDir(): string {
  return join(resolveDataRoot(), 'kb');
}

export function userKbDir(): string {
  return join(kbDir(), 'users');
}

export function userKbFilePath(slug: string): string {
  assertValidSlug(slug);
  return join(userKbDir(), `${slug}.yaml`);
}

export function sharedKbFilePath(): string {
  return join(kbDir(), 'shared.yaml');
}

function atomicWriteYaml(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const yaml = stringify(data, { sortMapEntries: false });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, yaml, 'utf-8');
  renameSync(tmp, path);
}

/**
 * Serialize load→modify→save for a KB file key.
 * Keys: `user:${slug}` | `shared` (billing-style chain-promise).
 */
export async function withKbFileLock<T>(
  key: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  if (key === 'shared') {
    // ok
  } else if (key.startsWith('user:')) {
    const slug = key.slice('user:'.length);
    assertValidSlug(slug);
  } else {
    throw new Error(
      `KB lock key must be "shared" or "user:<slug>", got: ${JSON.stringify(key)}`,
    );
  }

  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prev.then(() => gate);
  locks.set(key, chained);

  await prev.catch(() => {
    /* previous op failed — still run next */
  });
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === chained) {
      locks.delete(key);
    }
  }
}

export function loadUserKbFile(slug: string): UserKbFile {
  assertValidSlug(slug);
  const path = userKbFilePath(slug);
  if (!existsSync(path)) {
    throw new Error(`KB file not found: ${path}`);
  }
  const raw = parse(readFileSync(path, 'utf-8'));
  return assertUserKbFileCoherent(raw, path, slug);
}

/** Missing file → []; corrupt → throw. No write. */
export function listEntriesForUser(slug: string): UserKbFile['entries'] {
  assertValidSlug(slug);
  const path = userKbFilePath(slug);
  if (!existsSync(path)) {
    return [];
  }
  const raw = parse(readFileSync(path, 'utf-8'));
  return assertUserKbFileCoherent(raw, path, slug).entries;
}

/**
 * Ensure private file exists for create. Requires existing user state.
 * Corrupt existing → throw. Missing → create empty file after loadState.
 */
export function ensureUserKbFileForCreate(slug: string): UserKbFile {
  assertValidSlug(slug);
  // Fail-fast if user does not exist
  loadState(slug);

  const path = userKbFilePath(slug);
  if (existsSync(path)) {
    const raw = parse(readFileSync(path, 'utf-8'));
    return assertUserKbFileCoherent(raw, path, slug);
  }

  const now = new Date().toISOString();
  const file = emptyUserKbFile(slug, now);
  assertUserKbFileCoherent(file, '<in-memory>', slug);
  atomicWriteYaml(path, file);
  return file;
}

export function saveUserKbFile(file: UserKbFile): string {
  if (!file?.user_slug) {
    throw new Error('Cannot save KB file without user_slug');
  }
  assertValidSlug(file.user_slug);
  const path = userKbFilePath(file.user_slug);
  const coherent = assertUserKbFileCoherent(file, '<in-memory>', file.user_slug);
  atomicWriteYaml(path, coherent);
  return path;
}

/**
 * Missing shared file → empty coherent in-memory (no write).
 * Present but corrupt → throw.
 */
export function loadSharedKbFile(): SharedKbFile {
  const path = sharedKbFilePath();
  if (!existsSync(path)) {
    return emptySharedKbFile(new Date().toISOString());
  }
  const raw = parse(readFileSync(path, 'utf-8'));
  return assertSharedKbFileCoherent(raw, path);
}

export function saveSharedKbFile(file: SharedKbFile): string {
  const path = sharedKbFilePath();
  const coherent = assertSharedKbFileCoherent(file, '<in-memory>');
  atomicWriteYaml(path, coherent);
  return path;
}
