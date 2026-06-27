/**
 * User state tools — every read/write on a user state file goes through here.
 * All parameters are TypeBox-schematized so pi-ai validates the LLM's tool
 * call before this code runs. Domain extensions layer additional tools on top
 * (e.g. phase advance, metric updates) — this file only owns the shape.
 */

import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import {
  blankState,
  loadState,
  saveState,
  stateExists,
  listUserSlugs,
  stateFilePath,
  resolveUserByTelegramUser,
  type UserState,
} from '../state/index.js';

function ok<T>(text: string, details: T): AgentToolResult<T> {
  return { content: [{ type: 'text' as const, text }], details };
}
function fail(text: string): AgentToolResult<null> {
  return { content: [{ type: 'text' as const, text }], details: null };
}
function failFrom(error: unknown): AgentToolResult<null> {
  return fail(error instanceof Error ? error.message : String(error));
}

function summary(state: UserState): Record<string, unknown> {
  return {
    slug: state.user.slug,
    created_at: state.user.created_at,
    display_name: state.profile.display_name,
    contact_email: state.profile.contact_email,
    telegram_user_ids: state.user.telegram_user_ids ?? [],
    log_entries: state.log.length,
  };
}

function buildAnnouncement(state: UserState): string {
  const tgCount = state.user.telegram_user_ids?.length ?? 0;
  return [
    `User "${state.user.slug}" — ${state.profile.display_name}.`,
    `Created ${state.user.created_at}. Contact: ${state.profile.contact_email}.`,
    tgCount > 0 ? `${tgCount} Telegram account(s) linked.` : 'No Telegram accounts linked.',
    `${state.log.length} log entr${state.log.length === 1 ? 'y' : 'ies'}.`,
  ].join(' ');
}

