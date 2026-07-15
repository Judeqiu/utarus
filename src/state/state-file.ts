/**
 * User State File — read/write/validate the per-user YAML.
 *
 * Files live at <DATA_ROOT>/users/<slug>.yaml. Per project rules: no fallback
 * paths, no defaults. If a file is missing or a slug is malformed, fail fast
 * with a clear error.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { parse, stringify } from 'yaml';
import { randomUUID } from 'crypto';
import {
  type UserState,
  type InviteCode,
  type AdminOnboardCode,
} from './types.js';
import { resolveDataRoot } from '../config.js';

const DATA_ROOT = resolveDataRoot();
const USERS_DIR = join(DATA_ROOT, 'users');

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function usersDir(): string {
  return USERS_DIR;
}

export function assertValidSlug(slug: string): void {
  if (!slug || typeof slug !== 'string') {
    throw new Error(`User slug is required (got: "${slug}")`);
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      `User slug must be lowercase kebab-case [a-z0-9-]+, got: "${slug}"`
    );
  }
}

export function stateFilePath(slug: string): string {
  assertValidSlug(slug);
  return join(USERS_DIR, `${slug}.yaml`);
}

/**
 * Minimal coherence check — the LLM cannot be trusted to round-trip arbitrary
 * JSON. We assert the load-bearing shape only; deeper validation lives in
 * domain rules (provided by extensions).
 */
function assertCoherent(state: unknown, path: string): UserState {
  if (!state || typeof state !== 'object') {
    throw new Error(`State file is not a mapping: ${path}`);
  }
  const s = state as Partial<UserState>;
  if (!s.user?.slug) throw new Error(`State file missing user.slug: ${path}`);
  if (!s.user?.created_at) throw new Error(`State file missing user.created_at: ${path}`);
  if (!s.profile?.display_name) throw new Error(`State file missing profile.display_name: ${path}`);
  if (!s.profile?.contact_email) throw new Error(`State file missing profile.contact_email: ${path}`);
  if (!Array.isArray(s.log)) throw new Error(`State file missing log[]: ${path}`);
  return s as UserState;
}

export function loadState(slug: string): UserState {
  const path = stateFilePath(slug);
  if (!existsSync(path)) {
    throw new Error(`User state file not found: ${path}`);
  }
  const raw = readFileSync(path, 'utf-8');
  const parsed = parse(raw);
  return assertCoherent(parsed, path);
}

export function saveState(state: UserState): string {
  if (!state?.user?.slug) {
    throw new Error('Cannot save state without user.slug');
  }
  assertCoherent(state, '<in-memory>');
  const path = stateFilePath(state.user.slug);
  mkdirSync(dirname(path), { recursive: true });
  const yaml = stringify(state, { sortMapEntries: false });
  writeFileSync(path, yaml, 'utf-8');
  return path;
}

export function stateExists(slug: string): boolean {
  try {
    return existsSync(stateFilePath(slug));
  } catch {
    return false;
  }
}

export function listUserSlugs(): string[] {
  if (!existsSync(USERS_DIR)) return [];
  return readdirSync(USERS_DIR, { withFileTypes: true })
    .filter(d => d.isFile() && d.name.endsWith('.yaml'))
    .map(d => d.name.replace(/\.yaml$/, ''));
}

/**
 * Produce a fresh blank state for a new user. Framework fields are populated;
 * domain extensions add their own starting values via saveState() afterwards.
 */
export function blankState(params: {
  slug: string;
  displayName: string;
  contactEmail: string;
}): UserState {
  assertValidSlug(params.slug);
  if (!params.displayName) throw new Error('displayName is required');
  if (!params.contactEmail) throw new Error('contactEmail is required');
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  return {
    user: {
      id: randomUUID(),
      slug: params.slug,
      created_at: today,
      telegram_user_ids: [],
      slack_user_ids: [],
      auth_token: randomUUID(),
    },
    profile: {
      display_name: params.displayName,
      contact_email: params.contactEmail,
    },
    log: [{ ts: today, action: 'created' }],
  };
}

/**
 * Find a user by Telegram user ID. Scans all user state files.
 * Returns null if no user is linked to this Telegram account.
 */
export function resolveUserByTelegramUser(telegramUserId: number): UserState | null {
  const slugs = listUserSlugs();
  for (const slug of slugs) {
    try {
      const state = loadState(slug);
      if (state.user.telegram_user_ids?.includes(telegramUserId)) {
        return state;
      }
    } catch {
      // skip broken state files
    }
  }
  return null;
}

/**
 * Find a user by Slack user ID. Scans all user state files.
 * Returns null if no user is linked to this Slack account.
 */
