/**
 * Knowledge Base — types and named constants.
 *
 * See docs/knowledge-base-design.md. Fail-fast: no silent on-disk defaults.
 */

export const KB_FILE_VERSION = 1 as const;

export const MAX_ENTRIES_PER_USER = 200;
export const MAX_SHARED_ENTRIES = 500;
export const MAX_TITLE_CHARS = 200;
export const MAX_BODY_CHARS = 20_000;
export const MAX_TAGS_PER_ENTRY = 20;
export const MAX_TAG_CHARS = 40;
export const MAX_SEARCH_RESULTS = 25;
export const MAX_LIST_RESULTS = 50;
export const MAX_SUMMARY_CHARS = 240;

/** Same UUID shape as conversation / attachment ids. */
export const KB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const TAG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type KbScope = 'private' | 'shared';

export type KbProvenance = 'chat_tool' | 'api' | 'system';

export interface KbRef {
  kind: string;
  value: string;
}

export interface KnowledgeEntry {
  id: string;
  scope: KbScope;
  owner_slug: string;
  title: string;
  body: string;
  tags: string[];
  source: string | null;
  provenance: KbProvenance;
  domain_tag: string | null;
  refs: KbRef[];
  created_at: string;
  updated_at: string;
}

export interface UserKbFile {
  version: typeof KB_FILE_VERSION;
  user_slug: string;
  entries: KnowledgeEntry[];
  updated_at: string;
}

export interface SharedKbFile {
  version: typeof KB_FILE_VERSION;
  entries: KnowledgeEntry[];
  updated_at: string;
}

/** List/search row — never includes full body. */
export interface KbListRow {
  id: string;
  scope: KbScope;
  owner_slug: string;
  title: string;
  tags: string[];
  source: string | null;
  domain_tag: string | null;
  updated_at: string;
  created_at: string;
  body_preview: string;
  body_truncated: boolean;
}

const PROVENANCES: ReadonlySet<string> = new Set(['chat_tool', 'api', 'system']);

export function normalizeTag(raw: string): string {
  if (typeof raw !== 'string') {
    throw new Error('tag must be a string');
  }
  const t = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!t) {
    throw new Error(`tag is empty after normalize: ${JSON.stringify(raw)}`);
  }
  if (t.length > MAX_TAG_CHARS) {
    throw new Error(`tag exceeds ${MAX_TAG_CHARS} chars: ${t}`);
  }
  if (!TAG_PATTERN.test(t)) {
    throw new Error(`tag must be lowercase kebab-case: ${t}`);
  }
  return t;
}

/** Normalize tags, dedupe preserving first-seen order. */
export function normalizeTags(raw: string[] | undefined): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error('tags must be an array');
  }
  if (raw.length > MAX_TAGS_PER_ENTRY) {
    throw new Error(
      `tags exceed ${MAX_TAGS_PER_ENTRY} entries (got ${raw.length})`,
    );
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const t = normalizeTag(item);
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export function assertKbId(id: string): string {
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error('KB entry id is required');
  }
  const trimmed = id.trim();
  if (!KB_ID_PATTERN.test(trimmed)) {
    throw new Error(`KB entry id must be a UUID, got: ${JSON.stringify(id)}`);
  }
  return trimmed;
}

function assertIsoTimestamp(value: unknown, field: string, path: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`KB entry missing ${field}: ${path}`);
  }
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`KB entry ${field} is not a valid ISO date: ${path}`);
  }
  return value;
}

function assertRefs(raw: unknown, path: string): KbRef[] {
  if (!Array.isArray(raw)) {
    throw new Error(`KB entry refs must be an array: ${path}`);
  }
  return raw.map((r, i) => {
    if (!r || typeof r !== 'object') {
      throw new Error(`KB entry refs[${i}] must be an object: ${path}`);
    }
    const ref = r as Partial<KbRef>;
    if (typeof ref.kind !== 'string' || !ref.kind.trim()) {
      throw new Error(`KB entry refs[${i}].kind required: ${path}`);
    }
    if (typeof ref.value !== 'string' || !ref.value.trim()) {
      throw new Error(`KB entry refs[${i}].value required: ${path}`);
    }
    return { kind: ref.kind.trim(), value: ref.value.trim() };
  });
}

