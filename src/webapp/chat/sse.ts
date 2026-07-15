/**
 * SSE wire helpers. One event = one `sseEvent(...)` call.
 *
 * Wire format:
 *   event: <type>\n
 *   data: <json>\n
 *   \n
 *
 * Optional `id:` is emitted when an event id is supplied (used for
 * Last-Event-ID replay — see stream-registry).
 */

import { type Response } from 'express';
import type { ChatEvent } from './types.js';

export function setSSEHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Disable proxy buffering (nginx, fly.io, etc.).
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}

export function sendSSEEvent(
  res: Response,
  event: ChatEvent,
  eventId?: number | string,
): void {
  if (eventId !== undefined) {
    res.write(`id: ${eventId}\n`);
  }
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** Heartbeat comment — keeps the connection alive without emitting a client-visible event. */
export function sendSSEComment(res: Response, text: string): void {
  res.write(`: ${text}\n\n`);
}
