import * as readline from 'node:readline';
import { stdin, stdout } from 'node:process';
import type { FrameworkHandle } from '../framework.js';
import { clearAgentContext } from '../agent.js';
import { listUserSlugs, loadState } from '../state/index.js';
import { config } from '../config.js';

export interface CliOptions {
  handle: FrameworkHandle;
}

const CLI_USER_SLUG = 'cli-session';

async function callAgent(handle: FrameworkHandle, text: string): Promise<string> {
  const agent = handle.getOrCreateAgent(CLI_USER_SLUG, true);
  let fullResponse = '';
  const unsubscribe = agent.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
      const delta = event.assistantMessageEvent.delta;
      fullResponse += delta;
      process.stdout.write(delta);
    }
  });
  try {
    await agent.prompt(text);
  } finally {
    unsubscribe();
  }
  process.stdout.write('\n');
  return fullResponse;
}

function printHelp(): void {
  const name = config.agent.name ?? 'Utarus';
  console.log(`
${name} — CLI

Slash commands (bypass the LLM for speed):
  /help                 Show this help
  /list                 List all users
  /get <slug>           Print the session announcement for a user
  /clear                Clear the current agent's conversation context
  /exit                 Quit

Free text is sent to the agent as-is.
`);
}

async function handleSlash(line: string): Promise<boolean> {
  const trimmed = line.trim();
  if (!trimmed.startsWith('/')) return false;

  const [cmd, ...rest] = trimmed.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim();

  switch (cmd) {
    case 'help':
      printHelp();
      return true;
    case 'exit':
    case 'quit':
      console.log('bye.');
      process.exit(0);
    case 'clear':
      clearAgentContext(CLI_USER_SLUG);
      console.log('✅ Context cleared.');
      return true;
    case 'list': {
      const slugs = listUserSlugs();
      if (slugs.length === 0) {
        console.log('No users yet. Ask the agent to create one, or send an invite code.');
        return true;
      }
      for (const slug of slugs) {
        try {
          const s = loadState(slug);
          console.log(`  ${slug} — ${s.profile.display_name} (created ${s.user.created_at})`);
        } catch (e) {
          console.log(`  ${slug} — ERROR: ${e instanceof Error ? e.message : e}`);
        }
      }
      return true;
    }
    case 'get': {
      if (!arg) {
        console.log('Usage: /get <slug>');
        return true;
      }
      try {
        const state = loadState(arg);
        const tgCount = state.user.telegram_user_ids?.length ?? 0;
        console.log(
          `User "${state.user.slug}" — ${state.profile.display_name}.\n` +
          `Created ${state.user.created_at}. Contact: ${state.profile.contact_email}.\n` +
          `${tgCount} Telegram account(s) linked.\n` +
          `${state.log.length} log entries.`
        );
      } catch (e) {
        console.log(`❌ ${e instanceof Error ? e.message : e}`);
      }
      return true;
    }
    default:
      console.log(`Unknown command: /${cmd}. Try /help.`);
      return true;
  }
}

export async function startCli(opts: CliOptions): Promise<void> {
  const { handle } = opts;
  const name = config.agent.name ?? 'Utarus';
  const rl = readline.createInterface({ input: stdin, output: stdout, prompt: `${name.toLowerCase()}> ` });

  console.log(`${name} running. Type /help for commands.\n`);
  printHelp();
  rl.prompt();

  rl.on('line', async (line: string) => {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      return;
    }
    rl.pause();
    try {
      const handled = await handleSlash(text);
      if (!handled) {
        await callAgent(handle, text);
      }
    } catch (err) {
      console.error('Error:', err instanceof Error ? err.message : err);
    }
    rl.resume();
    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\nbye.');
    process.exit(0);
  });
}
