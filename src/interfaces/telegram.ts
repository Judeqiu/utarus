import { Telegraf } from 'telegraf';
import { config } from '../config.js';
import { getOrCreateAgent, clearAgentContext } from '../agent.js';
import {
  listUserSlugs,
  loadState,
  resolveUserByTelegramUser,
  loadDynamicAdminIds,
  createInviteCode,
  listInviteCodes,
  createAdminOnboardCode,
  listAdminOnboardCodes,
  revokeAdminOnboardCode,
} from '../state/index.js';

/**
 * Telegram interface. Same agent loop as the CLI — agent.prompt() +
 * subscribe(text_delta) → concatenate → single reply.
 *
 * Per-user agent key: tg_<userId>. Each Telegram user gets an isolated
 * conversation context.
 */

const processingUsers = new Set<string>();
const reactionUnsupported = new Set<number>();

function userKey(ctx: { from?: { id: number } }): string {
  const id = ctx.from?.id;
  if (!id) throw new Error('Telegram update missing from.id');
  return `tg_${id}`;
}

function isAdmin(ctx: { from?: { id: number } }): boolean {
  const id = ctx.from?.id;
  if (!id) return false;
  if (config.telegram.adminIds.includes(id)) return true;
  return loadDynamicAdminIds().includes(id);
}

async function sendTyping(chatId: number): Promise<void> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
    });
    const data = await res.json() as { ok: boolean; description?: string };
    if (!data.ok) {
      console.error(`[sendTyping] failed for chat ${chatId}: ${data.description}`);
    }
  } catch (err) {
    console.error('[sendTyping] error:', err);
  }
}

async function markSeen(chatId: number, messageId: number): Promise<void> {
  if (reactionUnsupported.has(chatId)) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/setMessageReaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, reaction: [{ type: 'emoji', emoji: '✅' }] }),
    });
    const data = await res.json() as { ok: boolean; description?: string };
    if (!data.ok) {
      console.error(`[markSeen] failed for chat ${chatId}: ${data.description}`);
      if (data.description?.includes('not enough rights') || data.description?.includes('REACTION_INVALID') || data.description?.includes('can\'t be managed by the bot')) {
        reactionUnsupported.add(chatId);
        console.warn(`[markSeen] reactions will be skipped for chat ${chatId} (${data.description})`);
      }
    }
  } catch (err) {
    console.error('[markSeen] error:', err);
  }
}

function startTypingLoop(chatId: number): () => void {
  let active = true;
  const interval = setInterval(() => {
    if (active) sendTyping(chatId);
  }, 4000);
  return () => {
    active = false;
    clearInterval(interval);
  };
}

async function callAgent(userKey: string, text: string): Promise<string> {
  const agent = getOrCreateAgent(userKey);
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
    '/list — list all users',
    '/get `<slug>` — show user record',
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
    'Or send a question in plain text.',
  ].join('\n');
}

