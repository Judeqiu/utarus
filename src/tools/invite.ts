/**
 * Invite + admin onboard code tools. Generic — no domain coupling.
 *
 * Two flows:
 *   1. Admin issues INV-XXXXXXXX → recipient redeems via Q&A → user created.
 *   2. Admin issues ADM-XXXXXXXX → recipient redeems → granted admin rights.
 */

import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import {
  createInviteCode,
  validateInviteCode,
  markInviteUsed,
  listInviteCodes,
  createAdminOnboardCode,
  validateAdminOnboardCode,
  markAdminOnboardCodeUsed,
  revokeAdminOnboardCode,
  listAdminOnboardCodes,
  addDynamicAdminId,
  blankState,
  saveState,
  stateExists,
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

export function createInviteTools(): AgentTool[] {
  const issue: AgentTool = {
    name: 'issue_invite_code',
    label: 'Issue Invite Code',
    description: 'Generate a lightweight invite code for a new user. No user information needed — the user provides details when redeeming. Admin only.',
    parameters: Type.Object({
      admin_telegram_id: Type.Number({ description: 'Admin Telegram user ID issuing this code.' }),
      comment: Type.Optional(Type.String({ description: 'What this code is for.' })),
      custom_code: Type.Optional(Type.String({ description: 'Optional custom code. Auto-generated if omitted. Must start with INV-.' })),
    }),
    async execute(_id, raw) {
      const p = raw as { admin_telegram_id: number; comment?: string; custom_code?: string };
      try {
        if (p.custom_code && !p.custom_code.startsWith('INV-')) {
          return fail('Custom code must start with "INV-".');
        }
        const invite = createInviteCode({
          createdBy: p.admin_telegram_id,
          comment: p.comment,
          customCode: p.custom_code,
        });
        const commentLine = invite.comment ? `\nComment: ${invite.comment}` : '';
        return ok(
          `Invite code created: ${invite.code}${commentLine}\nShare this code with the recipient. When they send it to the bot, they will be guided through a quick onboarding to provide their details.`,
          { invite }
        );
      } catch (e) { return failFrom(e); }
    },
  };

  const redeem: AgentTool = {
    name: 'redeem_invite_code',
    label: 'Redeem Invite Code',
    description: 'Redeem an invite code after collecting the user\'s information. Validates the code, creates the user record, and links the Telegram ID. Call this at the end of the onboarding Q&A, once you have display_name + contact_email.',
    parameters: Type.Object({
      code: Type.String({ description: 'The invite code (starts with INV-).' }),
      telegram_user_id: Type.Number({ description: 'Telegram user ID of the person redeeming the code.' }),
      display_name: Type.String({ description: 'User display name.' }),
      contact_email: Type.String({ description: 'Primary contact email.' }),
    }),
    async execute(_id, raw) {
      const p = raw as {
        code: string;
        telegram_user_id: number;
        display_name: string;
        contact_email: string;
      };
      try {
        validateInviteCode(p.code);

        const slug = p.display_name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '');

        if (!slug) {
          return fail('display_name must contain at least one alphanumeric character.');
        }

        if (stateExists(slug)) {
          return fail(`User slug "${slug}" already exists. Choose a different display name or contact admin.`);
        }

        const state = blankState({
          slug,
          displayName: p.display_name,
          contactEmail: p.contact_email,
        });

        state.user.telegram_user_ids = [p.telegram_user_id];
        state.log.push({
          ts: new Date().toISOString().slice(0, 10),
          action: 'invite_redeemed',
          invite_code: p.code,
          telegram_user_id: p.telegram_user_id,
        });

        const path = saveState(state);
        markInviteUsed(p.code, p.telegram_user_id, slug);

        return ok(
          `Invite code "${p.code}" redeemed!\nProfile created for "${p.display_name}" (slug: ${slug}).\nTelegram user ${p.telegram_user_id} linked.\nAuth token: ${state.user.auth_token}`,
          { state, path, slug }
        );
      } catch (e) { return failFrom(e); }
    },
  };

  const listInvites: AgentTool = {
    name: 'list_invite_codes',
    label: 'List Invite Codes',
    description: 'List invite codes with optional filter. Admin only.',
    parameters: Type.Object({
      filter: Type.Optional(Type.String({ description: 'Filter: "all" (default), "unused", or "used".' })),
    }),
    async execute(_id, raw) {
      const p = raw as { filter?: string };
      try {
        const filter = (p.filter as 'all' | 'unused' | 'used') || 'all';
        if (!['all', 'unused', 'used'].includes(filter)) {
          return fail('filter must be one of: all, unused, used');
        }
        const invites = listInviteCodes(filter);
        if (invites.length === 0) {
          return ok(`No ${filter === 'all' ? '' : filter + ' '}invite codes found.`, { invites, count: 0 });
        }
        const lines = [
          `*${invites.length} invite code${invites.length === 1 ? '' : 's'}${filter !== 'all' ? ` (${filter})` : ''}:*`,
          '',
          ...invites.map((inv, i) => {
            const status = inv.used_by ? `✅ used by ${inv.used_by} → ${inv.slug ?? '?'} on ${inv.used_at}` : '⏳ unused';
            const comment = inv.comment ? `\n    _${inv.comment}_` : '';
            return `${i + 1}. \`${inv.code}\`${comment}\n    Created ${inv.created_at} by ${inv.created_by} — ${status}`;
          }),
        ];
        return ok(lines.join('\n'), { invites, count: invites.length });
      } catch (e) { return failFrom(e); }
    },
  };

  const issueAdminCode: AgentTool = {
    name: 'issue_admin_onboard_code',
    label: 'Issue Admin Onboard Code',
    description: 'Generate a code that grants admin access to whoever redeems it. Admin only.',
    parameters: Type.Object({
      admin_telegram_id: Type.Number({ description: 'Admin Telegram user ID issuing this code.' }),
      comment: Type.Optional(Type.String({ description: 'What this code is for.' })),
      custom_code: Type.Optional(Type.String({ description: 'Optional custom code. Must start with ADM-.' })),
    }),
    async execute(_id, raw) {
      const p = raw as { admin_telegram_id: number; comment?: string; custom_code?: string };
      try {
        if (p.custom_code && !p.custom_code.startsWith('ADM-')) {
          return fail('Custom code must start with "ADM-".');
        }
        const entry = createAdminOnboardCode({
          createdBy: p.admin_telegram_id,
          comment: p.comment,
          customCode: p.custom_code,
        });
        const commentLine = entry.comment ? `\nComment: ${entry.comment}` : '';
        return ok(
          `Admin onboard code created: ${entry.code}${commentLine}\nShare this code with the user. When they send it to the bot, they will become an admin.`,
          { code: entry }
        );
      } catch (e) { return failFrom(e); }
    },
  };

  const redeemAdminCode: AgentTool = {
    name: 'redeem_admin_onboard_code',
    label: 'Redeem Admin Onboard Code',
    description: 'Redeem an admin onboard code: validate it and grant admin access to the user. The telegram_user_id is always provided in the message context. Call this when a user sends an admin onboard code.',
    parameters: Type.Object({
      code: Type.String({ description: 'The admin onboard code (starts with ADM-).' }),
      telegram_user_id: Type.Number({ description: 'Telegram user ID of the person redeeming the code.' }),
    }),
    async execute(_id, raw) {
      const p = raw as { code: string; telegram_user_id: number };
      try {
        validateAdminOnboardCode(p.code);
        addDynamicAdminId(p.telegram_user_id);
        markAdminOnboardCodeUsed(p.code, p.telegram_user_id);
        return ok(
          `Admin onboard code "${p.code}" redeemed!\nTelegram user ${p.telegram_user_id} is now an admin.`,
          { telegram_user_id: p.telegram_user_id }
        );
      } catch (e) { return failFrom(e); }
    },
  };

  const listAdminCodes: AgentTool = {
    name: 'list_admin_onboard_codes',
    label: 'List Admin Onboard Codes',
    description: 'List admin onboard codes with optional filter. Admin only.',
    parameters: Type.Object({
      filter: Type.Optional(Type.String({ description: 'Filter: "all" (default), "unused", or "used".' })),
    }),
    async execute(_id, raw) {
      const p = raw as { filter?: string };
      try {
        const filter = (p.filter as 'all' | 'unused' | 'used') || 'all';
        if (!['all', 'unused', 'used'].includes(filter)) {
          return fail('filter must be one of: all, unused, used');
        }
        const codes = listAdminOnboardCodes(filter);
        if (codes.length === 0) {
          return ok(`No ${filter === 'all' ? '' : filter + ' '}admin onboard codes found.`, { codes, count: 0 });
        }
        const lines = [
          `*${codes.length} admin onboard code${codes.length === 1 ? '' : 's'}${filter !== 'all' ? ` (${filter})` : ''}:*`,
          '',
          ...codes.map((c, i) => {
            let status: string;
            if (c.revoked) status = '🚫 REVOKED';
            else if (c.used_by) status = `✅ used by ${c.used_by} on ${c.used_at}`;
            else status = '⏳ unused';
            const comment = c.comment ? `\n    _${c.comment}_` : '';
            return `${i + 1}. \`${c.code}\`${comment}\n    Created ${c.created_at} by ${c.created_by} — ${status}`;
          }),
        ];
        return ok(lines.join('\n'), { codes, count: codes.length });
      } catch (e) { return failFrom(e); }
    },
  };

  const revokeAdminCode: AgentTool = {
    name: 'revoke_admin_onboard_code',
    label: 'Revoke Admin Onboard Code',
    description: 'Revoke an unused admin onboard code so it can no longer be redeemed. Admin only.',
    parameters: Type.Object({
      code: Type.String({ description: 'The admin onboard code to revoke (starts with ADM-).' }),
    }),
    async execute(_id, raw) {
      const p = raw as { code: string };
      try {
        const entry = revokeAdminOnboardCode(p.code);
        return ok(`Admin onboard code "${p.code}" revoked.${entry.comment ? ` Comment was: "${entry.comment}"` : ''}`, { code: entry });
      } catch (e) { return failFrom(e); }
    },
  };

  return [issue, redeem, listInvites, issueAdminCode, redeemAdminCode, listAdminCodes, revokeAdminCode];
}
