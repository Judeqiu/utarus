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

/**
 * Create the user profile and mark the invite used. Fail fast on any error.
 */
export function redeemInviteInstantly(params: InstantRedeemParams): InstantRedeemResult {
  const code = params.code.trim().toUpperCase();
  if (!params.slackUserId && params.telegramUserId == null) {
    throw new Error('redeemInviteInstantly requires slackUserId or telegramUserId');
  }
  const displayName = params.displayName.trim();
  if (!displayName) {
    throw new Error('displayName is required for instant invite redeem');
  }

  validateInviteCode(code);

  const channelHint = params.slackUserId ?? String(params.telegramUserId);
  const slug = uniqueSlug(slugBaseFromDisplayName(displayName, channelHint), channelHint);

  const state = blankState({
    slug,
    displayName,
    // Email is not collected in the instant flow; placeholder satisfies schema.
    contactEmail: `${slug}@invite.local`,
  });

  if (params.telegramUserId != null) {
    state.user.telegram_user_ids = [params.telegramUserId];
  }
  if (params.slackUserId) {
    state.user.slack_user_ids = [params.slackUserId];
  }
  state.log.push({
    ts: new Date().toISOString().slice(0, 10),
    action: 'invite_redeemed',
    invite_code: code,
    telegram_user_id: params.telegramUserId,
    slack_user_id: params.slackUserId,
    mode: 'instant',
  });

  saveState(state);
  markInviteUsed(code, params.telegramUserId ?? 0, slug, params.slackUserId);

  const authToken = state.user.auth_token;
  if (!authToken) {
    throw new Error(`User "${slug}" created without auth_token`);
  }

  return { slug, displayName, authToken, state };
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
