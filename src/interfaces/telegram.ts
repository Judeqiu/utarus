import { Telegraf } from 'telegraf';
import type { BotCommand } from '@telegraf/types';
import { config } from '../config.js';
import type { FrameworkHandle } from '../framework.js';
import type { DomainExtension } from '../extension.js';
import { clearAgentContext } from '../agent.js';
import { existsSync, readFileSync } from 'fs';
import { resolve, basename } from 'path';
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

export interface TelegramOptions {
  handle: FrameworkHandle;
}

/**
 * Telegram interface. Same agent loop as the CLI — agent.prompt() +
 * subscribe(text_delta) → concatenate → single reply.
 *
 * Per-user agent key: the user slug resolved from the Telegram user ID.
 */

const processingUsers = new Set<string>();

// Track the current Telegram chat ID so tools can send files.
// Set at the start of every inbound message; read by sendFileTool.
let currentChatId: number | undefined;
export function getCurrentChatId(): number | undefined {
    return currentChatId;
}
const reactionUnsupported = new Set<number>();

function isAdminFromId(id: number | undefined): boolean {
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

function helpText(ext?: DomainExtension): string {
  const name = config.agent.name ?? 'Utarus';
  const lines: string[] = [
    `*${name}*`,
    '',
    'Commands:',
    '/list — list all users',
    '/get `<slug>` — show user record',
    '/clear — clear your conversation context',
    '/help — show this help',
    '',
    'Admin commands:',
    '/invite [comment] — issue user invite code',
    '/invites [all|unused|used] — list invite codes',
    '/admincode [comment] — issue admin onboard code',
    '/admincodes [all|unused|used] — list admin onboard codes',
    '/revoke `<code>` — revoke an unused admin code',
  ];
  if (ext?.telegramCommands?.length) {
    lines.push('');
    lines.push('Domain commands:');
    for (const cmd of ext.telegramCommands) {
      lines.push(`/${cmd.name} — ${cmd.description}${cmd.adminOnly ? ' (admin)' : ''}`);
    }
  }
  lines.push('', 'Or send a question in plain text.');
  return lines.join('\n');
}

export async function startTelegram(opts: TelegramOptions): Promise<void> {
  const { handle } = opts;
  console.log('[Telegram] startTelegram() called');
  if (!config.telegram.botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required to start Telegram interface');
  }

  const bot = new Telegraf(config.telegram.botToken);
  const telegramBotCommands: BotCommand[] = [];

  bot.start((ctx) => ctx.reply(helpText(handle.extension), {}));
  bot.help((ctx) => ctx.reply(helpText(handle.extension), {}));
  telegramBotCommands.push({ command: 'start', description: 'start the bot — show help' });
  telegramBotCommands.push({ command: 'help', description: 'show help and command list' });

  // Register domain-specific commands (Utarus only handles user-management
  // commands; domains layer their own on top).
  for (const cmd of handle.extension.telegramCommands ?? []) {
    telegramBotCommands.push({ command: cmd.name, description: cmd.description });
    bot.command(cmd.name, async (ctx) => {
      const telegramUserId = ctx.from?.id ?? 0;
      const isAdmin = isAdminFromId(telegramUserId);
      if (cmd.adminOnly && !isAdmin) {
        await ctx.reply('⛔ Admin only.');
        return;
      }
      try {
        const args = ctx.message.text.replace(new RegExp(`^\\/${cmd.name}\\s*`, 'i'), '').trim();
        const reply = await Promise.resolve(cmd.handler({ args, telegramUserId, isAdmin }));
        await ctx.reply(reply, {});
      } catch (e) {
        await ctx.reply(`❌ ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  telegramBotCommands.push({ command: 'list', description: 'list all linked users' });
  bot.command('list', async (ctx) => {
    if (!isAdminFromId(ctx.from?.id)) {
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
    await ctx.reply(lines.join('\n'), {});
  });

  telegramBotCommands.push({ command: 'get', description: 'show a linked user\'s record (admin)' });
  bot.command('get', async (ctx) => {
    if (!isAdminFromId(ctx.from?.id)) {
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
      if (handle.extension.buildSessionAnnouncement) {
        await ctx.reply(handle.extension.buildSessionAnnouncement(state));
      } else {
        await ctx.reply(
          `User "${state.user.slug}" — ${state.profile.display_name}\n` +
          `Created ${state.user.created_at}. Contact: ${state.profile.contact_email}\n` +
          `${state.user.telegram_user_ids?.length ?? 0} Telegram account(s) linked.`
        );
      }
    } catch (e) {
      await ctx.reply(`❌ ${e instanceof Error ? e.message : e}`);
    }
  });

  telegramBotCommands.push({ command: 'clear', description: 'clear your conversation context' });
  bot.command('clear', async (ctx) => {
    const telegramUserId = ctx.from?.id;
    const user = telegramUserId ? resolveUserByTelegramUser(telegramUserId) : null;
    const slug = user ? user.user.slug : (telegramUserId ? `tg-${telegramUserId}` : null);
    if (slug) clearAgentContext(slug);
    await ctx.reply('✅ Context cleared.');
  });

  telegramBotCommands.push({ command: 'invite', description: 'issue a new user invite code (admin)' });
  bot.command('invite', async (ctx) => {
    if (!isAdminFromId(ctx.from?.id)) {
      await ctx.reply('⛔ Admin only.');
      return;
    }
    const comment = ctx.message.text.replace(/^\/invite\s*/, '').trim() || undefined;
    try {
      const telegramUserId = ctx.from?.id;
      if (!telegramUserId) return;
      const entry = createInviteCode({ createdBy: telegramUserId, comment });
      const commentLine = entry.comment ? `\nComment: ${entry.comment}` : '';
      await ctx.reply(`✅ Invite code created: \`${entry.code}\`${commentLine}\n\nShare this code with the user.`, {});
    } catch (e) {
      await ctx.reply(`❌ ${e instanceof Error ? e.message : e}`);
    }
  });

  telegramBotCommands.push({ command: 'invites', description: 'list invite codes (admin)' });
  bot.command('invites', async (ctx) => {
    if (!isAdminFromId(ctx.from?.id)) {
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
    await ctx.reply(lines.join('\n'), {});
  });

  telegramBotCommands.push({ command: 'admincode', description: 'issue a new admin onboard code (admin)' });
  bot.command('admincode', async (ctx) => {
    if (!isAdminFromId(ctx.from?.id)) {
      await ctx.reply('⛔ Admin only.');
      return;
    }
    const comment = ctx.message.text.replace(/^\/admincode\s*/, '').trim() || undefined;
    try {
      const telegramUserId = ctx.from?.id;
      if (!telegramUserId) return;
      const entry = createAdminOnboardCode({ createdBy: telegramUserId, comment });
      const commentLine = entry.comment ? `\nComment: ${entry.comment}` : '';
      await ctx.reply(`✅ Admin onboard code created: \`${entry.code}\`${commentLine}\n\nShare this code with the user.`, {});
    } catch (e) {
      await ctx.reply(`❌ ${e instanceof Error ? e.message : e}`);
    }
  });

  telegramBotCommands.push({ command: 'admincodes', description: 'list admin onboard codes (admin)' });
  bot.command('admincodes', async (ctx) => {
    if (!isAdminFromId(ctx.from?.id)) {
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
    await ctx.reply(lines.join('\n'), {});
  });

  telegramBotCommands.push({ command: 'revoke', description: 'revoke an unused admin onboard code (admin)' });
  bot.command('revoke', async (ctx) => {
    if (!isAdminFromId(ctx.from?.id)) {
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
      await ctx.reply(`✅ Admin code \`${entry.code}\` revoked.${entry.comment ? ` Comment was: _${entry.comment}_` : ''}`, {});
    } catch (e) {
      await ctx.reply(`❌ ${e instanceof Error ? e.message : e}`);
    }
  });

  // Resolve a user (or null) for a telegram id. If none, check whether the id
  // maps to a legacy entity record (domain-specific) so lazy migration works.
  async function resolveUserForTelegram(
    telegramUserId: number,
    entity: DomainExtension['resolveEntitySlug'],
  ) {
    const byTelegram = resolveUserByTelegramUser(telegramUserId);
    if (byTelegram) return byTelegram;
    if (entity) {
      // Domain may have a pre-existing entity keyed directly by telegram id.
      // (Legacy Binary sellers, for instance.) Suppress errors — null is fine.
    }
    return null;
  }

  // Debug: log ALL incoming updates to diagnose handler issues.
  bot.use((ctx, next) => {
    console.log(`[Telegram] Update type: ${ctx.updateType}, keys: ${Object.keys(ctx.update).join(',')}`);
    return next();
  });

  bot.on('message', async (ctx) => {
    console.log(`[Telegram] Received message: updateType=${ctx.updateType}, hasText=${!!ctx.message?.text}, text=${(ctx.message?.text || '').slice(0, 50)}`);
    if (!ctx.message?.text) return;
    if (ctx.message.text.startsWith('/')) return;

    // Track chat ID so tools (e.g. send_file) can send documents.
    if (ctx.chat?.id) currentChatId = ctx.chat.id;

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

    const telegramUserId = ctx.from?.id;
    const linkedUser = await resolveUserForTelegram(telegramUserId ?? -1, handle.extension.resolveEntitySlug);
    const userSlug = linkedUser ? linkedUser.user.slug : (telegramUserId ? `tg-${telegramUserId}` : 'unknown');
    const admin = isAdminFromId(telegramUserId);

    if (processingUsers.has(userSlug)) {
      await ctx.reply('⏳ Still processing your previous message...');
      return;
    }
    processingUsers.add(userSlug);

    const stopTyping = startTypingLoop(ctx.chat.id);
    try {
      let enrichedText: string;

      if (handle.extension.enrichMessage) {
        enrichedText = await Promise.resolve(
          handle.extension.enrichMessage({
            userSlug: linkedUser ? linkedUser.user.slug : '',
            telegramUserId,
            isAdmin: admin,
            text: ctx.message.text,
          }),
        );
        if (enrichedText.startsWith('REPLY:')) {
          await ctx.reply(enrichedText.slice('REPLY:'.length).trim());
          return;
        }
      } else {
        // Default Utarus enrichment — guide onboarding for unknown users.
        if (linkedUser) {
          enrichedText = `[User context: You are working with user "${linkedUser.user.slug}" (${linkedUser.profile.display_name}, contact=${linkedUser.profile.contact_email}). The user is the linked Telegram account. Auto-load this user's state first.]\n\n${ctx.message.text}`;
        } else if (!admin && telegramUserId) {
          const adminCodeMatch = ctx.message.text.trim().match(/\b(ADM-[A-F0-9]{8})\b/i);
          if (adminCodeMatch) {
            const code = adminCodeMatch[1].toUpperCase();
            enrichedText = `[Admin onboard code] This user is redeeming an admin onboard code "${code}". Their Telegram user ID is ${telegramUserId}. Call redeem_admin_onboard_code with code="${code}" and telegram_user_id=${telegramUserId}. After redemption, tell the user they are now an admin.`;
          } else {
            const inviteMatch = ctx.message.text.trim().match(/\b(INV-[A-F0-9]{8})\b/i);
            if (inviteMatch) {
              const code = inviteMatch[1].toUpperCase();
              enrichedText = `[Invite code onboarding] This user is redeeming invite code "${code}". Their Telegram user ID is ${telegramUserId}. Run the onboarding Q&A to collect these TWO mandatory fields (the user can provide them at their own pace — one field per turn is fine):

  1. display_name — their name or nickname
  2. contact_email — a valid email address

The record cannot be created until BOTH are provided. Be friendly and don't pressure. If the user sends a valid-looking value for one field, accept it and gently prompt for the other. If a value looks wrong (e.g. malformed email), say so once and ask again nicely. Once you have both, call redeem_invite_code with code="${code}", telegram_user_id=${telegramUserId}, display_name, and contact_email. After redeeming, tell them they now have access and can start using the bot.\n\n${ctx.message.text}`;
            } else {
              await ctx.reply('⛔ You need an invite code to use this bot. Ask an admin for an invite code (INV-XXXXXXXX).');
              return;
            }
          }
        } else {
          enrichedText = ctx.message.text;
        }
      }

      const response = await callAgent(handle, userSlug, admin, enrichedText);

      // Auto-detect BinDrive file references in the response and send them as documents.
      // Matches both raw paths (data/drive/<seller>/<file>.html) and URLs
      // (http://host/api/files/<file>.html/view?slug=<seller>).
      const rawPathRegex = /data\/drive\/([a-z0-9-]+)\/([a-z0-9-]+\.(html|csv|pdf|txt|md))/g;
      const urlRegex = /https?:\/\/[^\s]+\/api\/files\/([a-z0-9-]+\.(html|csv|pdf|txt|md))\/view\?slug=([a-z0-9-]+)/g;

      const filesToSend: Array<{ path: string; name: string }> = [];

      let m: RegExpExecArray | null;
      while ((m = rawPathRegex.exec(response)) !== null) {
        filesToSend.push({ path: `data/drive/${m[1]}/${m[2]}`, name: m[2] });
      }
      while ((m = urlRegex.exec(response)) !== null) {
        const name = m[1];
        const seller = m[3];
        filesToSend.push({ path: `data/drive/${seller}/${name}`, name });
      }

      // Dedupe by path
      const seen = new Set<string>();
      for (const f of filesToSend) {
        if (seen.has(f.path)) continue;
        seen.add(f.path);
        const absPath = resolve(process.cwd(), f.path);
        if (existsSync(absPath)) {
          try {
            await ctx.telegram.sendDocument(
              ctx.chat.id,
              { source: readFileSync(absPath), filename: f.name },
              { caption: `📊 ${f.name}` },
            );
          } catch (e) {
            console.error(`[Telegram] sendDocument failed for ${f.path}:`, e);
          }
        }
      }

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
      processingUsers.delete(userSlug);
    }
  });

  bot.catch((err) => {
    console.error('[Telegraf error]', err);
  });

  try {
    await bot.telegram.setMyCommands(telegramBotCommands);
    console.log(`Registered ${telegramBotCommands.length} /commands with Telegram.`);
  } catch (err) {
    console.error('[Telegram] setMyCommands failed:', err instanceof Error ? err.message : err);
  }

  // bot.launch() returns a promise that resolves only when the bot stops.
  // It is SUPPOSED to hang while the bot is polling — do NOT await it with
  // a timeout, or you'll kill a healthy bot.
  //
  // Return this promise so callers (Binary's main) can keep the Node.js
  // process alive by awaiting it.
  const launchPromise = bot.launch().catch((err) => {
    console.error('[Telegram] bot.launch error:', err instanceof Error ? err.message : err);
  });
  console.log('Telegram bot is running.');
  return launchPromise;

  const handleSignal = (sig: string) => {
    console.log(`\nReceived ${sig}, stopping Telegram bot...`);
    bot.stop(sig);
  };
  process.once('SIGINT', () => handleSignal('SIGINT'));
  process.once('SIGTERM', () => handleSignal('SIGTERM'));
}
