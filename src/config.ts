import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname, isAbsolute } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenvConfig({ path: resolve(__dirname, '../.env') });

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
  dataRoot: process.env.UTARUS_DATA_ROOT ?? './data',
  agent: {
    name: process.env.UTARUS_AGENT_NAME,
    purpose: process.env.UTARUS_AGENT_PURPOSE,
  },
} as const;

export function resolveDataRoot(): string {
  const PROJECT_ROOT = resolve(__dirname, '../');
  return isAbsolute(config.dataRoot) ? config.dataRoot : resolve(PROJECT_ROOT, config.dataRoot);
}
