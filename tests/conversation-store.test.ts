import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  listConversations,
  createConversation,
  getConversation,
  appendMessage,
  renameConversation,
  deleteConversation,
  clearConversationMessages,
} from '../src/webapp/chat/conversation-store.js';

describe('conversation-store', () => {
  let dataRoot: string;
  const prev = process.env.UTARUS_DATA_ROOT;

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'utarus-chats-'));
    process.env.UTARUS_DATA_ROOT = dataRoot;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.UTARUS_DATA_ROOT;
    else process.env.UTARUS_DATA_ROOT = prev;
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('creates and lists conversations newest-first', () => {
    const a = createConversation('alice');
    const b = createConversation('alice', { title: 'Second' });
    expect(a.id).not.toBe(b.id);
    const list = listConversations('alice');
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(b.id);
    expect(list[1].id).toBe(a.id);
    expect(list[0].title).toBe('Second');
  });

  it('auto-titles from first user message', () => {
    const c = createConversation('bob');
    appendMessage('bob', c.id, {
      role: 'user',
      text: 'What is the outlook for AAPL this quarter?',
    });
    const loaded = getConversation('bob', c.id);
    expect(loaded.title).toMatch(/outlook for AAPL/i);
    expect(loaded.messages).toHaveLength(1);
    const list = listConversations('bob');
    expect(list[0].message_count).toBe(1);
    expect(list[0].preview).toMatch(/AAPL/);
  });

  it('appends assistant replies and renames', () => {
    const c = createConversation('cara');
    appendMessage('cara', c.id, { role: 'user', text: 'Hello' });
    appendMessage('cara', c.id, {
      role: 'assistant',
      text: 'Hi there',
      stopReason: 'stop',
    });
    const loaded = getConversation('cara', c.id);
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.messages[1].role).toBe('assistant');

    renameConversation('cara', c.id, 'My chat');
    expect(getConversation('cara', c.id).title).toBe('My chat');
  });

  it('clears messages but keeps conversation', () => {
    const c = createConversation('dan');
    appendMessage('dan', c.id, { role: 'user', text: 'x' });
    clearConversationMessages('dan', c.id);
    const loaded = getConversation('dan', c.id);
    expect(loaded.messages).toHaveLength(0);
    expect(listConversations('dan')).toHaveLength(1);
  });

  it('deletes conversation', () => {
    const c = createConversation('eve');
    deleteConversation('eve', c.id);
    expect(listConversations('eve')).toHaveLength(0);
    expect(() => getConversation('eve', c.id)).toThrow(/not found/);
  });

  it('fails fast on invalid slug', () => {
    expect(() => createConversation('../evil')).toThrow(/Invalid chat slug/);
  });
});
