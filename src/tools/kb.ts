/**
 * Knowledge base tools — slug-bound CRUD + list/search.
 * See docs/knowledge-base-design.md.
 */

import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import {
  createKb,
  deleteKb,
  getKb,
  listKb,
  searchKb,
  updateKb,
  type KbScope,
} from '../kb/index.js';

function ok<T>(text: string, details: T): AgentToolResult<T> {
  return { content: [{ type: 'text' as const, text }], details };
}
function fail(text: string): AgentToolResult<null> {
  return { content: [{ type: 'text' as const, text }], details: null };
}
function failFrom(error: unknown): AgentToolResult<null> {
  return fail(error instanceof Error ? error.message : String(error));
}

const scopeSchema = Type.Union([
  Type.Literal('private'),
  Type.Literal('shared'),
]);

const refSchema = Type.Object({
  kind: Type.String({ description: 'e.g. bindrive | url | report' }),
  value: Type.String({ description: 'Opaque path or URL' }),
});

/**
 * @param userSlug  authenticated user — private path is always this slug
 * @param isAdmin   when true, may write shared KB
 */
export function createKbTools(userSlug: string, isAdmin: boolean): AgentTool[] {
  const list: AgentTool = {
    name: 'list_kb',
    label: 'List Knowledge',
    description:
      'List knowledge base entries (metadata + body_preview only, never full body). ' +
      'Private = current user; shared = deployment-wide. Omit scope to list both. ' +
      'Optional tag filter (kebab-case). Prefer search_kb when looking for a phrase. ' +
      'REQUIRED before answering: preferred name, what to call the user, what you know about them, or saved preferences — do not rely on get_user/profile alone.',
    parameters: Type.Object({
      scope: Type.Optional(scopeSchema),
      tag: Type.Optional(
        Type.String({ description: 'Filter to entries with this tag (normalized).' }),
      ),
      limit: Type.Optional(
        Type.Number({
          description:
            'Max rows (default 50, max 50). Omit for default.',
        }),
      ),
    }),
    async execute(_id, raw) {
      const p = raw as { scope?: KbScope; tag?: string; limit?: number };
      try {
        if (!userSlug) {
          return fail('Cannot list KB: no authenticated user slug in this session.');
        }
        const rows = listKb({
          userSlug,
          isAdmin,
          scope: p.scope,
          tag: p.tag,
          limit: p.limit,
        });
        if (rows.length === 0) {
          return ok('No knowledge entries found.', { entries: rows });
        }
        const lines = rows.map((r, i) => {
          const tags = r.tags.length ? ` tags=[${r.tags.join(', ')}]` : '';
          return `${i + 1}. [${r.scope}] ${r.title} (id ${r.id})${tags}\n   ${r.body_preview}${r.body_truncated ? '…' : ''}`;
        });
        return ok(`Found ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}:\n${lines.join('\n')}`, {
          entries: rows,
        });
      } catch (e) {
        return failFrom(e);
      }
    },
  };

  const search: AgentTool = {
    name: 'search_kb',
    label: 'Search Knowledge',
    description:
      'Keyword search over knowledge entries (case-insensitive substring on title+body+tags). ' +
      'Returns body_preview only. Call before claiming you know or do not know stored facts. ' +
      'Use short distinctive phrases or tags (e.g. name, preference, Jude). ' +
      'REQUIRED for: my name, what should you call me, remember me, what do you know about me. ' +
      'KB preferred name overrides profile.display_name.',
    parameters: Type.Object({
      query: Type.String({
        description: 'Non-empty substring to search for.',
      }),
      scope: Type.Optional(scopeSchema),
      tag: Type.Optional(Type.String({ description: 'Optional tag filter.' })),
      limit: Type.Optional(
        Type.Number({
          description: 'Max rows (default 25, max 25). Omit for default.',
        }),
      ),
    }),
    async execute(_id, raw) {
      const p = raw as {
        query: string;
        scope?: KbScope;
        tag?: string;
        limit?: number;
      };
      try {
        if (!userSlug) {
          return fail('Cannot search KB: no authenticated user slug in this session.');
        }
        const rows = searchKb({
          userSlug,
          isAdmin,
          query: p.query,
          scope: p.scope,
          tag: p.tag,
          limit: p.limit,
        });
        if (rows.length === 0) {
          return ok(`No knowledge entries matched query ${JSON.stringify(p.query)}.`, {
            entries: rows,
            query: p.query,
          });
        }
        const lines = rows.map((r, i) => {
          const tags = r.tags.length ? ` tags=[${r.tags.join(', ')}]` : '';
          return `${i + 1}. [${r.scope}] ${r.title} (id ${r.id})${tags}\n   ${r.body_preview}${r.body_truncated ? '…' : ''}`;
        });
        return ok(
          `Found ${rows.length} match${rows.length === 1 ? '' : 'es'} for ${JSON.stringify(p.query)}:\n${lines.join('\n')}`,
          { entries: rows, query: p.query },
        );
      } catch (e) {
        return failFrom(e);
      }
    },
  };

  const get: AgentTool = {
    name: 'get_kb',
    label: 'Get Knowledge Entry',
    description:
      'Load one knowledge entry by id (full body). Use after list_kb/search_kb when you need the full text. ' +
      'Ids are UUIDs from tool results — never invent them.',
    parameters: Type.Object({
      id: Type.String({ description: 'Entry UUID from list/search/create.' }),
    }),
    async execute(_id, raw) {
      const p = raw as { id: string };
      try {
        if (!userSlug) {
          return fail('Cannot get KB: no authenticated user slug in this session.');
        }
        const entry = getKb({ userSlug, isAdmin, id: p.id });
        return ok(
          `KB entry [${entry.scope}] ${entry.title} (id ${entry.id})\n` +
            `tags: ${entry.tags.join(', ') || '(none)'}\n` +
            `updated: ${entry.updated_at}\n\n${entry.body}`,
          { entry },
        );
      } catch (e) {
        return failFrom(e);
      }
    },
  };

  const create: AgentTool = {
    name: 'create_kb',
    label: 'Create Knowledge Entry',
    description:
      'Persist a durable knowledge entry. scope is required: private (current user only) or shared (admin only, readable by all). ' +
      'Do not invent ids/timestamps. Prefer private unless the user clearly wants deployment-wide shared knowledge and you are admin. ' +
      'Tags: short lowercase kebab-case. Do not dump notes into profile or skills.',
    parameters: Type.Object({
      scope: scopeSchema,
      title: Type.String({ description: 'Short non-empty title.' }),
      body: Type.String({ description: 'Full entry body (required, non-empty).' }),
      tags: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Optional tags; omit → empty. Normalized to kebab-case.',
        }),
      ),
      source: Type.Optional(
        Type.String({
          description: 'Optional label e.g. user | research | conversation.',
        }),
      ),
      domain_tag: Type.Optional(
        Type.String({ description: 'Optional domain opaque tag.' }),
      ),
      refs: Type.Optional(Type.Array(refSchema)),
    }),
    async execute(_id, raw) {
      const p = raw as {
        scope: KbScope;
        title: string;
        body: string;
        tags?: string[];
        source?: string;
        domain_tag?: string;
        refs?: Array<{ kind: string; value: string }>;
      };
      try {
        if (!userSlug) {
          return fail('Cannot create KB: no authenticated user slug in this session.');
        }
        const entry = await createKb({
          userSlug,
          isAdmin,
          scope: p.scope,
          title: p.title,
          body: p.body,
          tags: p.tags,
          source: p.source,
          domain_tag: p.domain_tag,
          refs: p.refs,
          provenance: 'chat_tool',
        });
        return ok(
          `Created KB entry [${entry.scope}] "${entry.title}" id ${entry.id}` +
            (entry.tags.length ? ` tags=[${entry.tags.join(', ')}]` : ''),
          { entry },
        );
      } catch (e) {
        return failFrom(e);
      }
    },
  };

  const update: AgentTool = {
    name: 'update_kb',
    label: 'Update Knowledge Entry',
    description:
      'Update an existing knowledge entry by id. Omitted fields stay unchanged. ' +
      'source/domain_tag may be set to null to clear. tags/refs if present replace the whole array (use [] to clear). ' +
      'Call get_kb first when unsure. Shared entries require admin.',
    parameters: Type.Object({
      id: Type.String({ description: 'Entry UUID.' }),
      title: Type.Optional(Type.String()),
      body: Type.Optional(Type.String()),
      tags: Type.Optional(Type.Array(Type.String())),
      refs: Type.Optional(Type.Array(refSchema)),
      source: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      domain_tag: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    }),
    async execute(_id, raw) {
      const p = raw as {
        id: string;
        title?: string;
        body?: string;
        tags?: string[];
        refs?: Array<{ kind: string; value: string }>;
        source?: string | null;
        domain_tag?: string | null;
      };
      try {
        if (!userSlug) {
          return fail('Cannot update KB: no authenticated user slug in this session.');
        }
        const entry = await updateKb({
          userSlug,
          isAdmin,
          id: p.id,
          title: p.title,
          body: p.body,
          tags: p.tags,
          refs: p.refs,
          source: p.source,
          domain_tag: p.domain_tag,
        });
        return ok(
          `Updated KB entry [${entry.scope}] "${entry.title}" id ${entry.id}`,
          { entry },
        );
      } catch (e) {
        return failFrom(e);
      }
    },
  };

  const del: AgentTool = {
    name: 'delete_kb',
    label: 'Delete Knowledge Entry',
    description:
      'Hard-delete a knowledge entry by id. Private: owner only. Shared: admin only. ' +
      'Irreversible in v1. Confirm with the user when destructive.',
    parameters: Type.Object({
      id: Type.String({ description: 'Entry UUID to delete.' }),
    }),
    async execute(_id, raw) {
      const p = raw as { id: string };
      try {
        if (!userSlug) {
          return fail('Cannot delete KB: no authenticated user slug in this session.');
        }
        const result = await deleteKb({
          userSlug,
          isAdmin,
          id: p.id,
        });
        return ok(
          `Deleted KB entry id ${result.id} (scope ${result.scope}).`,
          result,
        );
      } catch (e) {
        return failFrom(e);
      }
    },
  };

  return [list, search, get, create, update, del];
}
