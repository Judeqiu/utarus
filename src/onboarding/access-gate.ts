/**
 * Standard access gate for all Utarus agents (Slack + Telegram).
 *
 * Unlinked non-admin users:
 *   - INV-… → instant redeem (channel display name), then continue as linked
 *   - ADM-… → agent prompt to redeem admin code (no profile Q&A)
 *   - demo mode on → auto-create profile (same as invite), then continue
 *   - else  → friendly deny (need invite)
 *
 * Domain enrichMessage runs after the gate and must not re-implement invite Q&A.
 */

import type { DomainExtension, EnrichMessageContext } from '../extension.js';
import {
  resolveUserBySlackUser,
  resolveUserByTelegramUser,
  type UserState,
} from '../state/index.js';
import { isDemoModeEnabled } from './demo-mode.js';
import {
  ensureChannelUser,
  fetchSlackDisplayName,
  redeemInviteInstantly,
  resolveUserAfterRedeem,
} from './instant-invite.js';

export type InboundResolveResult =
  | { kind: 'reply'; text: string }
  | { kind: 'agent'; text: string };

const NEED_INVITE =
  'You need an invite code to use this bot. Ask an admin for a code that looks like INV-XXXXXXXX. ' +
  '(When demo mode is on, anyone can join without a code.)';

function stripInviteCodes(text: string): string {
  return text.replace(/\bINV-[A-F0-9]{8}\b/gi, '').trim();
}

function defaultLinkedContext(
  user: UserState,
  text: string,
  justOnboarded?: { kind: 'invite' | 'demo'; label: string; displayName: string },
): string {
  let onboard = '';
  if (justOnboarded?.kind === 'invite') {
    onboard =
      `[Access] ${justOnboarded.displayName} just joined via invite ${justOnboarded.label}. ` +
      `Profile is ready — no signup or profile questions. Help them with their request right away. ` +
      `Be warm, clear, and professional.\n\n`;
  } else if (justOnboarded?.kind === 'demo') {
    onboard =
      `[Access] ${justOnboarded.displayName} joined under **demo mode** (auto profile). ` +
      `No signup questions. Help them with their request right away. Be warm, clear, and professional.\n\n`;
  }
  return (
    `${onboard}` +
    `[User context: You are working with user "${user.user.slug}" ` +
    `(${user.profile.display_name}, contact=${user.profile.contact_email}). ` +
    `Channel identity is already linked. Load this user's state when needed.]\n\n${text}`
  );
}

async function resolveDisplayName(params: {
  slackUserId?: string;
  telegramUserId?: number;
  channelDisplayName?: string;
}): Promise<string> {
  if (params.channelDisplayName?.trim()) {
    return params.channelDisplayName.trim();
  }
  if (params.slackUserId) {
    return fetchSlackDisplayName(params.slackUserId);
  }
  if (params.telegramUserId != null) {
    return `Telegram ${params.telegramUserId}`;
  }
  throw new Error('Profile create requires a channel identity');
}

function adminOnboardAgentText(params: {
  code: string;
  slackUserId?: string;
  telegramUserId?: number;
}): string {
  const code = params.code;
  if (params.telegramUserId != null) {
    return (
      `[Admin onboard] This person is redeeming admin code "${code}". ` +
      `Telegram user ID is ${params.telegramUserId}. Call redeem_admin_onboard_code with ` +
      `code="${code}" and telegram_user_id=${params.telegramUserId}. ` +
      `Then tell them they are now an admin — warm, clear, professional; no extra profile questions.`
    );
  }
  if (params.slackUserId) {
    return (
      `[Admin onboard] This person is redeeming admin code "${code}". ` +
      `Slack user ID is ${params.slackUserId}. Call redeem_admin_onboard_code with ` +
      `code="${code}" and slack_user_id="${params.slackUserId}". ` +
      `Then tell them they are now an admin — warm, clear, professional; no extra profile questions.`
    );
  }
  throw new Error('Admin onboard requires a channel identity');
}

/**
 * Full inbound resolution shared by Slack and Telegram.
 */
