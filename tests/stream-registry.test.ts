import { describe, it, expect, beforeEach } from 'vitest';
import {
  register,
  get,
  findActiveRunForConversation,
  markEnded,
  evict,
  emit,
  replay,
} from '../src/webapp/chat/stream-registry.js';
import type { RunState, WebAgent } from '../src/webapp/chat/types.js';

function makeAgent(): WebAgent {
  return {
    subscribe: () => () => {},
    prompt: () => {},
    steer: () => {},
    abort: () => {},
    waitForIdle: async () => {},
    state: { isStreaming: true },
  };
}

function makeRun(partial: Partial<RunState> & Pick<RunState, 'messageId' | 'conversationId' | 'assistantMessageId' | 'userSlug'>): RunState {
  return {
    isAdmin: false,
    agent: makeAgent(),
    startedAt: Date.now(),
    bufferedEvents: [],
    subscriber: null,
    ended: false,
    ...partial,
  };
}

describe('stream-registry', () => {
  beforeEach(() => {
    // Evict anything left from prior tests by messageId we know about.
    for (const id of ['run-a', 'run-b', 'run-ended']) {
      evict(id);
    }
  });

  it('findActiveRunForConversation returns the live run for that chat', () => {
    register(
      makeRun({
        messageId: 'run-a',
        conversationId: 'conv-1',
        assistantMessageId: 'asst-1',
        userSlug: 'alice',
      }),
    );
    register(
      makeRun({
        messageId: 'run-b',
        conversationId: 'conv-2',
        assistantMessageId: 'asst-2',
        userSlug: 'alice',
      }),
    );

    const found = findActiveRunForConversation('alice', 'conv-1');
    expect(found).not.toBeNull();
    expect(found!.messageId).toBe('run-a');
    expect(found!.assistantMessageId).toBe('asst-1');
    expect(findActiveRunForConversation('alice', 'conv-missing')).toBeNull();
    expect(findActiveRunForConversation('bob', 'conv-1')).toBeNull();
  });

  it('findActiveRunForConversation ignores ended runs', () => {
    register(
      makeRun({
        messageId: 'run-ended',
        conversationId: 'conv-1',
        assistantMessageId: 'asst-1',
        userSlug: 'alice',
      }),
    );
    markEnded('run-ended');
    expect(findActiveRunForConversation('alice', 'conv-1')).toBeNull();
    // Still in registry for replay until eviction timer fires.
    expect(get('run-ended')).not.toBeNull();
  });

  it('replay returns buffered events for reattach', () => {
    register(
      makeRun({
        messageId: 'run-a',
        conversationId: 'conv-1',
        assistantMessageId: 'asst-1',
        userSlug: 'alice',
      }),
    );
    emit('run-a', { type: 'ack', messageId: 'run-a', slug: 'alice', agentName: 'Agent' });
    emit('run-a', { type: 'delta', text: 'Hi', cumulative: 'Hi' });
    emit('run-a', { type: 'heartbeat', elapsedMs: 3000, activeTools: [] });

    const events = replay('run-a');
    expect(events).toHaveLength(3);
    expect(events![1]).toMatchObject({ type: 'delta', cumulative: 'Hi' });
  });
});
