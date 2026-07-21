/**
 * Knowledge Base service — ACL, create/update/delete, list/search.
 * Single validation path for agent tools (and future REST).
 */

import { randomUUID } from 'crypto';
import {
  ensureUserKbFileForCreate,
  listEntriesForUser,
  loadSharedKbFile,
  loadUserKbFile,
  saveSharedKbFile,
  saveUserKbFile,
  userKbFilePath,
  withKbFileLock,
} from './kb-file.js';
import { filterEntries, searchEntries } from './search.js';
import {
  assertKbId,
  MAX_BODY_CHARS,
  MAX_ENTRIES_PER_USER,
  MAX_LIST_RESULTS,
  MAX_SEARCH_RESULTS,
  MAX_SHARED_ENTRIES,
  MAX_TITLE_CHARS,
  normalizeTags,
  toListRow,
  type KbListRow,
  type KbProvenance,
  type KbRef,
  type KbScope,
  type KnowledgeEntry,
} from './types.js';
import { existsSync } from 'fs';
import { assertValidSlug } from '../state/state-file.js';

const NOT_FOUND = (id: string) =>
  `KB entry not found or not accessible: ${id}`;

export function assertCanRead(
  entry: KnowledgeEntry,
  userSlug: string,
  _isAdmin: boolean,
): void {
  if (!userSlug) {
    throw new Error('authenticated user slug is required');
  }
  if (entry.scope === 'shared') return;
  if (entry.scope === 'private' && entry.owner_slug === userSlug) return;
  throw new Error(NOT_FOUND(entry.id));
}

export function assertCanWrite(
  entry: KnowledgeEntry | { scope: KbScope; owner_slug?: string; id?: string },
  userSlug: string,
  isAdmin: boolean,
): void {
  if (!userSlug) {
    throw new Error('authenticated user slug is required');
  }
  if (entry.scope === 'shared') {
    if (!isAdmin) {
      throw new Error('Only admins can write shared knowledge entries.');
    }
    return;
  }
  if (entry.owner_slug !== undefined && entry.owner_slug !== userSlug) {
    const id = 'id' in entry && entry.id ? entry.id : 'unknown';
    throw new Error(NOT_FOUND(id));
  }
}

function requireUserSlug(userSlug: string): string {
  if (!userSlug || typeof userSlug !== 'string') {
    throw new Error('authenticated user slug is required');
  }
  // WebUI admin uses slug "admin" which is valid kebab; real users too.
  assertValidSlug(userSlug);
  return userSlug;
}

function clampLimit(
  limit: number | undefined,
  max: number,
  label: string,
): number {
  if (limit === undefined) {
    return max;
  }
  if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1) {
    throw new Error(
      `${label} limit must be a positive integer, got: ${limit}`,
    );
  }
  return Math.min(limit, max);
}

function assertTitle(title: string): string {
  if (typeof title !== 'string') {
    throw new Error('title must be a string');
  }
  const t = title.trim();
  if (!t) {
    throw new Error('title is required');
  }
  if (t.length > MAX_TITLE_CHARS) {
    throw new Error(`title exceeds ${MAX_TITLE_CHARS} chars`);
  }
  return t;
}

function assertBody(body: string): string {
  if (typeof body !== 'string') {
    throw new Error('body must be a string');
  }
  const b = body.trim();
  if (!b) {
    throw new Error('body is required');
  }
  if (b.length > MAX_BODY_CHARS) {
    throw new Error(`body exceeds ${MAX_BODY_CHARS} chars`);
  }
  return b;
}

function assertOptionalNonEmptyString(
  value: string | null | undefined,
  field: string,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`${field} must be string or null`);
  }
  const t = value.trim();
  if (!t) {
    throw new Error(`${field} must be non-empty if set`);
  }
  return t;
}

function assertRefsParam(raw: unknown): KbRef[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error('refs must be an array');
  }
  return raw.map((r, i) => {
    if (!r || typeof r !== 'object') {
      throw new Error(`refs[${i}] must be an object`);
    }
    const ref = r as { kind?: string; value?: string };
    if (typeof ref.kind !== 'string' || !ref.kind.trim()) {
      throw new Error(`refs[${i}].kind is required`);
    }
    if (typeof ref.value !== 'string' || !ref.value.trim()) {
      throw new Error(`refs[${i}].value is required`);
    }
    return { kind: ref.kind.trim(), value: ref.value.trim() };
  });
}

function resolveCandidates(
  userSlug: string,
  scope: KbScope | undefined,
): KnowledgeEntry[] {
  if (scope === 'private') {
    return listEntriesForUser(userSlug);
  }
  if (scope === 'shared') {
    return loadSharedKbFile().entries;
  }
  // omit = both
  return [...listEntriesForUser(userSlug), ...loadSharedKbFile().entries];
}

