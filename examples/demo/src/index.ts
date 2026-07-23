/**
 * Demo agent entry — boots WebUI (+ optional Telegram/Slack) on Utarus.
 *
 * Run from examples/demo:
 *   cp .env.example .env   # fill keys
 *   npm install
 *   npm run dev
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync, writeFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const demoRoot = resolve(__dirname, '..');

// Host owns dotenv; tell Utarus not to load the framework package's .env
dotenvConfig({ path: resolve(demoRoot, '.env') });
process.env.UTARUS_LOADED_BY_HOST = '1';

// Always use an absolute data root under this demo package.
// resolveDataRoot() in utarus joins relative paths against the *package*
// root (not process.cwd), so "./data" would land in utarus/data — wrong.
{
  const raw = process.env.UTARUS_DATA_ROOT?.trim();
  if (!raw || raw === './data' || raw === 'data') {
    process.env.UTARUS_DATA_ROOT = resolve(demoRoot, 'data');
  } else if (!raw.startsWith('/')) {
    process.env.UTARUS_DATA_ROOT = resolve(demoRoot, raw);
  }
}

// Seed minimal data files if missing (fail-fast agent still needs them later)
function seedDataRoot(root: string): void {
  mkdirSync(resolve(root, 'users'), { recursive: true });
  mkdirSync(resolve(root, 'config'), { recursive: true });
  // KB dirs optional at boot — private/shared files are created on first write
  mkdirSync(resolve(root, 'kb', 'users'), { recursive: true });
  for (const f of ['invites.yaml', 'admin_codes.yaml', 'admin_ids.yaml', 'reporting.yaml']) {
    const p = resolve(root, f);
    if (!existsSync(p)) writeFileSync(p, '[]\n', 'utf-8');
  }
  // When billing is on, caps.yaml must not define default — seed overrides-only
  const caps = resolve(root, 'config', 'caps.yaml');
  if (!existsSync(caps)) {
    writeFileSync(
      caps,
      `# Per-slug admin overrides only (no default when billing is on)\noverrides: {}\n`,
      'utf-8',
    );
  }
}

seedDataRoot(process.env.UTARUS_DATA_ROOT);

// Fail fast on required identity before createFramework
if (!process.env.UTARUS_AGENT_NAME) {
  process.env.UTARUS_AGENT_NAME = 'Demo';
}
if (!process.env.UTARUS_AGENT_PURPOSE) {
  process.env.UTARUS_AGENT_PURPOSE =
    'Sample Utarus agent for Stripe paywall walkthrough (free → Pro).';
}

const { createFramework } = await import('utarus');
const { demoExtension } = await import('./extension.js');
const { ensureDemoUser, DEMO_USER } = await import('./seed-user.js');

await ensureDemoUser();

const framework = createFramework({ extension: demoExtension });

const webPort = process.env.WEBAPP_PORT
  ? parseInt(process.env.WEBAPP_PORT, 10)
  : 3010;
if (!Number.isFinite(webPort) || webPort <= 0) {
  throw new Error(`WEBAPP_PORT must be a positive integer, got "${process.env.WEBAPP_PORT}"`);
}

framework.startWebApp({ port: webPort });
console.log(`[Demo] WebUI + billing on http://localhost:${webPort}`);
console.log(`[Demo] login:  http://localhost:${webPort}/login`);
console.log(`[Demo] signup: http://localhost:${webPort}/signup`);
console.log(`[Demo] data root: ${process.env.UTARUS_DATA_ROOT}`);
console.log(
  `[Demo] billing: ${process.env.UTARUS_BILLING_ENABLED === 'true' ? 'ON' : 'off'}`,
);
console.log(
  `[Demo] open signup: ${process.env.UTARUS_OPEN_SIGNUP_ENABLED === 'true' ? 'ON' : 'off'}`,
);
console.log(
  `[Demo] login as normal user: ${DEMO_USER.slug} / ${DEMO_USER.password}`,
);
console.log(
  `[Demo] login as admin: keys from WEBAPP_ADMIN_CREDENTIALS (default admin / demo-admin-pass)`,
);

if (process.env.TELEGRAM_BOT_TOKEN) {
  void framework.startTelegram().catch((err) => {
    console.error('[Demo] Telegram failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

if (process.env.SLACK_BOT_TOKEN) {
  void framework.startSlack().catch((err) => {
    console.error('[Demo] Slack failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

// Optional CLI REPL when DEMO_CLI=1
if (process.env.DEMO_CLI === '1') {
  void framework.startCli();
}
