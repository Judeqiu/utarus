/**
 * Standard instant invite redeem — framework-owned, all domain agents share it.
 *
 * User sends INV-XXXXXXXX → validate → create profile from channel display name
 * → link Slack/Telegram → mark invite used. No Q&A for name/email.
 */

import { randomUUID } from 'crypto';
import {
  blankState,
  saveState,
  stateExists,
  validateInviteCode,
  markInviteUsed,
  loadState,
  resolveUserBySlackUser,
  resolveUserByTelegramUser,
  type UserState,
} from '../state/index.js';

export interface InstantRedeemParams {
  code: string;
  displayName: string;
  slackUserId?: string;
  telegramUserId?: number;
}

export interface InstantRedeemResult {
  slug: string;
  displayName: string;
  authToken: string;
  state: UserState;
}

function slugBaseFromDisplayName(displayName: string, channelHint: string): string {
  const fromName = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (fromName) return fromName;

  const fromChannel = channelHint
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (!fromChannel) {
    throw new Error(
      `Cannot derive user slug from display_name="${displayName}" and channel="${channelHint}"`,
    );
  }
  return `user-${fromChannel}`;
}

function uniqueSlug(base: string, channelHint: string): string {
  if (!stateExists(base)) return base;
  const suffix = channelHint
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(-8);
  const candidate = `${base}-${suffix || randomUUID().slice(0, 8)}`;
  if (stateExists(candidate)) {
    throw new Error(
      `User slug "${base}" and collision slug "${candidate}" both exist. Contact an admin.`,
    );
  }
  return candidate;
}

export type EnsureChannelUserSource = 'invite' | 'demo';

/**
 * Create (or return existing) user linked to this Slack/Telegram identity.
 * Same profile shape as invite redeem — used by invite + demo mode.
 */
export function ensureChannelUser(params: {
  displayName: string;
  slackUserId?: string;
  telegramUserId?: number;
  source: EnsureChannelUserSource;
  inviteCode?: string;
}): InstantRedeemResult {
  if (!params.slackUserId && params.telegramUserId == null) {
    throw new Error('ensureChannelUser requires slackUserId or telegramUserId');
  }
  const displayName = params.displayName.trim();
  if (!displayName) {
    throw new Error('displayName is required to create a user profile');
  }

  if (params.slackUserId) {
    const existing = resolveUserBySlackUser(params.slackUserId);
    if (existing) {
      const token = existing.user.auth_token;
      if (!token) throw new Error(`User "${existing.user.slug}" missing auth_token`);
      return {
        slug: existing.user.slug,
        displayName: existing.profile.display_name,
        authToken: token,
        state: existing,
      };
    }
  }
  if (params.telegramUserId != null) {
    const existing = resolveUserByTelegramUser(params.telegramUserId);
    if (existing) {
      const token = existing.user.auth_token;
      if (!token) throw new Error(`User "${existing.user.slug}" missing auth_token`);
      return {
        slug: existing.user.slug,
        displayName: existing.profile.display_name,
        authToken: token,
        state: existing,
      };
    }
  }

  const channelHint = params.slackUserId ?? String(params.telegramUserId);
  const slug = uniqueSlug(slugBaseFromDisplayName(displayName, channelHint), channelHint);
  const emailDomain = params.source === 'demo' ? 'demo.local' : 'invite.local';

  const state = blankState({
    slug,
    displayName,
    // Email is not collected; placeholder satisfies schema.
    contactEmail: `${slug}@${emailDomain}`,
  });

  if (params.telegramUserId != null) {
    state.user.telegram_user_ids = [params.telegramUserId];
  }
  if (params.slackUserId) {
    state.user.slack_user_ids = [params.slackUserId];
  }
  state.log.push({
    ts: new Date().toISOString().slice(0, 10),
    action: params.source === 'demo' ? 'demo_auto_created' : 'invite_redeemed',
    invite_code: params.inviteCode,
    telegram_user_id: params.telegramUserId,
    slack_user_id: params.slackUserId,
    mode: params.source === 'demo' ? 'demo' : 'instant',
  });

  saveState(state);

  const authToken = state.user.auth_token;
  if (!authToken) {
    throw new Error(`User "${slug}" created without auth_token`);
  }

  return { slug, displayName, authToken, state };
}

/**
 * Create the user profile and mark the invite used. Fail fast on any error.
 */
export function redeemInviteInstantly(params: InstantRedeemParams): InstantRedeemResult {
  const code = params.code.trim().toUpperCase();
  validateInviteCode(code);

  const result = ensureChannelUser({
    displayName: params.displayName,
    slackUserId: params.slackUserId,
    telegramUserId: params.telegramUserId,
    source: 'invite',
    inviteCode: code,
  });

  markInviteUsed(code, params.telegramUserId ?? 0, result.slug, params.slackUserId);
  return result;
}

/** Resolve Slack display name via users.info. Fail fast if missing. */
export async function fetchSlackDisplayName(slackUserId: string): Promise<string> {
  if (!slackUserId) {
    throw new Error('slackUserId is required to fetch Slack display name');
  }
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new Error('SLACK_BOT_TOKEN is required to resolve Slack display name during invite redeem');
  }

  const url = new URL('https://slack.com/api/users.info');
  url.searchParams.set('user', slackUserId);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Slack users.info HTTP ${res.status} for user ${slackUserId}`);
  }
  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
    user?: {
      name?: string;
      real_name?: string;
      profile?: { display_name?: string; real_name?: string };
    };
  };
  if (!data.ok) {
    throw new Error(`Slack users.info failed for ${slackUserId}: ${data.error ?? 'unknown error'}`);
  }
  const profile = data.user?.profile;
  const name =
    (profile?.display_name && profile.display_name.trim()) ||
    (profile?.real_name && profile.real_name.trim()) ||
    (data.user?.real_name && data.user.real_name.trim()) ||
    (data.user?.name && data.user.name.trim()) ||
    '';
  if (!name) {
    throw new Error(`Slack user ${slackUserId} has no displayable name`);
  }
  return name;
}

export function resolveUserAfterRedeem(params: {
  slackUserId?: string;
  telegramUserId?: number;
  slug: string;
}): UserState {
  if (params.slackUserId) {
    const u = resolveUserBySlackUser(params.slackUserId);
    if (u) return u;
  }
  if (params.telegramUserId != null) {
    const u = resolveUserByTelegramUser(params.telegramUserId);
    if (u) return u;
  }
  return loadState(params.slug);
}