export function createUserStateTools(): AgentTool[] {
  const list: AgentTool = {
    name: 'list_users',
    label: 'List Users',
    description: 'List every user state file with display name + created date. Use this first when the user mentions someone without naming them.',
    parameters: Type.Object({}),
    async execute() {
      try {
        const slugs = listUserSlugs();
        if (slugs.length === 0) {
          return ok('No user state files yet. Create one with init_user.', { slugs: [], count: 0 });
        }
        const rows: Array<Record<string, unknown>> = [];
        for (const slug of slugs) {
          try {
            const s = loadState(slug);
            rows.push({ slug, display_name: s.profile.display_name, created_at: s.user.created_at });
          } catch (e) {
            rows.push({ slug, error: e instanceof Error ? e.message : String(e) });
          }
        }
        const lines = [
          `Found ${slugs.length} user${slugs.length === 1 ? '' : 's'}:`,
          '',
          ...rows.map((r, i) => {
            if ('error' in r) return `${i + 1}. \`${r.slug}\` — ERROR: ${r.error}`;
            return `${i + 1}. \`${r.slug}\` — ${r.display_name} (created ${r.created_at})`;
          }),
        ];
        return ok(lines.join('\n'), { slugs, rows, count: slugs.length });
      } catch (e) { return failFrom(e); }
    },
  };

  const get: AgentTool = {
    name: 'get_user',
    label: 'Get User',
    description: 'Load a user state file. Returns the session-start announcement (print this verbatim to the user) plus the full state. Use BEFORE suggesting any change to the user record.',
    parameters: Type.Object({
      slug: Type.String({ description: 'User slug (matches data/users/<slug>.yaml).' }),
    }),
    async execute(_id, raw) {
      const { slug } = raw as { slug: string };
      try {
        const state = loadState(slug);
        const announcement = buildAnnouncement(state);
        const text = [
          announcement,
          '',
          `State file: ${stateFilePath(slug)}`,
        ].join('\n');
        return ok(text, { state, announcement, summary: summary(state) });
      } catch (e) { return failFrom(e); }
    },
  };

  const init: AgentTool = {
    name: 'init_user',
    label: 'Init User',
    description: 'Create a new user state file. Refuses to overwrite an existing user — load it instead. Always pass telegram_user_id from the message context to auto-link the user. The slug is derived from display_name (lowercase kebab-case).',
    parameters: Type.Object({
      display_name: Type.String({ description: 'Display name. Will be slugified for the filename.' }),
      contact_email: Type.String({ description: 'Primary contact email.' }),
      telegram_user_id: Type.Optional(Type.Number({ description: 'Telegram user ID from the message context. Always provide this to auto-link the user.' })),
    }),
    async execute(_id, raw) {
      const p = raw as { display_name: string; contact_email: string; telegram_user_id?: number };
      try {
        const slug = p.display_name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '');
        if (!slug) {
          return fail('display_name must contain at least one alphanumeric character.');
        }
        if (stateExists(slug)) {
          return fail(`User "${slug}" already exists. Use get_user to load it.`);
        }
        const state = blankState({
          slug, displayName: p.display_name, contactEmail: p.contact_email,
        });
        if (p.telegram_user_id) {
          state.user.telegram_user_ids = [p.telegram_user_id];
          state.log.push({ ts: new Date().toISOString().slice(0, 10), action: 'telegram_linked', telegram_user_id: p.telegram_user_id });
        }
        const path = saveState(state);
        const linkMsg = p.telegram_user_id ? `\nTelegram user ${p.telegram_user_id} auto-linked.` : '';
        return ok(
          `Initialized ${path}.\nAuth token: ${state.user.auth_token}. Share this token with the user if they need portal/API access.${linkMsg}`,
          { state, path, slug }
        );
      } catch (e) { return failFrom(e); }
    },
  };

  const linkTelegram: AgentTool = {
    name: 'link_telegram',
    label: 'Link Telegram User',
    description: 'Link a Telegram user ID to a user record. Once linked, that Telegram user will auto-load this user\'s context when they message the bot. The telegram_user_id is always provided in the message context — never ask the user for it.',
    parameters: Type.Object({
      slug: Type.String({ description: 'User slug to link.' }),
      telegram_user_id: Type.Number({ description: 'Telegram user ID (numeric). Always available from the message context.' }),
    }),
    async execute(_id, raw) {
      const p = raw as { slug: string; telegram_user_id: number };
      try {
        if (!Number.isInteger(p.telegram_user_id) || p.telegram_user_id <= 0) {
          return fail('telegram_user_id must be a positive integer.');
        }
        const existing = resolveUserByTelegramUser(p.telegram_user_id);
        if (existing && existing.user.slug !== p.slug) {
          return fail(`Telegram user ${p.telegram_user_id} is already linked to user "${existing.user.slug}". Unlink them first with unlink_telegram.`);
        }
        const state = loadState(p.slug);
        const ids = new Set(state.user.telegram_user_ids ?? []);
        if (ids.has(p.telegram_user_id)) {
          return ok(`Telegram user ${p.telegram_user_id} is already linked to "${p.slug}".`, { state });
        }
        ids.add(p.telegram_user_id);
        const next: UserState = {
          ...structuredClone(state),
          user: { ...state.user, telegram_user_ids: [...ids] },
          log: [...state.log, { ts: new Date().toISOString().slice(0, 10), action: 'telegram_linked', telegram_user_id: p.telegram_user_id }],
        };
        const path = saveState(next);
        return ok(`Linked Telegram user ${p.telegram_user_id} to user "${p.slug}".`, { state: next, path });
      } catch (e) { return failFrom(e); }
    },
  };

  const unlinkTelegram: AgentTool = {
    name: 'unlink_telegram',
    label: 'Unlink Telegram User',
    description: 'Remove a Telegram user ID link from a user record.',
    parameters: Type.Object({
      slug: Type.String({ description: 'User slug to unlink from.' }),
      telegram_user_id: Type.Number({ description: 'Telegram user ID to remove.' }),
    }),
    async execute(_id, raw) {
      const p = raw as { slug: string; telegram_user_id: number };
      try {
        const state = loadState(p.slug);
        const ids = state.user.telegram_user_ids ?? [];
        if (!ids.includes(p.telegram_user_id)) {
          return fail(`Telegram user ${p.telegram_user_id} is not linked to "${p.slug}".`);
        }
        const next: UserState = {
          ...structuredClone(state),
          user: { ...state.user, telegram_user_ids: ids.filter(id => id !== p.telegram_user_id) },
          log: [...state.log, { ts: new Date().toISOString().slice(0, 10), action: 'telegram_unlinked', telegram_user_id: p.telegram_user_id }],
        };
        const path = saveState(next);
        return ok(`Unlinked Telegram user ${p.telegram_user_id} from user "${p.slug}".`, { state: next, path });
      } catch (e) { return failFrom(e); }
    },
  };

  const resolveByTelegram: AgentTool = {
    name: 'resolve_user_by_telegram',
    label: 'Resolve User by Telegram User',
    description: 'Look up which user (if any) is linked to a Telegram user ID. Returns the user state if linked, or null if unlinked.',
    parameters: Type.Object({
      telegram_user_id: Type.Number({ description: 'Telegram user ID to look up.' }),
    }),
    async execute(_id, raw) {
      const p = raw as { telegram_user_id: number };
      try {
        const state = resolveUserByTelegramUser(p.telegram_user_id);
        if (!state) {
          return ok(`No user linked to Telegram user ${p.telegram_user_id}.`, { linked: false });
        }
        const announcement = buildAnnouncement(state);
        return ok(`Telegram user ${p.telegram_user_id} is linked to user "${state.user.slug}".\n\n${announcement}`, { linked: true, slug: state.user.slug, state, summary: summary(state) });
      } catch (e) { return failFrom(e); }
    },
  };

  const updateProfile: AgentTool = {
    name: 'update_profile',
    label: 'Update Profile Field',
    description: 'Update a framework-defined profile field. Allowed fields: display_name, contact_email. Domain extensions should add their own update tools for domain-specific fields.',
    parameters: Type.Object({
      slug: Type.String({ description: 'User slug.' }),
      field: Type.String({ description: 'One of: display_name, contact_email.' }),
      value: Type.String({ description: 'New value (non-empty string).' }),
      reason: Type.String({ description: 'Substantive reason (≥ 20 chars). Cite who is changing it and why.' }),
    }),
    async execute(_id, raw) {
      const p = raw as { slug: string; field: 'display_name' | 'contact_email'; value: string; reason: string };
      try {
        if (!['display_name', 'contact_email'].includes(p.field)) {
          return fail(`field must be one of: display_name, contact_email. Got "${p.field}".`);
        }
        if (!p.reason || p.reason.trim().length < 20) {
          return fail('reason must be ≥ 20 chars. Cite who is changing it and why.');
        }
        if (typeof p.value !== 'string' || !p.value.trim()) {
          return fail(`${p.field} must be a non-empty string.`);
        }
        const state = loadState(p.slug);
        const next: UserState = structuredClone(state);
        next.profile[p.field] = p.value.trim();
        next.log = [...state.log, { ts: new Date().toISOString().slice(0, 10), action: 'profile_updated', field: p.field, value: p.value, reason: p.reason }];
        const path = saveState(next);
        return ok(`Updated ${p.slug}.profile.${p.field}. State file: ${path}`, { state: next, path });
      } catch (e) { return failFrom(e); }
    },
  };

  return [list, get, init, linkTelegram, unlinkTelegram, resolveByTelegram, updateProfile];
}
