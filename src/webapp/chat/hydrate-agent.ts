/**
 * Hydrate a pi-agent-core Agent's message list from stored WebUI turns so
 * multi-turn context survives page refresh and conversation switches.
 */

import type { Agent } from '@earendil-works/pi-agent-core';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { getAgentModel } from '../../llm/index.js';
import { loadAttachment } from './attachments.js';
import type { StoredChatMessage } from './conversation-types.js';
import { userTurnTextForAgent } from './quotes.js';

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
 *
 * `slug` is the conversation owner — needed to reload photo attachments from
 * data/chats/<slug>/attachments/ so image context survives restarts too.
 */
export function hydrateAgentFromStoredMessages(
  agent: Agent,
  messages: StoredChatMessage[],
  slug?: string,
): void {
  const model = getAgentModel();
  const out: AgentMessage[] = [];

  for (const m of messages) {
    const ts = Date.parse(m.created_at);
    const timestamp = Number.isFinite(ts) ? ts : Date.now();

    if (m.role === 'user') {
      // Rebuild agent-facing quote prefix from stored quotes (no channel hint / enrich).
      const bodyText = userTurnTextForAgent(m.text, m.quotes);
      if (slug && m.attachments?.length) {
        const parts: Array<
          { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
        > = [{ type: 'text', text: bodyText }];
        for (const a of m.attachments) {
          try {
            const f = loadAttachment(slug, a.id);
            parts.push({ type: 'image', data: f.bytes.toString('base64'), mimeType: f.mimeType });
          } catch {
            // Attachment file gone — hydrate that turn text-only rather than
            // failing the whole conversation.
          }
        }
        out.push({ role: 'user', content: parts, timestamp });
        continue;
      }
      out.push({
        role: 'user',
        content: bodyText,
        timestamp,
      });
      continue;
    }

    if (m.role === 'assistant') {
      const provider = m.llm?.provider ?? model.provider;
      const modelId = m.llm?.model ?? model.id;
      if (m.error) {
        out.push({
          role: 'assistant',
          content: [{ type: 'text', text: m.error }],
          api: 'openai-completions',
          provider,
          model: modelId,
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
          provider,
          model: modelId,
          usage: emptyUsage,
          stopReason: (m.stopReason as 'stop') || 'stop',
          timestamp,
        });
      }
    }
  }

  agent.state.messages = out;
}