export async function resolveInboundMessage(params: {
  text: string;
  linkedUser: UserState | null;
  isAdmin: boolean;
  slackUserId?: string;
  telegramUserId?: number;
  channelDisplayName?: string;
  enrichMessage?: DomainExtension['enrichMessage'];
}): Promise<InboundResolveResult> {
  let linkedUser = params.linkedUser;
  let text = params.text;
  let justOnboarded: { kind: 'invite' | 'demo'; label: string; displayName: string } | undefined;

  // ── Framework access gate (all agents) ──────────────────────────────
  if (!linkedUser && !params.isAdmin) {
    const adminCodeMatch = params.text.trim().match(/\b(ADM-[A-F0-9]{8})\b/i);
    if (adminCodeMatch) {
      return {
        kind: 'agent',
        text: adminOnboardAgentText({
          code: adminCodeMatch[1].toUpperCase(),
          slackUserId: params.slackUserId,
          telegramUserId: params.telegramUserId,
        }),
      };
    }

    const inviteMatch = params.text.trim().match(/\b(INV-[A-F0-9]{8})\b/i);
    if (inviteMatch) {
      const code = inviteMatch[1].toUpperCase();
      try {
        const displayName = await resolveDisplayName(params);
        const redeemed = await redeemInviteInstantly({
          code,
          displayName,
          slackUserId: params.slackUserId,
          telegramUserId: params.telegramUserId,
        });
        linkedUser = resolveUserAfterRedeem({
          slackUserId: params.slackUserId,
          telegramUserId: params.telegramUserId,
          slug: redeemed.slug,
        });
        justOnboarded = { kind: 'invite', label: code, displayName: redeemed.displayName };
        const remainder = stripInviteCodes(params.text);
        text =
          remainder.length > 0
            ? remainder
            : 'I just joined with my invite code. Confirm I am set up and ask how you can help — no onboarding questions.';
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { kind: 'reply', text: msg };
      }
    } else if (isDemoModeEnabled()) {
      try {
        const displayName = await resolveDisplayName(params);
        const created = await ensureChannelUser({
          displayName,
          slackUserId: params.slackUserId,
          telegramUserId: params.telegramUserId,
          source: 'demo',
        });
        linkedUser = resolveUserAfterRedeem({
          slackUserId: params.slackUserId,
          telegramUserId: params.telegramUserId,
          slug: created.slug,
        });
        justOnboarded = { kind: 'demo', label: 'demo', displayName: created.displayName };
        // Keep their original message — they are already working.
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { kind: 'reply', text: msg };
      }
    } else {
      return { kind: 'reply', text: NEED_INVITE };
    }
  }

  // Re-resolve after redeem if IDs present (belt and suspenders)
  if (!linkedUser && params.slackUserId) {
    linkedUser = resolveUserBySlackUser(params.slackUserId);
  }
  if (!linkedUser && params.telegramUserId != null) {
    linkedUser = resolveUserByTelegramUser(params.telegramUserId);
  }

  // ── Domain enrichment (portfolio / seller / etc.) ───────────────────
  if (params.enrichMessage) {
    const ctx: EnrichMessageContext = {
      userSlug: linkedUser ? linkedUser.user.slug : '',
      telegramUserId: params.telegramUserId,
      slackUserId: params.slackUserId,
      isAdmin: params.isAdmin,
      text,
      channelDisplayName: params.channelDisplayName,
    };
    const result = await Promise.resolve(params.enrichMessage(ctx));
    if (result.startsWith('REPLY:')) {
      return { kind: 'reply', text: result.slice('REPLY:'.length).trim() };
    }
    if (justOnboarded) {
      const note =
        justOnboarded.kind === 'demo'
          ? `[Access] ${justOnboarded.displayName} joined under demo mode (auto profile). ` +
            `No signup questions. Be warm, clear, and professional.\n\n`
          : `[Access] ${justOnboarded.displayName} just joined via invite ${justOnboarded.label}. ` +
            `Profile ready — no signup questions. Be warm, clear, and professional.\n\n`;
      return { kind: 'agent', text: note + result };
    }
    return { kind: 'agent', text: result };
  }

  if (linkedUser) {
    return { kind: 'agent', text: defaultLinkedContext(linkedUser, text, justOnboarded) };
  }

  return { kind: 'agent', text: params.text };
}
