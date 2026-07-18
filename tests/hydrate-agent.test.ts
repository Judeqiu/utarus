import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { hydrateAgentFromStoredMessages } from '../src/webapp/chat/hydrate-agent.js';
import type { StoredChatMessage } from '../src/webapp/chat/conversation-types.js';
import { formatQuotesForAgent } from '../src/webapp/chat/quotes.js';
import { saveAttachment } from '../src/webapp/chat/attachments.js';

// hydrate imports getAgentModel — stub a minimal model for assistant turns.
vi.mock('../src/llm/index.js', () => ({
  getAgentModel: () => ({
    id: 'test-model',
    provider: 'test',
    api: 'openai-completions',
  }),
}));

function makeAgent() {
  return {
    state: { messages: [] as unknown[] },
  } as Parameters<typeof hydrateAgentFromStoredMessages>[0];
}

describe('hydrateAgentFromStoredMessages + quotes', () => {
  let dataRoot: string;
  const prev = process.env.UTARUS_DATA_ROOT;

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'utarus-hydrate-'));
    process.env.UTARUS_DATA_ROOT = dataRoot;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.UTARUS_DATA_ROOT;
    else process.env.UTARUS_DATA_ROOT = prev;
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('rebuilds quote prefix on user turns without channel hint', () => {
    const quote = {
      messageId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      role: 'assistant' as const,
      text: 'Revenue grew 12%.',
    };
    const messages: StoredChatMessage[] = [
      {
        id: '1',
        role: 'user',
        text: 'What about Q3?',
        created_at: new Date().toISOString(),
        quotes: [quote],
      },
    ];
    const agent = makeAgent();
    hydrateAgentFromStoredMessages(agent, messages);
    expect(agent.state.messages).toHaveLength(1);
    const m = agent.state.messages[0] as { role: string; content: string };
    expect(m.role).toBe('user');
    expect(typeof m.content).toBe('string');
    expect(m.content).toBe(
      `${formatQuotesForAgent([quote])}\n\nWhat about Q3?`,
    );
    expect(m.content).not.toContain('[Channel: web');
  });

  it('uses quote-prefixed bodyText on image multipart user turns', () => {
    // Minimal 1x1 PNG (base64)
    const data =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const att = saveAttachment('bob', {
      name: 'dot.png',
      mimeType: 'image/png',
      data,
    });
    const quote = {
      messageId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      role: 'user' as const,
      text: 'look at this',
    };
    const messages: StoredChatMessage[] = [
      {
        id: '2',
        role: 'user',
        text: 'See photo',
        created_at: new Date().toISOString(),
        quotes: [quote],
        attachments: [
          { id: att.id, name: att.name, mimeType: att.mimeType },
        ],
      },
    ];
    const agent = makeAgent();
    hydrateAgentFromStoredMessages(agent, messages, 'bob');
    const m = agent.state.messages[0] as {
      role: string;
      content: Array<{ type: string; text?: string }>;
    };
    expect(Array.isArray(m.content)).toBe(true);
    const textPart = m.content.find((p) => p.type === 'text');
    expect(textPart?.text).toBe(
      `${formatQuotesForAgent([quote])}\n\nSee photo`,
    );
    expect(m.content.some((p) => p.type === 'image')).toBe(true);
  });
});
