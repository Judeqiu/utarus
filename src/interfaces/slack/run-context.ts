/**
 * Per-agent-run context for Slack.
 * Tools read this via getRunContext() to stamp leases with channel/slack ids
 * without threading params through every factory.
 */

import { AsyncLocalStorage } from 'async_hooks';

export interface RunContext {
  userSlug: string;
  slackUserId?: string;
  channelId?: string;
  /** Parent thread for replies (mention ts or existing thread_ts). */
  threadTs?: string;
  surface?: 'dm' | 'mention' | 'command' | 'other';
}

const storage = new AsyncLocalStorage<RunContext>();

export function runWithContext<T>(ctx: RunContext, fn: () => T): T {
  if (!ctx.userSlug) throw new Error('RunContext.userSlug is required');
  return storage.run(ctx, fn);
}

export function getRunContext(): RunContext | undefined {
  return storage.getStore();
}

/**
 * Resolve Slack thread parent for bot replies:
 * - Already in a thread → stay there (`thread_ts`)
 * - Top-level mention/message → start a thread under that message (`ts`)
 */
export function resolveReplyThreadTs(event: { ts?: string; thread_ts?: string }): string | undefined {
  if (event.thread_ts) return event.thread_ts;
  return event.ts;
}
