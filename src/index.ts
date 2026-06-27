import { config } from './config.js';
import { startCli } from './interfaces/cli.js';
import { startTelegram } from './interfaces/telegram.js';

process.on('uncaughtException', (error) => {
  console.error('[FATAL] Uncaught Exception:', error.message);
  console.error(error.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled Rejection:', reason);
});

/**
 * Fail-fast validation. Required env vars must be set — the framework does
 * not silently run with a half-configured agent.
 */
function validateConfig(): void {
  const missing: string[] = [];
  if (!config.deepseek.apiKey) missing.push('DEEPSEEK_API_KEY');
  if (!config.agent.name) missing.push('UTARUS_AGENT_NAME');
  if (!config.agent.purpose) missing.push('UTARUS_AGENT_PURPOSE');
  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    console.error('Copy .env.example to .env and fill in the values.');
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const name = config.agent.name!;
  console.log(`${name} starting...`);

  validateConfig();

  console.log('Initializing DeepSeek model...');
  const { getDeepSeekModel } = await import('./llm/index.js');
  const model = getDeepSeekModel();
  console.log(`DeepSeek model: ${model.id}`);

  if (!config.telegram.botToken) {
    console.log('TELEGRAM_BOT_TOKEN not set — running in CLI-only mode.');
  } else {
    startTelegram().catch((err) => {
      console.error('[Telegram] Failed to start:', err instanceof Error ? err.message : err);
      console.error('Continuing in CLI-only mode.');
    });
  }

  if (process.env.TELEGRAM_ONLY === 'true') {
    console.log('TELEGRAM_ONLY mode — CLI disabled. Bot is running in background.');
    return;
  }

  await startCli();
}

main().catch((error) => {
  console.error(`[FATAL] Failed to start ${config.agent.name ?? 'Utarus'}:`, error);
  process.exit(1);
});
