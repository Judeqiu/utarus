/**
 * Utarus agent factory — owns the per-key agent cache and the Agent
 * construction. System prompt and tool list are injected by the framework
 * (so they can incorporate domain skills + domain tools); this file only
 * manages cache lifecycle and model wiring.
 */

import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import { getDeepSeekModel } from './llm/index.js';
import { attachUsageTracking, wrapToolsWithCaps } from './usage/agent-tracking.js';

const MAX_AGENTS = 100;
const AGENT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface AgentEntry {
  agent: Agent;
  lastUsed: number;
}

const userAgents = new Map<string, AgentEntry>();

function evictStaleAgents() {
  const now = Date.now();
  for (const [key, entry] of userAgents) {
    if (now - entry.lastUsed > AGENT_TTL_MS) {
      userAgents.delete(key);
    }
  }
  if (userAgents.size > MAX_AGENTS) {
    const sorted = [...userAgents.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const toRemove = sorted.slice(0, userAgents.size - MAX_AGENTS);
    for (const [key] of toRemove) {
      userAgents.delete(key);
    }
  }
}

export interface GetOrCreateAgentOptions {
  /** Full, ready-to-use system prompt (framework scaffolding + domain purpose + skill catalog). */
  systemPrompt: string;
  /** Builder that returns the full tool list for this key/isAdmin. */
  tools: (key: string, isAdmin: boolean) => AgentTool[];
  /** When false (default), tools are not wrapped with usage caps. Set via opts for callers that caps. */
  enforceCaps?: boolean;
}

/**
 * Resolve or create the per-key agent.
 *
 * @param key      stable cache key — user.slug for known users, or a
 *                 channel-prefixed id (`tg:<telegramId>`, `slack:<slackId>`)
 *                 for admins still in bootstrap mode without a user record.
 * @param isAdmin  whether the key maps to an admin (gates admin-only tools
 *                 and, in future, usage-cap bypass).
 * @param opts     injected system prompt + tool builder from the framework.
 */
export function getOrCreateAgent(
  key: string,
  isAdmin: boolean,
  opts: GetOrCreateAgentOptions,
): Agent {
  evictStaleAgents();

  const existing = userAgents.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.agent;
  }

  const model = getDeepSeekModel();
  let tools = opts.tools(key, isAdmin);
  if (opts.enforceCaps) {
    tools = wrapToolsWithCaps(tools, key);
  }

  const agent = new Agent({
    initialState: {
      systemPrompt: opts.systemPrompt,
      model,
      tools,
    },
  });

  // Subscribe usage + tool tracking. Admins bypass but we still record spend.
  attachUsageTracking(agent, key);

  userAgents.set(key, { agent, lastUsed: Date.now() });
  return agent;
}

export function clearAgentContext(key: string): boolean {
  return userAgents.delete(key);
}

/** Visible for diagnostics / tests. */
export function agentCacheSize(): number {
  return userAgents.size;
}
