/**
 * Utarus framework entry — composes a DomainExtension with the shared
 * infrastructure (user state, onboarding, interfaces, skill-tool, firecrawl,
 * bindrive, write-report, usage tracking) and returns a Framework handle the
 * domain agent uses to boot interfaces and obtain agents per user slug.
 */

import type { Agent } from '@earendil-works/pi-agent-core';
import { config } from './config.js';
import { SKILLS as frameworkSkills } from './skills/index.js';
import { createSkillTool } from './tools/skill-tool.js';
import { createUserStateTools } from './tools/user-state.js';
import { createInviteTools } from './tools/invite.js';
import { createFirecrawlTool } from './tools/firecrawl.js';
import { createWriteReportTool } from './tools/write-report.js';
import { createBinDriveTools } from './tools/bindrive.js';
import { getOrCreateAgent as baseGetOrCreateAgent, clearAgentContext as baseClearAgentContext } from './agent.js';
import { startTelegram } from './interfaces/telegram.js';
import { startSlack } from './interfaces/slack/index.js';
import { startCli } from './interfaces/cli.js';
import type { DomainExtension, Skill } from './extension.js';

export interface FrameworkOptions {
  extension: DomainExtension;
}

export interface Framework {
  /** Resolve or create the per-slug agent (prompt already composed). */
  getOrCreateAgent: (userSlug: string, isAdmin: boolean) => Agent;
  /** Drop the cached agent for a user (e.g. /clear). */
  clearAgentContext: (userSlug: string) => boolean;
  /** The combined skill catalog (framework + domain skills). */
  readonly allSkills: Skill[];
  /** The registered domain extension (purpose, hooks, extra skills/tools). */
  readonly extension: DomainExtension;
  /** Boot the Telegram interface. */
  startTelegram: () => Promise<void>;
  /** Boot the Slack interface. */
  startSlack: () => Promise<void>;
  /** Boot the REPL CLI. */
  startCli: () => Promise<void>;
}

/**
 * Minimal handle passed to the interfaces. They only need the agent factory,
 * extension hooks, and the skill catalog — not the bootstrap functions
 * (which would cause a circular call).
 */
export type FrameworkHandle = Pick<Framework, 'getOrCreateAgent' | 'allSkills' | 'extension'>;

/**
 * Compose the system prompt. The framework supplies the scaffolding
 * (identity, user-state protocol, invite flow, formatting rules, hard rules);
 * the domain supplies the purpose paragraph and any domain-specific sections.
 */
function buildSystemPrompt(ext: DomainExtension, allSkills: Skill[]): string {
  const name = config.agent.name;
  const skillCatalog = allSkills.map(s => `  - ${s.id}: ${s.description}`).join('\n');

  return `You are ${name}, an agent built on the Utarus framework.

You are powered by DeepSeek V4 Pro. Never say you are Claude, GPT, or any other model. If asked what model you are, say "DeepSeek V4 Pro".

## Framework skills

${ext.purpose}

## Skill Framework

You have access to a SKILL FRAMEWORK. Skills are specialist knowledge documents you load on demand. Before any decision the skill covers, call use_skill to load it. Each skill stays loaded in your context for the rest of the conversation — load each one only once.

Available skills:
${skillCatalog}

## User state

Every user has a YAML state file at data/users/<slug>.yaml. State on disk is the source of truth — re-read with get_user before any mutation. The framework reserves user.{id,slug,created_at,telegram_user_ids,slack_user_ids,auth_token}, profile.{display_name,contact_email}, and log[]. Everything else is owned by domain extensions.

**At the start of any session that touches a user:**
1. Load \`getting-started\` skill FIRST.
2. Call \`list_users\` (if you don't know the slug) or \`get_user({ slug })\`.
3. Print the returned \`announcement\` verbatim.
4. Only after announcing state, decide which action to take.

## Invite + admin onboarding

- **Admin** issues codes via \`issue_invite_code\` / \`issue_admin_onboard_code\`.
- **Recipient** sends the code in chat. Run the flow:
  - \`INV-\` codes → Q&A for display_name + contact_email, then \`redeem_invite_code\`.
  - \`ADM-\` codes → call \`redeem_admin_onboard_code\` immediately.
- Codes are single-use. Validation refuses already-used codes.

## Telegram context

The message context ALWAYS includes the sender's Telegram user ID. Never ask users for it — pass it directly to tools.

## Slack context

The message context ALWAYS includes the sender's Slack user ID. Never ask users for it — pass it directly to tools.

## Hard rules

- No fallback. Surface tool errors verbatim. Fix the state, do not retry with different parameters hoping the error goes away.
- No inventing data. If a field isn't in the state file, ask the user for it.
- Every state mutation (init, profile update, telegram link, invite redemption) lands in \`log[]\` automatically. Do not log manually.
- Stay in scope. Off-scope requests get one sentence declining and one sentence redirecting.

## Telegram formatting

Your output is displayed in Telegram. Follow these rules:

**NEVER use markdown tables** — they render as garbage. Use structured text instead.

For lists, use bullet points:
• \`acme\` — Display Name (created 2026-06-27)

For key-value info:
*Name:* Acme Trading
*Email:* ops@acme.sg

Always put a blank line between sections. Keep messages under 3000 chars.

## Slack formatting

Your output is displayed in Slack. Follow these rules:

**NEVER use markdown tables** — they render as garbage. Use structured text instead.

For lists, use bullet points:
• \`acme\` — Display Name (created 2026-06-27)

For key-value info:
*Name:* Acme Trading
*Email:* ops@acme.sg

Always put a blank line between sections. Keep messages under 3000 chars.`;
}

export function createFramework(opts: FrameworkOptions): Framework {
  const { extension } = opts;
  const allSkills = [...frameworkSkills, ...extension.skills];

  const systemPrompt = buildSystemPrompt(extension, allSkills);

  // Compose the full tool list: framework + domain.
  function allTools(userSlug: string, isAdmin: boolean) {
    const framework = [
      createSkillTool(allSkills),
      createFirecrawlTool(),
      createWriteReportTool(),
      ...createUserStateTools(),
      ...createInviteTools(),
      ...createBinDriveTools(),
    ];
    const domain = typeof extension.tools === 'function'
      ? extension.tools(userSlug, isAdmin)
      : extension.tools;
    return [...framework, ...domain];
  }

  const getOrCreateAgent = (userSlug: string, isAdmin: boolean) =>
    baseGetOrCreateAgent(userSlug, isAdmin, { systemPrompt, tools: allTools, enforceCaps: !isAdmin });

  return {
    getOrCreateAgent,
    clearAgentContext: baseClearAgentContext,
    allSkills,
    extension,
    startTelegram: () => startTelegram({ handle: { getOrCreateAgent, allSkills, extension } }),
    startSlack: () => startSlack({ handle: { getOrCreateAgent, allSkills, extension } }),
    startCli: () => startCli({ handle: { getOrCreateAgent, allSkills, extension } }),
  };
}
