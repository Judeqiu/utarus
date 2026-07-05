import Bolt from '@slack/bolt';
const { App } = Bolt;
import { config } from '../config.js';
import type { FrameworkHandle } from '../framework.js';
import { clearAgentContext } from '../agent.js';
import {
  listUserSlugs,
  loadState,
  resolveUserBySlackUser,
  loadDynamicAdminIds,
  createInviteCode,
  listInviteCodes,
  createAdminOnboardCode,
  listAdminOnboardCodes,
  revokeAdminOnboardCode,
} from '../state/index.js';

export interface SlackOptions {
  handle: FrameworkHandle;
}

/**
 * Slack interface. Same agent loop as CLI/Telegram — agent.prompt() +
 * subscribe(text_delta) → concatenate → single reply.
 *
 * Per-user agent key: the user slug resolved from the Slack user ID.
 */

const processingUsers = new Map<string, number>();

function isAdminFromSlackId(userId: string): boolean {
  const adminIds = process.env.SLACK_ADMIN_IDS
    ? process.env.SLACK_ADMIN_IDS.split(',').map(id => id.trim())
    : [];
  return adminIds.includes(userId);
}

function isProcessing(userId: string): boolean {
  const timestamp = processingUsers.get(userId);
  if (!timestamp) return false;
  if (Date.now() - timestamp > 120000) {
    processingUsers.delete(userId);
    return false;
  }
  return true;
}

function formatForSlack(text: string): string {
  return text.replace(/(\|.+\|[\r\n]+\|[-| :]+\|[\r\n](?:\|.+\|[\r\n]*)+)/g, (match) => {
    const rows = match.trim().split('\n').filter(r => r.trim());
    if (rows.length < 2) return match;

    const headers = rows[0].split('|').filter(c => c.trim()).map(c => c.trim());
    const dataRows = rows.slice(2).map(row =>
      row.split('|').filter(c => c.trim()).map(c => c.trim())
    );

    const colWidths = headers.map((h, i) => {
      const maxData = dataRows.reduce((max, row) => Math.max(max, (row[i] || '').length), 0);
      return Math.max(h.length, maxData);
    });

    const pad = (s: string, w: number) => s.padEnd(w);
    const sep = colWidths.map(w => '-'.repeat(w)).join(' + ');

    let result = '```\n';
    result += headers.map((h, i) => pad(h, colWidths[i])).join(' | ') + '\n';
    result += sep + '\n';
    dataRows.forEach(row => {
      result += headers.map((_, i) => pad(row[i] || '', colWidths[i])).join(' | ') + '\n';
    });
    result += '```';

    return result;
  });
}

