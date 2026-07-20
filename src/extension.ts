/**
 * DomainExtension — the contract a domain agent (Binary, Marie, …) implements
 * to plug into the Utarus framework.
 *
 * The framework owns: user state, invite/admin onboarding, CLI/Telegram/Slack
 * scaffolding, skill-tool, firecrawl, bindrive, write-report, usage tracking.
 *
 * The domain owns: its purpose paragraph, its extra tools, its extra skills,
 * and optional hooks for message enrichment + session announcements.
 */

import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { DomainBillingConfig } from './billing/types.js';
import type { ResolveLlmProfileContext } from './llm/types.js';

export type { DomainBillingConfig };
export type { ResolveLlmProfileContext };

export interface Skill {
  id: string;
  name: string;
  description: string;
  kind: 'knowledge';
  keywords: string[];
}

export interface LoadedSkill {
  id: string;
  name: string;
  content: string;
}

export interface EnrichMessageContext {
  /** The resolved user slug (empty string for unknown users during onboarding). */
  userSlug: string;
  telegramUserId?: number;
  slackUserId?: string;
  isAdmin: boolean;
  /** The raw inbound message text (invite codes may already be handled by the framework gate). */
  text: string;
  /**
   * Display name from the channel when available (Slack profile / Telegram first name).
   * Framework instant onboard uses this; domains may also use it.
   */
  channelDisplayName?: string;
}

/**
 * Domain WebUI customization — nav items, client routes, and session APIs.
 * Generic shell stays in Utarus; agent-specific pages use pageKind + domain APIs.
 */
export type DomainWebPageKind = 'notifications' | 'tasks' | 'iframe';

export interface DomainWebNavItem {
  id: string;
  label: string;
  /** Client path e.g. /notifications */
  path: string;
  /** Optional lucide-style icon key: bell | layout-dashboard | list | message-square */
  icon?: string;
  order?: number;
  adminOnly?: boolean;
  /** GET path returning { count: number } for nav badge */
  badgePath?: string;
}

export interface DomainWebRoute {
  path: string;
  /**
   * Built-in shell page kinds (generic UI + domain API contract).
   * - notifications: inbox list + mark read
   * - tasks: generic task/job list for the signed-in user
   * - iframe: embed iframeSrc
   */
  pageKind: DomainWebPageKind;
  /**
   * API base path under /api/domain/<agentKey>/… or absolute /api/…
   * notifications: list GET base, POST base/:id/read, GET base/unread-count
   * tasks: GET base → { items: TaskItem[] }
   */
  apiBase?: string;
  /** For pageKind iframe */
  iframeSrc?: string;
  title?: string;
}

export interface DomainWebUiExtension {
  /** URL namespace, e.g. "binary" → /api/domain/binary */
  agentKey: string;
  productName?: string;
  /** Default path after login (e.g. /notifications). Default "/" (chat). */
  defaultPath?: string;
  nav?: DomainWebNavItem[];
  routes?: DomainWebRoute[];
  apiRouters?: Array<{
    mountPath?: string;
    router: import('express').Router;
    auth?: 'user' | 'admin' | 'public';
  }>;
  /** Static files at /domain-assets/<agentKey>/ */
  staticDir?: string;
  /**
   * Domain-registered side-panel widget kinds (iframe-bundle under staticDir).
   * Platform always adds html-bundle. See docs/webui-chat-widgets-design.md.
   */
  widgets?: import('./widgets/registry.js').WidgetKindRegistration[];
}

export interface DomainExtension {
  /**
   * Paragraph(s) appended to the framework system prompt. This is where the
   * domain agent describes its purpose, scope, and domain-specific rules.
   */
  purpose: string;

  /**
   * Extra tools merged into every agent alongside the framework tools
   * (skill-tool, user-tools, invite-tools, firecrawl). Return a fresh array
   * per call if tool behaviour depends on the user slug or admin status.
   */
  tools: AgentTool[] | ((userSlug: string, isAdmin: boolean) => AgentTool[]);

  /** Extra skills merged into the skill catalog. */
  skills: Skill[];

