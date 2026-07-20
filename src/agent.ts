/**
 * Utarus agent factory — owns the per-key agent cache and the Agent
 * construction. System prompt and tool list are injected by the framework
 * (so they can incorporate domain skills + domain tools); this file only
 * manages cache lifecycle and model wiring.
 */

import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import { streamSimple } from '@earendil-works/pi-ai';
import { getAgentModel, agentGetApiKey } from './llm/index.js';
import { getLlmStreamRetryOptions } from './llm/retry.js';
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
  /** Builder that returns the full tool list for this userSlug/isAdmin. */
  tools: (userSlug: string, isAdmin: boolean) => AgentTool[];
  /** When false (default), tools are not wrapped with usage caps. Set via opts for callers that caps. */
  enforceCaps?: boolean;
}

/**
 * Resolve or create the per-cacheKey agent.
 *
 * The cache key and the user slug are split so a single user can hold
 * isolated conversation contexts per channel (web vs Slack/Telegram) while
 * tools and usage caps remain keyed off the stable user slug.
 *
 * @param cacheKey   stable Map key isolating the in-memory conversation.
 *                   For Slack/Telegram/CLI this equals `userSlug`; for the
 *                   web channel the framework passes `web:<userSlug>`.
 * @param userSlug   the user's slug — passed to the tools builder and to
 *                   usage tracking so portfolio/YAML state and caps stay
 *                   per-user across channels.
 * @param isAdmin    whether the user is an admin (gates admin-only tools
 *                   and, in future, usage-cap bypass).
 * @param opts       injected system prompt + tool builder from the framework.
 */
export function getOrCreateAgent(
  cacheKey: string,
  userSlug: string,
  isAdmin: boolean,
  opts: GetOrCreateAgentOptions,
): Agent {
  evictStaleAgents();

  const existing = userAgents.get(cacheKey);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.agent;
  }

  // Seed with the default profile; resolveAndApplyLlmForTurn mutates
  // agent.state.model per turn. getApiKey multi-dispatches by pi-ai provider
  // (and prefers the active ALS route key) — must never throw.
  const model = getAgentModel();
  let tools = opts.tools(userSlug, isAdmin);
  if (opts.enforceCaps) {
    tools = wrapToolsWithCaps(tools, userSlug);
  }

  // pi-ai defaults maxRetries to 0; wrap streamSimple so 429/overload
  // retries keep multi-step tool runs alive (see src/llm/retry.ts).
  const retryOpts = getLlmStreamRetryOptions();
  console.log(
    `[llm/retry] agent cacheKey=${cacheKey} maxRetries=${retryOpts.maxRetries}` +
      (retryOpts.maxRetryDelayMs !== undefined
        ? ` maxRetryDelayMs=${retryOpts.maxRetryDelayMs}`
        : ''),
  );

  const agent = new Agent({
    initialState: {
      systemPrompt: opts.systemPrompt,
      model,
      tools,
    },
    getApiKey: (provider: string) => agentGetApiKey(provider),
    maxRetryDelayMs: retryOpts.maxRetryDelayMs,
    streamFn: (m, context, options) =>
      streamSimple(m, context, {
        ...options,
        ...getLlmStreamRetryOptions(),
      }),
  });

  // Subscribe usage + tool tracking. Admins bypass but we still record spend.
  attachUsageTracking(agent, userSlug);

  userAgents.set(cacheKey, { agent, lastUsed: Date.now() });
  return agent;
}

export function clearAgentContext(cacheKey: string): boolean {
  return userAgents.delete(cacheKey);
}

/** Visible for diagnostics / tests. */
export function agentCacheSize(): number {
  return userAgents.size;
}
