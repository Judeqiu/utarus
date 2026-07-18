/**
 * In-memory registry of active + recently-finished runs.
 *
 * Keyed by messageId. Each entry holds the live agent (for abort), a ring
 * buffer of emitted events (for SSE replay on reconnect), and a slot for one
 * live subscriber callback.
 *
 * Lifecycle:
 *   - register(messageId) on POST /messages before agent.prompt()
 *   - subscriber attaches on GET /stream/:messageId
 *   - run-agent pushes events via emit(); they fan-out to the subscriber and
 *     are always appended to the buffer
 *   - on terminal event (done|error|cap), mark ended; evict after 5 min so
 *     a client that reconnects can still replay
 *
 * Cap: hard ceiling on total registry size to prevent unbounded growth from
 * abandoned messageIds (safety guard, not optimisation).
 */

import type { ChatEvent, RunState } from './types.js';

const MAX_RUNS = 200;
const EVICT_AFTER_MS = 5 * 60 * 1000;

const runs = new Map<string, RunState>();

function evictOldest(): void {
  let oldest: RunState | null = null;
  for (const r of runs.values()) {
    if (!oldest || r.startedAt < oldest.startedAt) oldest = r;
  }
  if (oldest) {
    evict(oldest.messageId);
  }
}

export function register(state: RunState): void {
  if (runs.size >= MAX_RUNS) evictOldest();
  runs.set(state.messageId, state);
}

export function get(messageId: string): RunState | null {
  return runs.get(messageId) ?? null;
}

/**
 * Find a non-ended run for a user's conversation. Used when the client
 * reloads or switches back mid-stream so it can reattach to SSE + replay.
 */
export function findActiveRunForConversation(
  userSlug: string,
  conversationId: string,
): RunState | null {
  for (const r of runs.values()) {
    if (
      !r.ended &&
      r.userSlug === userSlug &&
      r.conversationId === conversationId
    ) {
      return r;
    }
  }
  return null;
}

export function attachSubscriber(
  messageId: string,
  sub: (event: ChatEvent) => void,
): RunState | null {
  const r = runs.get(messageId);
  if (!r) return null;
  r.subscriber = sub;
  return r;
}

export function detachSubscriber(messageId: string): void {
  const r = runs.get(messageId);
  if (!r) return;
  r.subscriber = null;
}

/**
 * Push an event into a run's buffer and forward it to its live subscriber
 * (if any). Returns false if the run is unknown (already evicted).
 */
export function emit(messageId: string, event: ChatEvent): boolean {
  const r = runs.get(messageId);
  if (!r) return false;
  r.bufferedEvents.push(event);
  // Cap the ring buffer — keep the most recent 256 events (safety guard).
  if (r.bufferedEvents.length > 256) {
    r.bufferedEvents.splice(0, r.bufferedEvents.length - 256);
  }
  if (r.subscriber) {
    r.subscriber(event);
  }
  return true;
}

/** Mark the run ended and arm the 5-min eviction timer. */
export function markEnded(messageId: string): void {
  const r = runs.get(messageId);
  if (!r || r.ended) return;
  r.ended = true;
  r.evictionTimeout = setTimeout(() => evict(messageId), EVICT_AFTER_MS);
}

export function evict(messageId: string): void {
  const r = runs.get(messageId);
  if (!r) return;
  if (r.evictionTimeout) clearTimeout(r.evictionTimeout);
  runs.delete(messageId);
}

export function size(): number {
  return runs.size;
}

/**
 * Replay buffered events for a reconnecting SSE client.
 * If `afterEventId` is supplied (Last-Event-ID header), only events whose
 * buffer index is greater are returned. Buffer eviction means we cannot
 * always satisfy a rewind — caller surfaces a 404 in that case.
 */
export function replay(messageId: string, afterEventId?: number): ChatEvent[] | null {
  const r = runs.get(messageId);
  if (!r) return null;
  if (afterEventId === undefined) return [...r.bufferedEvents];
  // Event ids are 0-indexed positions in the buffer at emit time; because we
  // cap the buffer at 256 we accept any id and replay the tail.
  return r.bufferedEvents.filter((_, i) => i >= Math.max(0, afterEventId));
}
