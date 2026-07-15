/**
 * Hydrate a pi-agent-core Agent's message list from stored WebUI turns so
 * multi-turn context survives page refresh and conversation switches.
 */

import type { Agent } from '@earendil-works/pi-agent-core';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { getDeepSeekModel } from '../../llm/index.js';
import type { StoredChatMessage } from './conversation-types.js';

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Convert stored chat turns into AgentMessages and assign to agent.state.messages.
 * Overwrites any existing transcript for this agent instance.
 */
export function hydrateAgentFromStoredMessages(
  agent: Agent,
  messages: StoredChatMessage[],
): void {
  const model = getDeepSeekModel();
  const out: AgentMessage[] = [];

  for (const m of messages) {
    const ts = Date.parse(m.created_at);
    const timestamp = Number.isFinite(ts) ? ts : Date.now();

    if (m.role === 'user') {
      out.push({
        role: 'user',
        content: m.text,
        timestamp,
      });
      continue;
    }

    if (m.role === 'assistant') {
      if (m.error) {
        out.push({
          role: 'assistant',
          content: [{ type: 'text', text: m.error }],
          api: 'openai-completions',
          provider: model.provider,
          model: model.id,
          usage: emptyUsage,
          stopReason: 'error',
          errorMessage: m.error,
          timestamp,
        });
      } else {
        out.push({
          role: 'assistant',
          content: [{ type: 'text', text: m.text }],
          api: 'openai-completions',
          provider: model.provider,
          model: model.id,
          usage: emptyUsage,
          stopReason: (m.stopReason as 'stop') || 'stop',
          timestamp,
        });
      }
    }
  }

  agent.state.messages = out;
}