export function listKb(params: {
  userSlug: string;
  isAdmin: boolean;
  scope?: KbScope;
  tag?: string;
  limit?: number;
}): KbListRow[] {
  const userSlug = requireUserSlug(params.userSlug);
  const limit = clampLimit(params.limit, MAX_LIST_RESULTS, 'list_kb');
  const candidates = resolveCandidates(userSlug, params.scope);
  // ACL: private already bound; shared readable by any auth user
  const filtered = filterEntries(candidates, {
    tag: params.tag,
    limit,
  });
  return filtered.map(toListRow);
}

export function searchKb(params: {
  userSlug: string;
  isAdmin: boolean;
  query: string;
  scope?: KbScope;
  tag?: string;
  limit?: number;
}): KbListRow[] {
  const userSlug = requireUserSlug(params.userSlug);
  const limit = clampLimit(params.limit, MAX_SEARCH_RESULTS, 'search_kb');
  const candidates = resolveCandidates(userSlug, params.scope);
  const found = searchEntries(candidates, {
    query: params.query,
    tag: params.tag,
    limit,
  });
  return found.map(toListRow);
}

export function getKb(params: {
  userSlug: string;
  isAdmin: boolean;
  id: string;
}): KnowledgeEntry {
  const userSlug = requireUserSlug(params.userSlug);
  const id = assertKbId(params.id);

  // Private first (missing file = no private hit; corrupt = throw)
  const path = userKbFilePath(userSlug);
  if (existsSync(path)) {
    const file = loadUserKbFile(userSlug);
    const hit = file.entries.find((e) => e.id === id);
    if (hit) {
      assertCanRead(hit, userSlug, params.isAdmin);
      return hit;
    }
  }

  const shared = loadSharedKbFile();
  const sharedHit = shared.entries.find((e) => e.id === id);
  if (sharedHit) {
    assertCanRead(sharedHit, userSlug, params.isAdmin);
    return sharedHit;
  }

  throw new Error(NOT_FOUND(id));
}

export interface CreateKbInput {
  userSlug: string;
  isAdmin: boolean;
  scope: KbScope;
  title: string;
  body: string;
  tags?: string[];
  source?: string;
  domain_tag?: string;
  refs?: Array<{ kind: string; value: string }>;
  provenance?: KbProvenance;
}

export async function createKb(input: CreateKbInput): Promise<KnowledgeEntry> {
  const userSlug = requireUserSlug(input.userSlug);
  if (input.scope !== 'private' && input.scope !== 'shared') {
    throw new Error('scope must be "private" or "shared"');
  }
  assertCanWrite({ scope: input.scope, owner_slug: userSlug }, userSlug, input.isAdmin);

  const title = assertTitle(input.title);
  const body = assertBody(input.body);
  const tags = normalizeTags(input.tags);
  let source: string | null = null;
  if (input.source !== undefined) {
    const s = assertOptionalNonEmptyString(input.source, 'source');
    if (s === null || s === undefined) {
      throw new Error('source must be non-empty if set');
    }
    source = s;
  }
  let domain_tag: string | null = null;
  if (input.domain_tag !== undefined) {
    const d = assertOptionalNonEmptyString(input.domain_tag, 'domain_tag');
    if (d === null || d === undefined) {
      throw new Error('domain_tag must be non-empty if set');
    }
    domain_tag = d;
  }
  const refs = assertRefsParam(input.refs);
  const provenance: KbProvenance = input.provenance ?? 'chat_tool';
  const now = new Date().toISOString();
  const entry: KnowledgeEntry = {
    id: randomUUID(),
    scope: input.scope,
    owner_slug: userSlug,
    title,
    body,
    tags,
    source,
    provenance,
    domain_tag,
    refs,
    created_at: now,
    updated_at: now,
  };

  if (input.scope === 'private') {
    return withKbFileLock(`user:${userSlug}`, () => {
      const file = ensureUserKbFileForCreate(userSlug);
      if (file.entries.length >= MAX_ENTRIES_PER_USER) {
        throw new Error(
          `Private KB is full (${MAX_ENTRIES_PER_USER} entries max)`,
        );
      }
      file.entries.push(entry);
      file.updated_at = now;
      saveUserKbFile(file);
      return entry;
    });
  }

  return withKbFileLock('shared', () => {
    const file = loadSharedKbFile();
    if (file.entries.length >= MAX_SHARED_ENTRIES) {
      throw new Error(
        `Shared KB is full (${MAX_SHARED_ENTRIES} entries max)`,
      );
    }
    file.entries.push(entry);
    file.updated_at = now;
    saveSharedKbFile(file);
    return entry;
  });
}

export interface UpdateKbInput {
  userSlug: string;
  isAdmin: boolean;
  id: string;
  title?: string;
  body?: string;
  tags?: string[];
  refs?: Array<{ kind: string; value: string }>;
  /** omit = unchanged; null = clear; string = set */
  source?: string | null;
  domain_tag?: string | null;
}

