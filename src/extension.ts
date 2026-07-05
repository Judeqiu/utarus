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
  /** The raw inbound message text. */
  text: string;
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
}
