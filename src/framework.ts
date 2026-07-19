/**
 * Utarus framework entry — composes a DomainExtension with the shared
 * infrastructure (user state, onboarding, interfaces, skill-tool, firecrawl,
 * bindrive, write-report, user reporting, usage tracking) and returns a Framework handle the
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
import { createPostHtmlReportTool } from './tools/post-html-report.js';
import { createBinDriveTools } from './tools/bindrive.js';
import { createReportingTools } from './tools/reporting.js';
import { createShowMapTool } from './tools/show-map.js';
import { createReadImageTool } from './tools/read-image.js';
import { getOrCreateAgent as baseGetOrCreateAgent, clearAgentContext as baseClearAgentContext } from './agent.js';
import { getAgentLLM } from './llm/index.js';
import { startTelegram } from './interfaces/telegram.js';
import { startSlack } from './interfaces/slack/index.js';
import { startCli } from './interfaces/cli.js';
import {
  buildWebApp as buildWebAppImpl,
  startWebApp as startWebAppImpl,
  type BuildWebAppOptions,
  type StartWebAppOptions,
} from './webapp/server.js';
import type { Express } from 'express';
import type { DomainExtension, Skill } from './extension.js';
import { assertBillingConfig, isBillingEnabled, setBillingExtension } from './billing/index.js';

export interface FrameworkOptions {
  extension: DomainExtension;
}

export type AgentChannelScope = 'web';

/**
 * Build the agent pool cache key.
 * - Slack/Telegram/CLI: bare `userSlug` (shared conversation).
 * - Web without conversation: `web:<userSlug>`.
 * - Web with conversation: `web:<userSlug>:<conversationId>` (Claude-style multi-chat).
 */
export function agentCacheKey(
  userSlug: string,
  channelScope?: AgentChannelScope,
  conversationId?: string,
): string {
  if (!channelScope) return userSlug;
  if (conversationId) return `${channelScope}:${userSlug}:${conversationId}`;
  return `${channelScope}:${userSlug}`;
}

export interface Framework {
  /**
   * Resolve or create the per-user agent (prompt already composed).
   *
   * @param userSlug        the user's slug — used for tool resolution and usage caps.
   * @param isAdmin         whether the user is an admin.
   * @param channelScope    when set ('web'), isolates from Slack/Telegram.
   * @param conversationId  WebUI multi-chat: further isolates per conversation.
   */
  getOrCreateAgent: (
    userSlug: string,
    isAdmin: boolean,
    channelScope?: AgentChannelScope,
    conversationId?: string,
  ) => Agent;
  /**
   * Drop the cached agent for a user (e.g. /clear).
   * Args must match the values used at getOrCreateAgent time.
   */
  clearAgentContext: (
    userSlug: string,
    channelScope?: AgentChannelScope,
    conversationId?: string,
  ) => boolean;
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
  /**
   * Boot the WebUI (chat SPA + BinDrive + admin REST) on WEBAPP_PORT / opts.port.
   * Domain agents may pass extraRouters for vertical-specific HTTP (e.g. landing register).
   */
  startWebApp: (opts?: StartWebAppOptions) => Express;
  /**
   * Build the WebUI express app without listening (tests / custom host).
   */
  buildWebApp: (opts?: BuildWebAppOptions) => Express;
}