async function sendTyping(channel: string, botToken: string): Promise<void> {
  try {
    await fetch('https://slack.com/api/conversations.typing', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${botToken}`,
      },
      body: JSON.stringify({ channel }),
    });
  } catch (e) {
    // Ignore typing errors
  }
}

async function safeSay(say: (msg: { text: string }) => Promise<unknown>, text: string): Promise<void> {
  try {
    await say({ text });
  } catch (error) {
    console.error('[Say Error]', error);
  }
}

async function callAgent(
  handle: FrameworkHandle,
  key: string,
  isAdmin: boolean,
  text: string,
): Promise<string> {
  const agent = handle.getOrCreateAgent(key, isAdmin);
  let fullResponse = '';

  const unsubscribe = agent.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
      fullResponse += event.assistantMessageEvent.delta;
    }
  });

  try {
    await agent.prompt(text);
  } finally {
    unsubscribe();
  }

  return fullResponse || 'Sorry, I could not generate a response.';
}

function helpText(): string {
  const name = config.agent.name ?? 'Utarus';
  return [
    `*${name}*`,
    '',
    'Commands:',
    '/list — list all users (admin)',
    '/get `<slug>` — show user record (admin)',
    '/clear — clear your conversation context',
    '/help — show this help',
    '',
    'Admin commands:',
    '/invite [comment] — issue invite code',
    '/invites [all|unused|used] — list invite codes',
    '/admincode [comment] — issue admin onboard code',
    '/admincodes [all|unused|used] — list admin onboard codes',
    '/revoke `<code>` — revoke an unused admin code',
    '',
    'Or send a message in plain text.',
  ].join('\n');
}

export async function startSlack(opts: SlackOptions): Promise<void> {
  const { handle } = opts;
  if (!config.slack.botToken || !config.slack.appToken || !config.slack.signingSecret) {
    throw new Error('SLACK_BOT_TOKEN, SLACK_APP_TOKEN, and SLACK_SIGNING_SECRET are required to start Slack interface');
  }

  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    signingSecret: config.slack.signingSecret,
    socketMode: true,
  });

  app.error(async (error) => {
    console.error('[Slack Error]:', error);
  });

  // /help command
  app.command('/help', async ({ ack, respond }) => {
    await ack();
    await respond({
      response_type: 'ephemeral',
      text: helpText(),
    });
  });

  // /clear command
  app.command('/clear', async ({ ack, command, respond }) => {
    await ack();
    const slackUserId = command.user_id;
    const user = resolveUserBySlackUser(slackUserId);
    const key = user ? user.user.slug : `slack-${slackUserId}`;
    clearAgentContext(key);
    await respond({
      response_type: 'ephemeral',
      text: '✅ Context cleared. Starting fresh conversation.',
    });
  });

  // /list command (admin only)
  app.command('/list', async ({ ack, command, respond }) => {
    await ack();
    if (!isAdminFromSlackId(command.user_id)) {
      await respond({ response_type: 'ephemeral', text: '⛔ Admin only.' });
      return;
    }
    const slugs = listUserSlugs();
    if (slugs.length === 0) {
      await respond({ response_type: 'ephemeral', text: 'No users yet.' });
      return;
    }
    const lines: string[] = ['Users:'];
    for (const slug of slugs) {
      try {
        const s = loadState(slug);
        lines.push(`• \`${slug}\` — ${s.profile.display_name} (created ${s.user.created_at})`);
      } catch (e) {
        lines.push(`• \`${slug}\` — ERROR: ${e instanceof Error ? e.message : e}`);
      }
    }
    await respond({ response_type: 'ephemeral', text: lines.join('\n') });
  });

  // /get command (admin only)
  app.command('/get', async ({ ack, command, respond }) => {
    await ack();
    if (!isAdminFromSlackId(command.user_id)) {
      await respond({ response_type: 'ephemeral', text: '⛔ Admin only.' });
      return;
    }
    const slug = command.text?.trim();
    if (!slug) {
      await respond({ response_type: 'ephemeral', text: 'Usage: /get <slug>' });
      return;
    }
    try {
      const state = loadState(slug);
      const text = handle.extension.buildSessionAnnouncement
        ? handle.extension.buildSessionAnnouncement(state)
        : `User "${state.user.slug}" — ${state.profile.display_name}\n` +
          `Created ${state.user.created_at}. Contact: ${state.profile.contact_email}\n` +
          `${state.user.telegram_user_ids?.length ?? 0} Telegram account(s) linked.`;
      await respond({ response_type: 'ephemeral', text });
    } catch (e) {
      await respond({ response_type: 'ephemeral', text: `❌ ${e instanceof Error ? e.message : e}` });
    }
  });

  // /invite command (admin only)
  app.command('/invite', async ({ ack, command, respond }) => {
    await ack();
    if (!isAdminFromSlackId(command.user_id)) {
      await respond({ response_type: 'ephemeral', text: '⛔ Admin only.' });
      return;
    }
    const comment = command.text?.trim() || undefined;
    try {
      const entry = createInviteCode({ createdBy: 0, createdBySlack: command.user_id, comment });
      const commentLine = entry.comment ? `\nComment: ${entry.comment}` : '';
      await respond({
        response_type: 'ephemeral',
        text: `✅ Invite code created: \`${entry.code}\`${commentLine}\n\nShare this code with the user.`,
      });
    } catch (e) {
      await respond({ response_type: 'ephemeral', text: `❌ ${e instanceof Error ? e.message : e}` });
    }
  });

  // /invites command (admin only)
  app.command('/invites', async ({ ack, command, respond }) => {
    await ack();
    if (!isAdminFromSlackId(command.user_id)) {
      await respond({ response_type: 'ephemeral', text: '⛔ Admin only.' });
      return;
    }
    const filter = (command.text?.trim() || 'all') as 'all' | 'unused' | 'used';
    if (!['all', 'unused', 'used'].includes(filter)) {
      await respond({ response_type: 'ephemeral', text: 'Usage: /invites [all|unused|used]' });
      return;
    }
    const invites = listInviteCodes(filter);
    if (invites.length === 0) {
      await respond({ response_type: 'ephemeral', text: `No ${filter === 'all' ? '' : filter + ' '}invite codes.` });
      return;
    }
    const lines = [`*${invites.length} invite code${invites.length === 1 ? '' : 's'}${filter !== 'all' ? ` (${filter})` : ''}:*`];
    for (const inv of invites) {
      const status = inv.used_by ? `✅ used by ${inv.used_by} → ${inv.slug ?? '?'} on ${inv.used_at}` : '⏳ unused';
      lines.push(`• \`${inv.code}\` — ${inv.created_at} by ${inv.created_by} — ${status}`);
    }
    await respond({ response_type: 'ephemeral', text: lines.join('\n') });
  });

  // /admincode command (admin only)
  app.command('/admincode', async ({ ack, command, respond }) => {
    await ack();
    if (!isAdminFromSlackId(command.user_id)) {
      await respond({ response_type: 'ephemeral', text: '⛔ Admin only.' });
      return;
    }
    const comment = command.text?.trim() || undefined;
    try {
      const entry = createAdminOnboardCode({ createdBy: 0, createdBySlack: command.user_id, comment });
      const commentLine = entry.comment ? `\nComment: ${entry.comment}` : '';
      await respond({
        response_type: 'ephemeral',
        text: `✅ Admin onboard code created: \`${entry.code}\`${commentLine}\n\nShare this code with the user.`,
      });
    } catch (e) {
      await respond({ response_type: 'ephemeral', text: `❌ ${e instanceof Error ? e.message : e}` });
    }
  });

  // /admincodes command (admin only)
  app.command('/admincodes', async ({ ack, command, respond }) => {
    await ack();
    if (!isAdminFromSlackId(command.user_id)) {
      await respond({ response_type: 'ephemeral', text: '⛔ Admin only.' });
      return;
    }
    const filter = (command.text?.trim() || 'all') as 'all' | 'unused' | 'used';
    if (!['all', 'unused', 'used'].includes(filter)) {
      await respond({ response_type: 'ephemeral', text: 'Usage: /admincodes [all|unused|used]' });
      return;
    }
    const codes = listAdminOnboardCodes(filter);
    if (codes.length === 0) {
      await respond({ response_type: 'ephemeral', text: `No ${filter === 'all' ? '' : filter + ' '}admin onboard codes.` });
      return;
    }
    const lines = [`*${codes.length} admin onboard code${codes.length === 1 ? '' : 's'}${filter !== 'all' ? ` (${filter})` : ''}:*`];
    for (const c of codes) {
      let status: string;
      if (c.revoked) status = '🚫 REVOKED';
      else if (c.used_by) status = `✅ used by ${c.used_by} on ${c.used_at}`;
      else status = '⏳ unused';
      const comment = c.comment ? ` — _${c.comment}_` : '';
      lines.push(`• \`${c.code}\`${comment} — ${c.created_at} by ${c.created_by} — ${status}`);
    }
    await respond({ response_type: 'ephemeral', text: lines.join('\n') });
  });

  // /revoke command (admin only)
  app.command('/revoke', async ({ ack, command, respond }) => {
    await ack();
    if (!isAdminFromSlackId(command.user_id)) {
      await respond({ response_type: 'ephemeral', text: '⛔ Admin only.' });
      return;
    }
    const code = command.text?.trim();
    if (!code) {
      await respond({ response_type: 'ephemeral', text: 'Usage: /revoke <code>' });
      return;
    }
    try {
      const entry = revokeAdminOnboardCode(code);
      await respond({
        response_type: 'ephemeral',
        text: `✅ Admin code \`${entry.code}\` revoked.${entry.comment ? ` Comment was: _${entry.comment}_` : ''}`,
      });
    } catch (e) {
      await respond({ response_type: 'ephemeral', text: `❌ ${e instanceof Error ? e.message : e}` });
    }
  });

  // Handle direct messages
  app.message(async ({ message, say }) => {
    if (!('text' in message) || !message.text) return;

    const slackUserId = message.user ?? 'unknown';
    const userMessage = message.text;

    const linkedUser = resolveUserBySlackUser(slackUserId);
    const userSlug = linkedUser ? linkedUser.user.slug : `slack-${slackUserId}`;
    const admin = isAdminFromSlackId(slackUserId);

    if (processingUsers.has(userSlug)) {
      await safeSay(say, '⏳ Still processing your previous message...');
      return;
    }

    console.log(`[Slack DM] ${slackUserId}: ${userMessage}`);
    processingUsers.set(userSlug, Date.now());

    await sendTyping(message.channel, config.slack.botToken!);

    try {
      let enrichedText: string;

      if (handle.extension.enrichMessage) {
        enrichedText = await Promise.resolve(
          handle.extension.enrichMessage({
            userSlug: linkedUser ? linkedUser.user.slug : '',
            slackUserId,
            isAdmin: admin,
            text: userMessage,
          }),
        );
        if (enrichedText.startsWith('REPLY:')) {
          await safeSay(say, formatForSlack(enrichedText.slice('REPLY:'.length).trim()));
          return;
        }
      } else {
        // Default Utarus enrichment — guide onboarding for unknown users.
        if (linkedUser) {
          enrichedText = `[User context: You are working with user "${linkedUser.user.slug}" (${linkedUser.profile.display_name}, contact=${linkedUser.profile.contact_email}). The user is the linked Slack account. Auto-load this user's state first.]\n\n${userMessage}`;
        } else if (!admin) {
          const adminCodeMatch = userMessage.trim().match(/\b(ADM-[A-F0-9]{8})\b/i);
          if (adminCodeMatch) {
            const code = adminCodeMatch[1].toUpperCase();
            enrichedText = `[Admin onboard code] This user is redeeming an admin onboard code "${code}". Their Slack user ID is ${slackUserId}. Call redeem_admin_onboard_code with code="${code}" and slack_user_id="${slackUserId}". After redemption, tell the user they are now an admin.`;
          } else {
            const inviteMatch = userMessage.trim().match(/\b(INV-[A-F0-9]{8})\b/i);
            if (inviteMatch) {
              const code = inviteMatch[1].toUpperCase();
              enrichedText = `[Invite code onboarding] This user is redeeming invite code "${code}". Their Slack user ID is ${slackUserId}. Run the onboarding flow to collect their display name and contact email, one at a time. Once you have both, call redeem_invite_code with the code, slack_user_id, and the collected details. Be conversational. Don't dump all questions at once.\n\n${userMessage}`;
            } else {
              await safeSay(say, '⛔ You need an invite code to use this bot. Ask an admin for an invite code (INV-XXXXXXXX).');
              return;
            }
          }
        } else {
          enrichedText = userMessage;
        }
      }

      const response = await callAgent(handle, userSlug, admin, enrichedText);
      console.log(`[Agent]: ${response.slice(0, 100)}...`);
      await safeSay(say, formatForSlack(response));
    } catch (error) {
      console.error('Message handler error:', error);
      await safeSay(say, 'Sorry, something went wrong. Please try again.');
    } finally {
      processingUsers.delete(userSlug);
    }
  });

  // Handle app mentions in channels
  app.event('app_mention', async ({ event, say }) => {
    if (!('text' in event) || !event.text) return;

    const userMessage = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
    if (!userMessage) {
      await safeSay(say, '👋 Hey! How can I help you today?');
      return;
    }

    const slackUserId = event.user ?? 'unknown';

    const linkedUser = resolveUserBySlackUser(slackUserId);
    const userSlug = linkedUser ? linkedUser.user.slug : `slack-${slackUserId}`;

    if (processingUsers.has(userSlug)) {
      await safeSay(say, '⏳ Still processing your previous message...');
      return;
    }

    console.log(`[Slack Mention] ${slackUserId}: ${userMessage}`);
    processingUsers.set(userSlug, Date.now());

    const channelId = event.channel ?? 'unknown';
    await sendTyping(channelId, config.slack.botToken!);

    try {
      const admin = isAdminFromSlackId(slackUserId);
      let enrichedText = userMessage;
      if (handle.extension.enrichMessage) {
        const result = await Promise.resolve(
          handle.extension.enrichMessage({
            userSlug: linkedUser ? linkedUser.user.slug : '',
            slackUserId,
            isAdmin: admin,
            text: userMessage,
          }),
        );
        if (result.startsWith('REPLY:')) {
          await safeSay(say, formatForSlack(result.slice('REPLY:'.length).trim()));
          return;
        }
        enrichedText = result;
      }
      const response = await callAgent(handle, userSlug, admin, enrichedText);
      await safeSay(say, formatForSlack(response));
    } catch (error) {
      console.error('App mention error:', error);
      await safeSay(say, 'Sorry, I had trouble processing that.');
    } finally {
      processingUsers.delete(userSlug);
    }
  });

  await app.start();
  console.log('Slack bot is running.');

  const handleSignal = (sig: string) => {
    console.log(`\nReceived ${sig}, stopping Slack bot...`);
    process.exit(0);
  };
  process.once('SIGINT', () => handleSignal('SIGINT'));
  process.once('SIGTERM', () => handleSignal('SIGTERM'));
}
