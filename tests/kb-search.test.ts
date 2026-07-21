import { describe, it, expect } from 'vitest';
import { filterEntries, searchEntries } from '../src/kb/search.js';
import type { KnowledgeEntry } from '../src/kb/types.js';

function entry(
  partial: Partial<KnowledgeEntry> & Pick<KnowledgeEntry, 'id' | 'title' | 'body'>,
): KnowledgeEntry {
  return {
    scope: 'private',
    owner_slug: 'alice',
    tags: [],
    source: null,
    provenance: 'chat_tool',
    domain_tag: null,
    refs: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

const a = entry({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  title: 'Risk preference',
  body: 'User prefers downside first',
  tags: ['preference', 'portfolio'],
  updated_at: '2026-01-03T00:00:00.000Z',
});
const b = entry({
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  title: 'Acme notes',
  body: 'Competitor analysis for Acme Corp',
  tags: ['acme', 'research'],
  updated_at: '2026-01-02T00:00:00.000Z',
});
const c = entry({
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  title: 'Older',
  body: 'Something else',
  tags: ['preference'],
  updated_at: '2026-01-01T00:00:00.000Z',
});

describe('filterEntries / searchEntries', () => {
  it('filterEntries sorts updated_at desc then id and respects limit', () => {
    const out = filterEntries([a, b, c], { limit: 2 });
    expect(out.map((e) => e.id)).toEqual([a.id, b.id]);
  });

  it('filterEntries allows limit 50 (no internal 25 cap)', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      entry({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        title: `t${i}`,
        body: `b${i}`,
        updated_at: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
      }),
    );
    const out = filterEntries(many, { limit: 50 });
    expect(out.length).toBe(40);
  });

  it('filterEntries by tag (normalized)', () => {
    const out = filterEntries([a, b, c], { tag: 'Preference', limit: 10 });
    expect(out.map((e) => e.id)).toEqual([a.id, c.id]);
  });

  it('searchEntries substring over title body tags', () => {
    const out = searchEntries([a, b, c], { query: 'acme', limit: 10 });
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe(b.id);
  });

  it('searchEntries rejects empty query and bad limit', () => {
    expect(() => searchEntries([a], { query: '  ', limit: 5 })).toThrow(/query/);
    expect(() => filterEntries([a], { limit: 0 })).toThrow(/limit/);
  });
});
