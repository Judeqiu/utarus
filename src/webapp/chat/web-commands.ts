/**
 * WebUI slash-command dispatch — domain commands from DomainExtension.webCommands.
 *
 * Mirror of Telegram bot.command / Slack app.command: a leading `/name [args]`
 * message is handled without the LLM. Framework commands: /clear and /help stay
 * on the SPA client; /usage is answered here server-side. All framework names
 * are reserved — domains must not register them.
 */

import type { DomainExtension } from '../../extension.js';
import { loadUsage, formatUsageReport } from '../../usage/index.js';

/** Framework-owned command names — domains must not register these. */
export const WEB_FRAMEWORK_COMMAND_NAMES = new Set(['clear', 'help', 'usage']);

export interface ParsedWebCommand {
  name: string;
  args: string;
}

/**
 * Parse a chat message as `/name [args]`. Returns null when the text is not
 * a single slash-command (free-form messages are left for the agent).
 */
export function parseWebSlashCommand(text: string): ParsedWebCommand | null {
  const trimmed = text.trim();
  const m = trimmed.match(/^\/([a-z][a-z0-9_]{0,31})(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  return {
    name: m[1]!.toLowerCase(),
    args: (m[2] ?? '').trim(),
  };
}

export interface WebCommandCatalogEntry {
  name: string;
  description: string;
  adminOnly: boolean;
  usageHint?: string;
  source: 'framework' | 'domain';
}

/** Public catalog for GET /api/chat/commands and /help UI. */
export function listWebCommandCatalog(
  extension: DomainExtension,
  opts?: { isAdmin?: boolean },
): WebCommandCatalogEntry[] {
  const framework: WebCommandCatalogEntry[] = [
    {
      name: 'clear',
      description: 'Clear messages in the current chat (keeps the chat in the list).',
      adminOnly: false,
      source: 'framework',
    },
    {
      name: 'help',
      description: 'Show available slash commands.',
      adminOnly: false,
      source: 'framework',
    },
    {
      name: 'usage',
      description: 'Show your LLM + tool usage for this month.',
      adminOnly: false,
      source: 'framework',
    },
  ];

  const domain: WebCommandCatalogEntry[] = [];
  for (const cmd of extension.webCommands ?? []) {
    const name = normalizeCommandName(cmd.name);
    if (!name || WEB_FRAMEWORK_COMMAND_NAMES.has(name)) continue;
    if (cmd.adminOnly && opts?.isAdmin === false) continue;
    domain.push({
      name,
      description: cmd.description,
      adminOnly: cmd.adminOnly,
      usageHint: cmd.usageHint,
      source: 'domain',
    });
  }

  return [...framework, ...domain];
}

function normalizeCommandName(raw: string): string {
  return raw.replace(/^\//, '').trim().toLowerCase();
}

export type WebCommandDispatchResult =
  | { kind: 'not_a_command' }
  | { kind: 'unmatched' }
  | { kind: 'forbidden'; text: string }
  | { kind: 'handled'; text: string };

/**
 * Try to run a slash command. Framework commands: /usage is answered here
 * (server-side usage data); /clear and /help return unmatched so the SPA
 * client owns them. Unknown names return unmatched for the agent.
 */
export async function dispatchWebCommand(params: {
  text: string;
  extension: DomainExtension;
  userSlug: string;
  isAdmin: boolean;
  conversationId?: string | null;
}): Promise<WebCommandDispatchResult> {
  const parsed = parseWebSlashCommand(params.text);
  if (!parsed) return { kind: 'not_a_command' };

  if (parsed.name === 'usage') {
    if (!params.userSlug) {
      return { kind: 'handled', text: '❌ No user profile linked to this session — nothing to show.' };
    }
    try {
      return { kind: 'handled', text: formatUsageReport(loadUsage(params.userSlug)) };
    } catch (e) {
      return { kind: 'handled', text: `❌ ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  if (WEB_FRAMEWORK_COMMAND_NAMES.has(parsed.name)) return { kind: 'unmatched' };

  const cmd = (params.extension.webCommands ?? []).find(
    c => normalizeCommandName(c.name) === parsed.name,
  );
  if (!cmd) return { kind: 'unmatched' };

  if (cmd.adminOnly && !params.isAdmin) {
    return { kind: 'forbidden', text: '⛔ Admin only.' };
  }

  try {
    const reply = await Promise.resolve(
      cmd.handler({
        args: parsed.args,
        userSlug: params.userSlug,
        isAdmin: params.isAdmin,
        conversationId: params.conversationId,
      }),
    );
    return { kind: 'handled', text: reply };
  } catch (e) {
    return {
      kind: 'handled',
      text: `❌ ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