function assertEntryShape(
  raw: unknown,
  path: string,
  index: number,
): KnowledgeEntry {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`KB entries[${index}] is not a mapping: ${path}`);
  }
  const e = raw as Partial<KnowledgeEntry>;
  const id = e.id;
  if (typeof id !== 'string' || !KB_ID_PATTERN.test(id)) {
    throw new Error(`KB entries[${index}].id must be a UUID: ${path}`);
  }
  if (e.scope !== 'private' && e.scope !== 'shared') {
    throw new Error(`KB entries[${index}].scope invalid: ${path}`);
  }
  if (typeof e.owner_slug !== 'string' || !e.owner_slug) {
    throw new Error(`KB entries[${index}].owner_slug required: ${path}`);
  }
  if (typeof e.title !== 'string' || !e.title.trim()) {
    throw new Error(`KB entries[${index}].title required: ${path}`);
  }
  if (e.title.length > MAX_TITLE_CHARS) {
    throw new Error(
      `KB entries[${index}].title exceeds ${MAX_TITLE_CHARS} chars: ${path}`,
    );
  }
  if (typeof e.body !== 'string' || !e.body.trim()) {
    throw new Error(`KB entries[${index}].body required: ${path}`);
  }
  if (e.body.length > MAX_BODY_CHARS) {
    throw new Error(
      `KB entries[${index}].body exceeds ${MAX_BODY_CHARS} chars: ${path}`,
    );
  }
  if (!Array.isArray(e.tags)) {
    throw new Error(`KB entries[${index}].tags must be an array: ${path}`);
  }
  if (e.tags.length > MAX_TAGS_PER_ENTRY) {
    throw new Error(
      `KB entries[${index}].tags exceed ${MAX_TAGS_PER_ENTRY}: ${path}`,
    );
  }
  for (const t of e.tags) {
    if (typeof t !== 'string' || !TAG_PATTERN.test(t) || t.length > MAX_TAG_CHARS) {
      throw new Error(
        `KB entries[${index}].tags has invalid tag ${JSON.stringify(t)}: ${path}`,
      );
    }
  }
  if (e.source !== null && typeof e.source !== 'string') {
    throw new Error(`KB entries[${index}].source must be string|null: ${path}`);
  }
  if (typeof e.source === 'string' && !e.source.trim()) {
    throw new Error(`KB entries[${index}].source must be non-empty if set: ${path}`);
  }
  if (typeof e.provenance !== 'string' || !PROVENANCES.has(e.provenance)) {
    throw new Error(
      `KB entries[${index}].provenance invalid: ${path}`,
    );
  }
  if (e.domain_tag !== null && typeof e.domain_tag !== 'string') {
    throw new Error(
      `KB entries[${index}].domain_tag must be string|null: ${path}`,
    );
  }
  if (typeof e.domain_tag === 'string' && !e.domain_tag.trim()) {
    throw new Error(
      `KB entries[${index}].domain_tag must be non-empty if set: ${path}`,
    );
  }
  const refs = assertRefs(e.refs, path);
  const created_at = assertIsoTimestamp(e.created_at, 'created_at', path);
  const updated_at = assertIsoTimestamp(e.updated_at, 'updated_at', path);

  return {
    id,
    scope: e.scope,
    owner_slug: e.owner_slug,
    title: e.title,
    body: e.body,
    tags: e.tags as string[],
    source: e.source === undefined ? null : e.source,
    provenance: e.provenance as KbProvenance,
    domain_tag: e.domain_tag === undefined ? null : e.domain_tag,
    refs,
    created_at,
    updated_at,
  };
}