export function resolveUserBySlackUser(slackUserId: string): UserState | null {
  const slugs = listUserSlugs();
  for (const slug of slugs) {
    try {
      const state = loadState(slug);
      if (state.user.slack_user_ids?.includes(slackUserId)) {
        return state;
      }
    } catch {
      // skip broken state files
    }
  }
  return null;
}

/**
 * Find a user by slug. Returns null if no state file exists for this slug
 * or the file fails the coherence check. Used by channels that authenticate
 * by something other than a chat-platform id (e.g. web sessions, where the
 * gate resolves the slug from an auth_token and passes it through).
 */
export function resolveUserBySlug(slug: string): UserState | null {
  if (!slug) return null;
  try {
    return loadState(slug);
  } catch {
    return null;
  }
}

// ── Invite codes ──────────────────────────────────────────────────────

const INVITES_FILE = join(DATA_ROOT, 'invites.yaml');

function loadInvites(): InviteCode[] {
  if (!existsSync(INVITES_FILE)) return [];
  const raw = readFileSync(INVITES_FILE, 'utf-8');
  const parsed = parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed as InviteCode[];
}

function saveInvites(invites: InviteCode[]): void {
  mkdirSync(dirname(INVITES_FILE), { recursive: true });
  writeFileSync(INVITES_FILE, stringify(invites, { sortMapEntries: false }), 'utf-8');
}

function generateInviteCode(): string {
  return `INV-${randomUUID().slice(0, 8).toUpperCase()}`;
}

export function createInviteCode(params: {
  createdBy: number;
  createdBySlack?: string;
  createdViaWeb?: string;
  comment?: string;
  customCode?: string;
}): InviteCode {
  if (params.createdBy === 0 && !params.createdBySlack && !params.createdViaWeb) {
    throw new Error('createInviteCode requires a creator identity (telegram id, slack id, or web admin username).');
  }
  const code = params.customCode || generateInviteCode();
  const invites = loadInvites();
  if (invites.some(i => i.code === code)) {
    throw new Error(`Invite code "${code}" already exists. Use a different code.`);
  }
  const invite: InviteCode = {
    code,
    created_by: params.createdBy,
    created_at: new Date().toISOString().slice(0, 10),
  };
  if (params.createdBySlack) invite.created_by_slack = params.createdBySlack;
  if (params.createdViaWeb) invite.created_via_web = params.createdViaWeb;
  if (params.comment) invite.comment = params.comment;
  invites.push(invite);
  saveInvites(invites);
  return invite;
}

function isInviteUsed(invite: InviteCode): boolean {
  // used_by may be 0 for Slack-only redeem — treat used_by_slack / used_at as used too.
  return (
    (invite.used_by != null && invite.used_by !== 0) ||
    !!invite.used_by_slack ||
    !!invite.used_at ||
    (invite.used_by === 0 && !!invite.slug)
  );
}

export function validateInviteCode(code: string): InviteCode {
  const invites = loadInvites();
  const invite = invites.find(i => i.code === code.toUpperCase() || i.code === code);
  if (!invite) throw new Error(`Invalid invite code "${code}".`);
  if (isInviteUsed(invite)) {
    const who =
      invite.slug ??
      (invite.used_by_slack ? `Slack ${invite.used_by_slack}` : null) ??
      (invite.used_by != null ? `Telegram ${invite.used_by}` : 'another user');
    throw new Error(`Invite code "${code}" has already been used (${who}).`);
  }
  return invite;
}

export function markInviteUsed(code: string, telegramUserId: number, slug: string, slackUserId?: string): InviteCode {
  const invites = loadInvites();
  const idx = invites.findIndex(i => i.code === code);
  if (idx === -1) throw new Error(`Invite code "${code}" not found.`);
  invites[idx].used_by = telegramUserId;
  invites[idx].used_at = new Date().toISOString().slice(0, 10);
  invites[idx].slug = slug;
  if (slackUserId) invites[idx].used_by_slack = slackUserId;
  saveInvites(invites);
  return invites[idx];
}

export function listInviteCodes(filter?: 'all' | 'unused' | 'used'): InviteCode[] {
  const invites = loadInvites();
  if (!filter || filter === 'all') return invites;
  if (filter === 'unused') return invites.filter(i => !isInviteUsed(i));
  if (filter === 'used') return invites.filter(i => isInviteUsed(i));
  return invites;
}

// ── Admin onboard codes ──────────────────────────────────────────────

const ADMIN_CODES_FILE = join(DATA_ROOT, 'admin_codes.yaml');