export type { BuildWebAppOptions, StartWebAppOptions };

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

  // Resolve after host dotenv; fail-fast if LLM is misconfigured (same as agent boot).
  const llm = getAgentLLM();
  const modelLabel = llm.model.name || llm.model.id;
  const visionOn = llm.capabilities.imageInput;

  const visionSection = visionOn
    ? `## Vision (images)

This model **can** read images (user photo uploads in WebUI, and images loaded via \`read_image\`).

- User-attached photos arrive as vision input on that turn — describe what you see; do **not** claim you cannot read images.
- For **image URLs** from firecrawl / listing pages (site plans, floor plans, floorplate PNGs): call \`read_image\` with the direct image URL. The tool attaches the pixels; then answer from what you see.
- Do **not** invent compass bearings, labels, or dimensions that are not visible after \`read_image\` (or on an attached photo). If the image is missing a north arrow, say so.
- Never say "I cannot read images" when vision is available — fetch with \`read_image\` first if you only have a URL.`
    : `## Vision (images)

This model is **text-only** (no image input). If the user attaches a photo or you only have an image URL, say briefly that vision is not enabled on this deployment and continue with text sources. Do not invent details from images you cannot see.`;

  return `You are ${name}, an agent built on the Utarus framework.

You are powered by **${modelLabel}**. Never say you are Claude, GPT, or any other model unless that is the configured model. If asked what model you are, say "${modelLabel}".

## Voice

Speak like a capable human colleague: warm, clear, and professional. Prefer plain language over jargon. No corporate filler, no sycophancy ("Great question!"), no robotic option menus. Be concise but not curt.

## Domain purpose

${ext.purpose}

${visionSection}

## Skill Framework

You have access to a SKILL FRAMEWORK. Skills are specialist knowledge documents you load on demand. Before any decision the skill covers, call use_skill to load it. Each skill stays loaded in your context for the rest of the conversation — load each one only once.

Available skills:
${skillCatalog}

## User state

Every user has a YAML state file at data/users/<slug>.yaml. State on disk is the source of truth — re-read with get_user before any mutation. The framework reserves user.{id,slug,created_at,telegram_user_ids,slack_user_ids,auth_token,password_hash,beta}, profile.{display_name,contact_email}, and log[]. Everything else is owned by domain extensions. user.beta=true means grandfathered beta (unlimited caps when billing is on).

**At the start of any session that touches a user:**
1. Load \`getting-started\` skill FIRST when you need framework conventions.
2. Call \`get_user({ slug })\` when you need their record (slug is usually already in the message context).
3. Prefer helping with their request over announcing machinery.

## Access + invite onboarding (framework-owned)

- Access control and invite redeem are handled by the framework **before** your turn when possible.
- **INV-** codes: redeemed instantly using the person's Slack/Telegram display name. No display-name or email Q&A. Profile is ready — serve their request immediately.
- **Demo mode** (admin toggles via \`/demomode on|off\`): when on, anyone may chat; missing profiles are auto-created from channel display name (same as invite). When off, invite required.
- **ADM-** codes: call \`redeem_admin_onboard_code\` with the code and channel user id from context, then confirm they are an admin.
- Admins may still issue codes via tools or slash commands. Codes are single-use.
- **Never** ask profile/setup questions (name, email, "do you have an account?", process menus). Channel IDs and profile come from context/tools.
- You **may** ask at most one short clarifying question when the *research query itself* is incomplete (e.g. no ticker named).

## Telegram context

The message context ALWAYS includes the sender's Telegram user ID. Never ask users for it — pass it directly to tools.

## Slack context

The message context ALWAYS includes the sender's Slack user ID. Never ask users for it — pass it directly to tools.

## Hard rules

- No fallback. Surface tool errors clearly in plain language. Fix the state; do not retry with random parameters.
- No inventing data. If a field isn't available from tools or state, say so honestly.
- Every state mutation (init, profile update, telegram link, invite redemption) lands in \`log[]\` automatically. Do not log manually.
- Stay in scope. Off-scope requests: one short decline, one helpful redirect.

## Telegram formatting

Your output is displayed in Telegram. Follow these rules:

**NEVER paste \`\`\`map fences** — use only the map link from \`show_map\` (fences render as ugly code blocks).

**NEVER use markdown tables** — they render as garbage. Use structured text instead.

For lists, use bullet points:
• \`acme\` — Display Name (created 2026-06-27)

For key-value info:
*Name:* Acme Trading
*Email:* ops@acme.sg

Always put a blank line between sections. Keep messages under 3000 chars.

## Slack formatting

Your output is displayed in Slack. Follow these rules:

**NEVER paste \`\`\`map fences** — use only the map link from \`show_map\` (fences render as code blocks).

**NEVER use markdown tables** — they render as garbage. Use structured text instead.

For lists, use bullet points:
• \`acme\` — Display Name (created 2026-06-27)

For key-value info:
*Name:* Acme Trading
*Email:* ops@acme.sg

Always put a blank line between sections. Keep messages under 3000 chars.

## Web channel formatting

When the user message is prefixed with \`[Channel: web …]\`, you are speaking in the browser WebUI. Full GitHub-flavored markdown is welcome: tables, fenced code, headings, and standard markdown links/images for BinDrive asset URLs returned by your tools. Prefer readable structure over flat bullets.

Currency amounts use a single dollar sign (\`$1.2M\`) — do not wrap prose in \`$…$\` math delimiters. Use \`$$…$$\` only for real equations.

When \`show_map\` succeeds, always include the map link and paste the WEB ONLY \`\`\`map fence once in your final answer so the WebUI can render an interactive map. **Do not invent** \`\`\`map fences — always call \`show_map\`.

## User reporting (framework-owned)

Users can file reports for admin review (bugs, abuse, product feedback, anything they want operators to see).

When the user says **report**, wants to **file a report**, or clearly wants feedback escalated to admins:
1. Call \`submit_report\` with their report text (verbatim or lightly cleaned). Optionally set \`category\` (\`feedback\` | \`bug\` | \`abuse\` | \`other\`).
2. Confirm it was saved. Do not invent response SLAs.
3. If their message is only "report" with no substance, ask once what they want admins to know — then call \`submit_report\`.

Admins list reports with \`list_reports\` (or WebUI Admin → Reports / \`data/reporting.yaml\`).

This is **not** the same as HTML intelligence dashboards (\`write_report\` / \`post_html_report\`).

## HTML reports (generic)

When the user **explicitly asks for HTML**, an HTML report/page, or a full report as a file/link:
1. Prefer calling \`post_html_report\` with a clear title and structured markdown (or raw HTML) and the user's slug as \`owner_slug\`.
2. Paste the returned **view URL** verbatim in your reply (opens in the browser and renders on mobile).
3. Even without the tool, if they asked for HTML the platform may package your final answer as an HTML page and post the link — still write a complete, well-structured answer.

Do **not** dump raw HTML tags into Slack chat. Do not rely on Slack file previews for HTML (they show source on phones).`;
}

