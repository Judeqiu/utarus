/**
 * Agent event subscription — records LLM token usage and tool call counts
 * into the per-user usage file. Ported from Marie's llm/agent.ts
 * (attachUsageTracking / wrapToolWithCap).
 */

import type { Agent, AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import {
  recordLlm,
  recordToolCall,
  loadUsage,
  type UsageState,
} from './usage-file.js';
import { getCap } from './caps.js';

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
 */
export function wrapToolWithCap(tool: AgentTool, userSlug: string): AgentTool {
  const original = tool.execute.bind(tool);
  return {
    ...tool,
    execute: async (id: string, params: unknown): Promise<AgentToolResult<unknown>> => {
      const cap = getCap(userSlug, `tools.${tool.name}`);
      if (cap !== undefined) {
        const usage = loadUsage(userSlug);
        const current = usage.period_tools[tool.name] ?? 0;
        if (current >= cap) {
          return {
            content: [{ type: 'text', text: `🚫 Monthly cap reached for \`${tool.name}\` (${current}/${cap}). Contact an admin to raise it.` }],
            details: { capHit: true, tool: tool.name, current, cap } as any,
          };
        }
      }
      return original(id, params);
    },
  };
}

export function wrapToolsWithCaps(tools: AgentTool[], userSlug: string): AgentTool[] {
  return tools.map(t => wrapToolWithCap(t, userSlug));
}

export { loadUsage };
export type { UsageState };
