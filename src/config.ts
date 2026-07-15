import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname, isAbsolute } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// NOTE: only auto-load .env when running standalone. A domain agent (Binary)
// supplies its own config via createFramework and must NOT have Utarus clobber
// its env with a .env that lives next to the Utarus source.
if (!process.env.UTARUS_LOADED_BY_HOST) {
  dotenvConfig({ path: resolve(__dirname, '../.env') });
}

/**
 * Pure config — values come straight from process.env. No defaults, no fallbacks.
 * Required vars are validated in index.ts::validateConfig() at startup; if a
 * value is `undefined` here, the caller has not set it.
 */
export const config = {
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY,
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    adminIds: process.env.TELEGRAM_ADMIN_IDS
      ? process.env.TELEGRAM_ADMIN_IDS.split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id))
      : [],
  },
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
  },
  webapp: {
    port: parseInt(process.env.WEBAPP_PORT || '3000', 10),
    sessionSecret: process.env.SESSION_SECRET || 'utarus-dev-secret-change-in-prod',
    // Multiple admin credentials: JSON object of { username: password }.
    // Falls back to single WEBAPP_ADMIN_USERNAME/WEBAPP_ADMIN_PASSWORD.
    adminCredentials: ((): Record<string, string> => {
      const multi = process.env.WEBAPP_ADMIN_CREDENTIALS;
      if (multi) {
        try { return JSON.parse(multi) as Record<string, string>; }
        catch { /* fall through */ }
      }
      const user = process.env.WEBAPP_ADMIN_USERNAME || 'admin';
      const pass = process.env.WEBAPP_ADMIN_PASSWORD || '';
      return { [user]: pass };
    })(),
  },
  dataRoot: process.env.UTARUS_DATA_ROOT ?? './data',
  reportsUrl: process.env.UTARUS_REPORTS_URL || '',
  agent: {
    name: process.env.UTARUS_AGENT_NAME,
    purpose: process.env.UTARUS_AGENT_PURPOSE,
  },
  // Invite code prefixes — kept here so domain agents that share the framework
  // get consistent behaviour without re-coding.
  invites: {
    prefix: 'INV-',
    adminPrefix: 'ADM-',
  },
} as const;

export type AppConfig = typeof config;

export function resolveDataRoot(): string {
  // Re-read env so tests can set UTARUS_DATA_ROOT per suite without re-importing config.
  const raw = process.env.UTARUS_DATA_ROOT ?? config.dataRoot;
  const PROJECT_ROOT = resolve(__dirname, '../');
  return isAbsolute(raw) ? raw : resolve(PROJECT_ROOT, raw);
}