function loadAdminCodes(): AdminOnboardCode[] {
  if (!existsSync(ADMIN_CODES_FILE)) return [];
  const raw = readFileSync(ADMIN_CODES_FILE, 'utf-8');
  const parsed = parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed as AdminOnboardCode[];
}

function saveAdminCodes(codes: AdminOnboardCode[]): void {
  mkdirSync(dirname(ADMIN_CODES_FILE), { recursive: true });
  writeFileSync(ADMIN_CODES_FILE, stringify(codes, { sortMapEntries: false }), 'utf-8');
}

export function createAdminOnboardCode(params: {
  createdBy: number;
  createdBySlack?: string;
  createdViaWeb?: string;
  comment?: string;
  customCode?: string;
}): AdminOnboardCode {
  if (params.createdBy === 0 && !params.createdBySlack && !params.createdViaWeb) {
    throw new Error('createAdminOnboardCode requires a creator identity (telegram id, slack id, or web admin username).');
  }
  const code = params.customCode || `ADM-${randomUUID().slice(0, 8).toUpperCase()}`;
  const codes = loadAdminCodes();
  if (codes.some(c => c.code === code)) {
    throw new Error(`Admin onboard code "${code}" already exists.`);
  }
  const entry: AdminOnboardCode = {
    code,
    created_by: params.createdBy,
    created_at: new Date().toISOString().slice(0, 10),
  };
  if (params.createdBySlack) entry.created_by_slack = params.createdBySlack;
  if (params.createdViaWeb) entry.created_via_web = params.createdViaWeb;
  if (params.comment) entry.comment = params.comment;
  codes.push(entry);
  saveAdminCodes(codes);
  return entry;
}

export function validateAdminOnboardCode(code: string): AdminOnboardCode {
  const codes = loadAdminCodes();
  const entry = codes.find(c => c.code === code);
  if (!entry) throw new Error(`Invalid admin onboard code "${code}".`);
  if (entry.revoked) throw new Error(`Admin onboard code "${code}" has been revoked.`);
  if (entry.used_by) throw new Error(`Admin onboard code "${code}" has already been used by Telegram user ${entry.used_by}.`);
  return entry;
}

export function markAdminOnboardCodeUsed(code: string, telegramUserId: number, slackUserId?: string): AdminOnboardCode {
  const codes = loadAdminCodes();
  const idx = codes.findIndex(c => c.code === code);
  if (idx === -1) throw new Error(`Admin onboard code "${code}" not found.`);
  codes[idx].used_by = telegramUserId;
  codes[idx].used_at = new Date().toISOString().slice(0, 10);
  if (slackUserId) codes[idx].used_by_slack = slackUserId;
  saveAdminCodes(codes);
  return codes[idx];
}

export function revokeAdminOnboardCode(code: string): AdminOnboardCode {
  const codes = loadAdminCodes();
  const idx = codes.findIndex(c => c.code === code);
  if (idx === -1) throw new Error(`Admin onboard code "${code}" not found.`);
  if (codes[idx].used_by) throw new Error(`Admin onboard code "${code}" has already been used — cannot revoke.`);
  if (codes[idx].revoked) throw new Error(`Admin onboard code "${code}" is already revoked.`);
  codes[idx].revoked = true;
  codes[idx].revoked_at = new Date().toISOString().slice(0, 10);
  saveAdminCodes(codes);
  return codes[idx];
}

export function listAdminOnboardCodes(filter?: 'all' | 'unused' | 'used'): AdminOnboardCode[] {
  const codes = loadAdminCodes();
  if (!filter || filter === 'all') return codes;
  if (filter === 'unused') return codes.filter(c => !c.used_by);
  if (filter === 'used') return codes.filter(c => !!c.used_by);
  return codes;
}

// ── Dynamic admin IDs (file-backed) ──────────────────────────────────

const ADMIN_IDS_FILE = join(DATA_ROOT, 'admin_ids.yaml');

export function loadDynamicAdminIds(): number[] {
  if (!existsSync(ADMIN_IDS_FILE)) return [];
  const raw = readFileSync(ADMIN_IDS_FILE, 'utf-8');
  const parsed = parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((id: unknown): id is number => typeof id === 'number' && !isNaN(id));
}

export function addDynamicAdminId(telegramUserId: number): void {
  const ids = loadDynamicAdminIds();
  if (ids.includes(telegramUserId)) return;
  ids.push(telegramUserId);
  mkdirSync(dirname(ADMIN_IDS_FILE), { recursive: true });
  writeFileSync(ADMIN_IDS_FILE, stringify(ids, { sortMapEntries: false }), 'utf-8');
}
