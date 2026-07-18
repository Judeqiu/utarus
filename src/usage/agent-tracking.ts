/**
 * Agent event subscription — records LLM token usage and tool call counts
 * into the per-user usage file, and wraps tools with per-period cap checks.
 */

import type { Agent, AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import {
  getEffectiveCap,
  isBillingEnabled,
  formatPaywallMessage,
  billingStateErrorMessage,
} from '../billing/index.js';
import {
  recordLlm,
  recordToolCall,
  loadUsage,
} from './usage-file.js';

/**
 * Subscribe an agent to emit usage + tool-count events to the per-user
 * usage file. Admins bypass tracking overhead — but we still record so
 * operators can audit admin spend.
 */
export function attachUsageTracking(agent: Agent, userSlug: string): void {
  agent.subscribe((event: any) => {
    try {
      if (event.type === 'message_end' && event.message?.role === 'assistant' && event.message.usage) {
        const u = event.message.usage;
        recordLlm(userSlug, {
          input_tokens: u.input,
          output_tokens: u.output,
          cache_read: u.cacheRead,
          cache_write: u.cacheWrite,
          total_tokens: u.totalTokens,
          cost_usd: u.cost?.total,
        });
      } else if (event.type === 'tool_execution_end' && !event.isError && typeof event.toolName === 'string') {
        recordToolCall(userSlug, event.toolName);
      }
    } catch (err) {
      console.error('[Usage Tracking]', err instanceof Error ? err.message : String(err));
    }
  });
}

/**
 * Wrap a tool's execute() with a per-period cap check. Returns an error
 * ToolResult (without calling the tool) when the cap is already hit.
 *
 * Billing on: uses getEffectiveCap; fail-closed on state errors (no throw).
 * Billing off: same effective path (getCap); corrupt usage still throws
 * (legacy tool-path behavior).
 */
export function wrapToolWithCap(tool: AgentTool, userSlug: string): AgentTool {
  const original = tool.execute.bind(tool);
  return {
    ...tool,
    execute: async (id: string, params: unknown): Promise<AgentToolResult<unknown>> => {
      try {
        const cap = getEffectiveCap(userSlug, `tools.${tool.name}`);
        if (cap !== undefined) {
          const usage = loadUsage(userSlug);
          const current = usage.period_tools[tool.name] ?? 0;
          if (current >= cap) {
            const upgradeUrl = isBillingEnabled()
              ? undefined // tool path has no channel; message points at WebUI
              : undefined;
            const text = formatPaywallMessage({
              current,
              cap,
              upgradeUrl,
              channel: 'cli',
              toolName: tool.name,
            });
            return {
              content: [{ type: 'text', text }],
              details: { capHit: true, tool: tool.name, current, cap } as any,
            };
          }
        }
      } catch (err) {
        if (isBillingEnabled()) {
          return {
            content: [
              {
                type: 'text',
                text: `🚫 ${billingStateErrorMessage()}`,
              },
            ],
            details: { billingError: true, tool: tool.name } as any,
          };
        }
        throw err;
      }
      return original(id, params);
    },
  };
}

export function wrapToolsWithCaps(tools: AgentTool[], userSlug: string): AgentTool[] {
  return tools.map(t => wrapToolWithCap(t, userSlug));
}