export async function startTelegram(): Promise<void> {
  if (!config.telegram.botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required to start Telegram interface');
  }

  const bot = new Telegraf(config.telegram.botToken);

  bot.start((ctx) => ctx.reply(helpText(), { parse_mode: 'Markdown' }));
  bot.help((ctx) => ctx.reply(helpText(), { parse_mode: 'Markdown' }));

  bot.command('list', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply('⛔ Admin only.');
      return;
    }
    const slugs = listUserSlugs();
    if (slugs.length === 0) {
      await ctx.reply('No users yet.');
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
    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  });

  bot.command('get', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply('⛔ Admin only.');
      return;
    }
    const slug = ctx.message.text.split(/\s+/)[1]?.trim();
    if (!slug) {
      await ctx.reply('Usage: /get <slug>');
      return;
    }
    try {
      const state = loadState(slug);
      await ctx.reply(
        `User "${state.user.slug}" — ${state.profile.display_name}\n` +
        `Created ${state.user.created_at}. Contact: ${state.profile.contact_email}\n` +
        `${state.user.telegram_user_ids?.length ?? 0} Telegram account(s) linked.`
      );
    } catch (e) {
      await ctx.reply(`❌ ${e instanceof Error ? e.message : e}`);
    }
  });

  bot.command('clear', async (ctx) => {
    clearAgentContext(userKey(ctx));
    await ctx.reply('✅ Context cleared.');
  });

  bot.command('invite', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply('⛔ Admin only.');
      return;
    }
    const comment = ctx.message.text.replace(/^\/invite\s*/, '').trim() || undefined;
    try {
      const telegramUserId = ctx.from?.id;
      if (!telegramUserId) return;
      const entry = createInviteCode({ createdBy: telegramUserId, comment });
      const commentLine = entry.comment ? `\nComment: ${entry.comment}` : '';
      await ctx.reply(`✅ Invite code created: \`${entry.code}\`${commentLine}\n\nShare this code with the user.`, { parse_mode: 'Markdown' });
    } catch (e) {
      await ctx.reply(`❌ ${e instanceof Error ? e.message : e}`);
    }
  });

  bot.command('invites', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply('⛔ Admin only.');
      return;
    }
    const filter = (ctx.message.text.replace(/^\/invites\s*/, '').trim() || 'all') as 'all' | 'unused' | 'used';
    if (!['all', 'unused', 'used'].includes(filter)) {
      await ctx.reply('Usage: /invites [all|unused|used]');
      return;
    }
    const invites = listInviteCodes(filter);
    if (invites.length === 0) {
      await ctx.reply(`No ${filter === 'all' ? '' : filter + ' '}invite codes.`);
      return;
    }
    const lines = [`*${invites.length} invite code${invites.length === 1 ? '' : 's'}${filter !== 'all' ? ` (${filter})` : ''}:*`];
    for (const inv of invites) {
      const status = inv.used_by ? `✅ used by ${inv.used_by} → ${inv.slug ?? '?'} on ${inv.used_at}` : '⏳ unused';
      lines.push(`• \`${inv.code}\` — ${inv.created_at} by ${inv.created_by} — ${status}`);
    }
    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  });

  bot.command('admincode', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply('⛔ Admin only.');
      return;
    }
    const comment = ctx.message.text.replace(/^\/admincode\s*/, '').trim() || undefined;
    try {
      const telegramUserId = ctx.from?.id;
      if (!telegramUserId) return;
      const entry = createAdminOnboardCode({ createdBy: telegramUserId, comment });
      const commentLine = entry.comment ? `\nComment: ${entry.comment}` : '';
      await ctx.reply(`✅ Admin onboard code created: \`${entry.code}\`${commentLine}\n\nShare this code with the user.`, { parse_mode: 'Markdown' });
    } catch (e) {
      await ctx.reply(`❌ ${e instanceof Error ? e.message : e}`);
    }
  });

  bot.command('admincodes', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply('⛔ Admin only.');
      return;
    }
    const filter = (ctx.message.text.replace(/^\/admincodes\s*/, '').trim() || 'all') as 'all' | 'unused' | 'used';
    if (!['all', 'unused', 'used'].includes(filter)) {
      await ctx.reply('Usage: /admincodes [all|unused|used]');
      return;
    }
    const codes = listAdminOnboardCodes(filter);
    if (codes.length === 0) {
      await ctx.reply(`No ${filter === 'all' ? '' : filter + ' '}admin onboard codes.`);
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
    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  });

  bot.command('revoke', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply('⛔ Admin only.');
      return;
    }
    const code = ctx.message.text.replace(/^\/revoke\s*/, '').trim();
    if (!code) {
      await ctx.reply('Usage: /revoke <code>');
      return;
    }
    try {
      const entry = revokeAdminOnboardCode(code);
      await ctx.reply(`✅ Admin code \`${entry.code}\` revoked.${entry.comment ? ` Comment was: _${entry.comment}_` : ''}`, { parse_mode: 'Markdown' });
    } catch (e) {
      await ctx.reply(`❌ ${e instanceof Error ? e.message : e}`);
    }
  });

  bot.on('text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return;

    const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
    if (isGroup) {
      const botUsername = bot.botInfo?.username;
      if (!botUsername) return;
      const mentioned = ctx.message.entities?.some(
        (e) => e.type === 'mention' && ctx.message.text.slice(e.offset, e.offset + e.length) === `@${botUsername}`
      );
      if (!mentioned) return;
      ctx.message.text = ctx.message.text.replace(new RegExp(`@${botUsername}\\s*`, 'g'), '').trim();
      if (!ctx.message.text) return;
    }

    await markSeen(ctx.chat.id, ctx.message.message_id);

    const key = userKey(ctx);
    if (processingUsers.has(key)) {
      await ctx.reply('⏳ Still processing your previous message...');
      return;
    }
    processingUsers.add(key);

    const stopTyping = startTypingLoop(ctx.chat.id);
    try {
      const telegramUserId = ctx.from?.id;
      const linkedUser = telegramUserId ? resolveUserByTelegramUser(telegramUserId) : null;

      let enrichedText = ctx.message.text;
      if (linkedUser) {
        enrichedText = `[User context: You are working with user "${linkedUser.user.slug}" (${linkedUser.profile.display_name}, contact=${linkedUser.profile.contact_email}). The user is the linked Telegram account. Auto-load this user's state first.]\n\n${ctx.message.text}`;
      } else if (!isAdmin(ctx) && telegramUserId) {
        const adminCodeMatch = ctx.message.text.trim().match(/\b(ADM-[A-F0-9]{8})\b/i);
        if (adminCodeMatch) {
          const code = adminCodeMatch[1].toUpperCase();
          enrichedText = `[Admin onboard code] This user is redeeming an admin onboard code "${code}". Their Telegram user ID is ${telegramUserId}. Call redeem_admin_onboard_code with code="${code}" and telegram_user_id=${telegramUserId}. After redemption, tell the user they are now an admin.`;
        } else {
          const inviteMatch = ctx.message.text.trim().match(/\b(INV-[A-F0-9]{8})\b/i);
          if (inviteMatch) {
            const code = inviteMatch[1].toUpperCase();
            enrichedText = `[Invite code onboarding] This user is redeeming invite code "${code}". Their Telegram user ID is ${telegramUserId}. Run the onboarding flow to collect their display name and contact email, one at a time. Once you have both, call redeem_invite_code with the code, telegram_user_id, and the collected details. Be conversational. Don't dump all questions at once.\n\n${ctx.message.text}`;
          } else {
            await ctx.reply('⛔ You need an invite code to use this bot. Ask an admin for an invite code (INV-XXXXXXXX).');
            return;
          }
        }
      }

      const response = await callAgent(key, enrichedText);
      if (response.length <= 4000) {
        await ctx.reply(response);
      } else {
        const chunks = response.match(/[\s\S]{1,4000}/g) ?? [response];
        for (const chunk of chunks) {
          await ctx.reply(chunk);
        }
      }
    } catch (err) {
      console.error('[Telegram handler]', err);
      await ctx.reply('Sorry, something went wrong. Please try again.');
    } finally {
      stopTyping();
      processingUsers.delete(key);
    }
  });

  bot.catch((err) => {
    console.error('[Telegraf error]', err);
  });

  await bot.launch();
  console.log('Telegram bot is running.');

  const handleSignal = (sig: string) => {
    console.log(`\nReceived ${sig}, stopping Telegram bot...`);
    bot.stop(sig);
  };
  process.once('SIGINT', () => handleSignal('SIGINT'));
  process.once('SIGTERM', () => handleSignal('SIGTERM'));
}
