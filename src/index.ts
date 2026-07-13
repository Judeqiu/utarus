// ── Public API (imported by domain agents like Binary) ──────────────────
export { createFramework } from './framework.js';
export type { Framework, FrameworkOptions } from './framework.js';
export type { DomainExtension, EnrichMessageContext, Skill, LoadedSkill } from './extension.js';
export { config } from './config.js';
export type { AppConfig } from './config.js';
export { registerDomainSkill, allSkillIds, SKILLS } from './skills/index.js';
export { resolveDataRoot } from './config.js';
export { getCurrentChatId } from './interfaces/telegram.js';
/** Standard access gate + instant invite redeem (all domain agents). */
export { resolveInboundMessage } from './onboarding/access-gate.js';
export {
  redeemInviteInstantly,
  ensureChannelUser,
  fetchSlackDisplayName,
} from './onboarding/instant-invite.js';
export type { InstantRedeemParams, InstantRedeemResult } from './onboarding/instant-invite.js';
export {
  isDemoModeEnabled,
  getDemoModeState,
  setDemoMode,
  parseDemoModeArgs,
  formatDemoModeStatus,
} from './onboarding/demo-mode.js';
export type { DemoModeState } from './onboarding/demo-mode.js';
/** Shared Telegram formatting helpers (Markdown → HTML). Used by the built-in
 *  Telegram interface; domain agents can reuse them for custom outbound messages. */
export {
  escapeHtml,
  convertMarkdownTables,
  markdownToTelegramHtml,
  splitTelegramHtml,
} from './interfaces/telegram-format.js';
export { startBinDrive, createBinDriveApp } from './webapp/server.js';
export {
  createLinkToken,
  appendLinkToken,
  buildAuthedUrl,
  signedBinDriveViewUrl,
  publicBinDriveOrigin,
  createSession,
  resolveByToken,
  DEFAULT_LINK_TOKEN_TTL_MS,
  MAX_LINK_TOKEN_TTL_MS,
  MIN_LINK_TOKEN_TTL_MS,
} from './webapp/auth.js';
export type { AuthUser, CreateLinkTokenParams, LinkTokenResult } from './webapp/auth.js';
export type { UserIdentity, UserProfile, UserState, LogEntry, InviteCode, AdminOnboardCode } from './state/index.js';
export { loadUsage, getCap, attachUsageTracking } from './usage/index.js';
export { wantsHtmlDelivery, publishHtmlReport } from './report/html-delivery.js';
export type { PublishHtmlReportParams, PublishHtmlReportResult } from './report/html-delivery.js';
export { createPostHtmlReportTool } from './tools/post-html-report.js';

// ── Standalone entry (running Utarus by itself) ────────────────────────
import { config } from './config.js';

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

  // Start Telegram if configured
  if (!config.telegram.botToken) {
    console.log('TELEGRAM_BOT_TOKEN not set — Telegram interface disabled.');
  } else {
    const { startTelegram } = await import('./interfaces/telegram.js');
    startTelegram({ handle: await defaultFramework() }).catch((err) => {
      console.error('[Telegram] Failed to start:', err instanceof Error ? err.message : err);
    });
  }

  // Start Slack if configured
  if (!config.slack.botToken || !config.slack.appToken || !config.slack.signingSecret) {
    console.log('Slack tokens not set — Slack interface disabled.');
  } else {
    const { startSlack } = await import('./interfaces/slack/index.js');
    startSlack({ handle: await defaultFramework() }).catch((err) => {
      console.error('[Slack] Failed to start:', err instanceof Error ? err.message : err);
    });
  }

  if (process.env.TELEGRAM_ONLY === 'true' || process.env.SLACK_ONLY === 'true') {
    console.log('Background mode — CLI disabled. Bot is running.');
    return;
  }

  const { startCli } = await import('./interfaces/cli.js');
  await startCli({ handle: await defaultFramework() });
}

/**
 * Default no-op extension so Utarus runs standalone without a domain agent.
 * Domain agents supply their own via createFramework().
 */
async function defaultFramework() {
  const { createFramework } = await import('./framework.js');
  return createFramework({
    extension: {
      purpose: config.agent.purpose ?? 'Help the user with their task.',
      tools: [],
      skills: [],
    },
  });
}

// Only run standalone when invoked directly (not when imported by a domain
// agent). We demand an exact argv[1] match to avoid firing when a different
// project happens to have an src/index.ts.
function argvIsUtarusMain(): boolean {
  if (!process.argv[1]) return false;
  const a = process.argv[1];
  return a.endsWith('/utarus/src/index.ts')
    || a.endsWith('/utarus/dist/index.js')
    || a === 'src/index.ts'
    || a === 'dist/index.js';
}
if (argvIsUtarusMain()) {
  main().catch((error) => {
    console.error(`[FATAL] Failed to start ${config.agent.name ?? 'Utarus'}:`, error);
    process.exit(1);
  });
}