  /**
   * Optional: domain-specific Telegram commands. Each entry registers a
   * `/name` command on the Telegram bot. `handler` receives the command args
   * (the text after `/name`) and the sender's telegram user ID; it returns
   * the reply text (Markdown allowed). Admin-only commands should check
   * `isAdmin` themselves. Telegram command names are limited to 32 chars and
   * must be lowercase alphanumeric + underscores.
   */
  telegramCommands?: Array<{
    name: string;
    description: string;
    adminOnly: boolean;
    handler: (ctx: { args: string; telegramUserId: number; isAdmin: boolean }) => Promise<string> | string;
  }>;

  /**
   * Optional: domain-specific Slack slash commands. Each entry registers
   * `/{name}` on the Slack bot (Socket Mode). `handler` receives the text
   * after the command (subcommand args) and the sender's Slack user ID.
   * Command names must be Slack-valid (not reserved names like /invite).
   * Also add the command in the Slack app manifest for the workspace.
   */
  slackCommands?: Array<{
    name: string;
    description: string;
    adminOnly: boolean;
    /** Shown in Slack slash UI as usage_hint (optional). */
    usageHint?: string;
    handler: (ctx: { args: string; slackUserId: string; isAdmin: boolean }) => Promise<string> | string;
  }>;

  /**
   * Optional: domain-specific slash commands for the WebUI chat composer.
   * When the user sends `/name args…` as a message, the framework matches
   * `name` (case-insensitive, no leading slash), runs `handler`, and returns
   * the reply text without calling the LLM — same pattern as Telegram/Slack.
   *
   * Framework-reserved names (handled client-side): `clear`, `help`.
   * Do not reuse those names. `adminOnly` is enforced on the server.
   */
  webCommands?: Array<{
    name: string;
    description: string;
    adminOnly: boolean;
    /** Shown in WebUI /help as usage hint (optional). */
    usageHint?: string;
    handler: (ctx: {
      args: string;
      userSlug: string;
      isAdmin: boolean;
      conversationId?: string | null;
    }) => Promise<string> | string;
  }>;

  /**
   * Optional: enrich the inbound message with domain context before it is
   * handed to the agent. Use this to prepend seller/campaign state, inject a
   * linked entity slug, or short-circuit fully (return empty string to skip
   * the agent and reply directly).
   *
   * Return the (possibly modified) text to send to the agent, or a string
   * starting with "REPLY:" to skip the agent and send the rest as the reply.
   */
  enrichMessage?: (ctx: EnrichMessageContext) => string | Promise<string>;

  /**
   * Optional: build the session-start announcement string for a domain entity.
   * Called when the user runs `/get <slug>` on a domain entity (seller,
   * campaign). Receives the loaded domain-state object.
   */
  buildSessionAnnouncement?: (state: unknown) => string;

  /**
   * Optional: resolve which domain-entity slug a user is acting as. Used by
   * the framework to inject context and to gate entity-scoped commands.
   * Returns null when the user has no linked entity (admin mode).
   */
  resolveEntitySlug?: (userSlug: string) => Promise<string | null>;

  /**
   * Optional: WebUI customization (nav, routes, domain APIs).
   * When omitted, SPA stays Chat + Admin only (backward compatible).
   */
  webUi?: DomainWebUiExtension;

  /**
   * Optional: billing / paywall configuration for this domain deployment.
   * Used when UTARUS_BILLING_ENABLED=true. Extension `plans` win entirely
   * over data/config/plans.yaml (no deep-merge). See docs/paywall-stripe-design.md.
   */
  billing?: DomainBillingConfig;

  /**
   * Optional: vote which LLM profile should handle this turn.
   * Called only when the turn has **no** images (framework never calls this
   * when hasImages is true — vision route is hard). Return a configured
   * profile name, or null/undefined to leave routing to heavy heuristics + default.
   * See docs/multi-llm-routing-design.md.
   */
  resolveLlmProfile?: (
    ctx: ResolveLlmProfileContext,
  ) => string | null | undefined | Promise<string | null | undefined>;
}