export function assertUserKbFileCoherent(
  raw: unknown,
  path: string,
  expectedSlug: string,
): UserKbFile {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`KB file is not a mapping: ${path}`);
  }
  const f = raw as Partial<UserKbFile>;
  if (f.version !== KB_FILE_VERSION) {
    throw new Error(
      `KB file version must be ${KB_FILE_VERSION}: ${path}`,
    );
  }
  if (typeof f.user_slug !== 'string' || !f.user_slug) {
    throw new Error(`KB file missing user_slug: ${path}`);
  }
  if (f.user_slug !== expectedSlug) {
    throw new Error(
      `KB file user_slug "${f.user_slug}" does not match expected "${expectedSlug}": ${path}`,
    );
  }
  if (!Array.isArray(f.entries)) {
    throw new Error(`KB file missing entries[]: ${path}`);
  }
  if (f.entries.length > MAX_ENTRIES_PER_USER) {
    throw new Error(
      `KB file exceeds ${MAX_ENTRIES_PER_USER} entries: ${path}`,
    );
  }
  const updated_at = assertIsoTimestamp(f.updated_at, 'updated_at', path);
  const ids = new Set<string>();
  const entries: KnowledgeEntry[] = f.entries.map((e, i) => {
    const entry = assertEntryShape(e, path, i);
    if (entry.scope !== 'private') {
      throw new Error(
        `KB private file entries[${i}].scope must be private: ${path}`,
      );
    }
    if (entry.owner_slug !== expectedSlug) {
      throw new Error(
        `KB private file entries[${i}].owner_slug must be ${expectedSlug}: ${path}`,
      );
    }
    if (ids.has(entry.id)) {
      throw new Error(`KB file duplicate entry id ${entry.id}: ${path}`);
    }
    ids.add(entry.id);
    return entry;
  });

  return {
    version: KB_FILE_VERSION,
    user_slug: f.user_slug,
    entries,
    updated_at,
  };
}

export function assertSharedKbFileCoherent(
  raw: unknown,
  path: string,
): SharedKbFile {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`KB shared file is not a mapping: ${path}`);
  }
  const f = raw as Partial<SharedKbFile>;
  if (f.version !== KB_FILE_VERSION) {
    throw new Error(
      `KB shared file version must be ${KB_FILE_VERSION}: ${path}`,
    );
  }
  if (!Array.isArray(f.entries)) {
    throw new Error(`KB shared file missing entries[]: ${path}`);
  }
  if (f.entries.length > MAX_SHARED_ENTRIES) {
    throw new Error(
      `KB shared file exceeds ${MAX_SHARED_ENTRIES} entries: ${path}`,
    );
  }
  const updated_at = assertIsoTimestamp(f.updated_at, 'updated_at', path);
  const ids = new Set<string>();
  const entries: KnowledgeEntry[] = f.entries.map((e, i) => {
    const entry = assertEntryShape(e, path, i);
    if (entry.scope !== 'shared') {
      throw new Error(
        `KB shared file entries[${i}].scope must be shared: ${path}`,
      );
    }
    if (!entry.owner_slug) {
      throw new Error(
        `KB shared file entries[${i}].owner_slug required: ${path}`,
      );
    }
    if (ids.has(entry.id)) {
      throw new Error(`KB shared file duplicate entry id ${entry.id}: ${path}`);
    }
    ids.add(entry.id);
    return entry;
  });

  return {
    version: KB_FILE_VERSION,
    entries,
    updated_at,
  };
}

export function emptyUserKbFile(userSlug: string, updatedAt: string): UserKbFile {
  return {
    version: KB_FILE_VERSION,
    user_slug: userSlug,
    entries: [],
    updated_at: updatedAt,
  };
}

export function emptySharedKbFile(updatedAt: string): SharedKbFile {
  return {
    version: KB_FILE_VERSION,
    entries: [],
    updated_at: updatedAt,
  };
}

export function toListRow(e: KnowledgeEntry): KbListRow {
  const truncated = e.body.length > MAX_SUMMARY_CHARS;
  return {
    id: e.id,
    scope: e.scope,
    owner_slug: e.owner_slug,
    title: e.title,
    tags: e.tags,
    source: e.source,
    domain_tag: e.domain_tag,
    updated_at: e.updated_at,
    created_at: e.created_at,
    body_preview: e.body.slice(0, MAX_SUMMARY_CHARS),
    body_truncated: truncated,
  };
}
