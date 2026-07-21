/**
 * Pure KB filter/search helpers — no I/O, no hard list/search caps inside.
 * Callers pass already-clamped limit (≥ 1).
 */

import { normalizeTag, type KnowledgeEntry } from './types.js';

function assertPositiveIntLimit(limit: number): number {
  if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1) {
    throw new Error(`limit must be a positive integer, got: ${limit}`);
  }
  return limit;
}

function sortByUpdatedDescIdAsc(entries: KnowledgeEntry[]): KnowledgeEntry[] {
  return [...entries].sort((a, b) => {
    if (a.updated_at !== b.updated_at) {
      return a.updated_at < b.updated_at ? 1 : -1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function filterEntries(
  entries: KnowledgeEntry[],
  opts: { tag?: string; limit: number },
): KnowledgeEntry[] {
  const limit = assertPositiveIntLimit(opts.limit);
  let out = entries;
  if (opts.tag !== undefined) {
    const tag = normalizeTag(opts.tag);
    out = out.filter((e) => e.tags.includes(tag));
  }
  return sortByUpdatedDescIdAsc(out).slice(0, limit);
}

export function searchEntries(
  entries: KnowledgeEntry[],
  opts: { query: string; tag?: string; limit: number },
): KnowledgeEntry[] {
  const limit = assertPositiveIntLimit(opts.limit);
  if (typeof opts.query !== 'string') {
    throw new Error('query must be a string');
  }
  const q = opts.query.trim().toLowerCase();
  if (!q) {
    throw new Error('query must be non-empty');
  }
  let out = entries;
  if (opts.tag !== undefined) {
    const tag = normalizeTag(opts.tag);
    out = out.filter((e) => e.tags.includes(tag));
  }
  out = out.filter((e) => {
    const hay = `${e.title}\n${e.body}\n${e.tags.join(' ')}`.toLowerCase();
    return hay.includes(q);
  });
  return sortByUpdatedDescIdAsc(out).slice(0, limit);
}