export async function updateKb(input: UpdateKbInput): Promise<KnowledgeEntry> {
  const userSlug = requireUserSlug(input.userSlug);
  const id = assertKbId(input.id);

  // Locate entry under lock after finding which store
  const locate = (): { store: 'private' | 'shared'; entry: KnowledgeEntry } => {
    const path = userKbFilePath(userSlug);
    if (existsSync(path)) {
      const file = loadUserKbFile(userSlug);
      const hit = file.entries.find((e) => e.id === id);
      if (hit) return { store: 'private', entry: hit };
    }
    const shared = loadSharedKbFile();
    const sharedHit = shared.entries.find((e) => e.id === id);
    if (sharedHit) return { store: 'shared', entry: sharedHit };
    throw new Error(NOT_FOUND(id));
  };

  const { store, entry: existing } = locate();
  assertCanWrite(existing, userSlug, input.isAdmin);

  const now = new Date().toISOString();
  const next: KnowledgeEntry = { ...existing, updated_at: now };

  if (input.title !== undefined) {
    if (input.title === null) {
      throw new Error('title cannot be null');
    }
    next.title = assertTitle(input.title);
  }
  if (input.body !== undefined) {
    if (input.body === null) {
      throw new Error('body cannot be null');
    }
    next.body = assertBody(input.body);
  }
  if (input.tags !== undefined) {
    if (input.tags === null) {
      throw new Error('tags cannot be null (use empty array to clear)');
    }
    next.tags = normalizeTags(input.tags);
  }
  if (input.refs !== undefined) {
    if (input.refs === null) {
      throw new Error('refs cannot be null (use empty array to clear)');
    }
    next.refs = assertRefsParam(input.refs);
  }
  if (input.source !== undefined) {
    if (input.source === null) {
      next.source = null;
    } else {
      const s = assertOptionalNonEmptyString(input.source, 'source');
      if (s === null || s === undefined) {
        throw new Error('source must be non-empty if set');
      }
      next.source = s;
    }
  }
  if (input.domain_tag !== undefined) {
    if (input.domain_tag === null) {
      next.domain_tag = null;
    } else {
      const d = assertOptionalNonEmptyString(input.domain_tag, 'domain_tag');
      if (d === null || d === undefined) {
        throw new Error('domain_tag must be non-empty if set');
      }
      next.domain_tag = d;
    }
  }

  if (store === 'private') {
    return withKbFileLock(`user:${userSlug}`, () => {
      const file = loadUserKbFile(userSlug);
      const idx = file.entries.findIndex((e) => e.id === id);
      if (idx < 0) throw new Error(NOT_FOUND(id));
      assertCanWrite(file.entries[idx]!, userSlug, input.isAdmin);
      file.entries[idx] = next;
      file.updated_at = now;
      saveUserKbFile(file);
      return next;
    });
  }

  return withKbFileLock('shared', () => {
    const file = loadSharedKbFile();
    const idx = file.entries.findIndex((e) => e.id === id);
    if (idx < 0) throw new Error(NOT_FOUND(id));
    assertCanWrite(file.entries[idx]!, userSlug, input.isAdmin);
    file.entries[idx] = next;
    file.updated_at = now;
    saveSharedKbFile(file);
    return next;
  });
}

export async function deleteKb(params: {
  userSlug: string;
  isAdmin: boolean;
  id: string;
}): Promise<{ id: string; scope: KbScope }> {
  const userSlug = requireUserSlug(params.userSlug);
  const id = assertKbId(params.id);

  const path = userKbFilePath(userSlug);
  if (existsSync(path)) {
    const file = loadUserKbFile(userSlug);
    const hit = file.entries.find((e) => e.id === id);
    if (hit) {
      assertCanWrite(hit, userSlug, params.isAdmin);
      return withKbFileLock(`user:${userSlug}`, () => {
        const f = loadUserKbFile(userSlug);
        const idx = f.entries.findIndex((e) => e.id === id);
        if (idx < 0) throw new Error(NOT_FOUND(id));
        assertCanWrite(f.entries[idx]!, userSlug, params.isAdmin);
        f.entries.splice(idx, 1);
        f.updated_at = new Date().toISOString();
        saveUserKbFile(f);
        return { id, scope: 'private' as const };
      });
    }
  }

  const shared = loadSharedKbFile();
  const sharedHit = shared.entries.find((e) => e.id === id);
  if (sharedHit) {
    assertCanWrite(sharedHit, userSlug, params.isAdmin);
    return withKbFileLock('shared', () => {
      const f = loadSharedKbFile();
      const idx = f.entries.findIndex((e) => e.id === id);
      if (idx < 0) throw new Error(NOT_FOUND(id));
      assertCanWrite(f.entries[idx]!, userSlug, params.isAdmin);
      f.entries.splice(idx, 1);
      f.updated_at = new Date().toISOString();
      saveSharedKbFile(f);
      return { id, scope: 'shared' as const };
    });
  }

  throw new Error(NOT_FOUND(id));
}