export function createFramework(opts: FrameworkOptions): Framework {
  const { extension } = opts;

  // Billing: register domain plans/copy and fail-fast when flag is on.
  // Domain hosts (Binary/Marie/Invage) call createFramework and never hit
  // standalone index.ts validateConfig — validation must live here.
  setBillingExtension(extension.billing);
  if (isBillingEnabled()) {
    assertBillingConfig(extension);
  }

  const allSkills = [...frameworkSkills, ...extension.skills];

  const systemPrompt = buildSystemPrompt(extension, allSkills);

  // Compose the full tool list: framework + domain.
  function allTools(userSlug: string, isAdmin: boolean) {
    const framework = [
      createSkillTool(allSkills),
      createFirecrawlTool(),
      createWriteReportTool(),
      createPostHtmlReportTool(),
      ...createUserStateTools(),
      ...createInviteTools(),
      ...createBinDriveTools(),
      ...createReportingTools(userSlug, isAdmin),
      createShowMapTool(),
      createReadImageTool(),
    ];
    const domain = typeof extension.tools === 'function'
      ? extension.tools(userSlug, isAdmin)
      : extension.tools;
    return [...framework, ...domain];
  }

  const getOrCreateAgent = (
    userSlug: string,
    isAdmin: boolean,
    channelScope?: AgentChannelScope,
    conversationId?: string,
  ) => {
    const cacheKey = agentCacheKey(userSlug, channelScope, conversationId);
    return baseGetOrCreateAgent(cacheKey, userSlug, isAdmin, {
      systemPrompt,
      tools: allTools,
      enforceCaps: !isAdmin,
    });
  };

  const clearAgentContext = (
    userSlug: string,
    channelScope?: AgentChannelScope,
    conversationId?: string,
  ) => {
    const cacheKey = agentCacheKey(userSlug, channelScope, conversationId);
    return baseClearAgentContext(cacheKey);
  };

  const framework: Framework = {
    getOrCreateAgent,
    clearAgentContext,
    allSkills,
    extension,
    startTelegram: () => startTelegram({ handle: { getOrCreateAgent, allSkills, extension } }),
    startSlack: () => startSlack({ handle: { getOrCreateAgent, allSkills, extension } }),
    startCli: () => startCli({ handle: { getOrCreateAgent, allSkills, extension } }),
    startWebApp: (opts) => startWebAppImpl(framework, opts),
    buildWebApp: (opts) => buildWebAppImpl(framework, opts),
  };
  return framework;
}