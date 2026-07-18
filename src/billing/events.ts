/**
 * Durable Stripe event-id store for webhook idempotency.
 * Presence of data/billing/events/<event_id>.json ⇒ already applied.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { resolveDataRoot } from '../config.js';

export interface BillingEventReceipt {
  id: string;
  type: string;
  processed_at: string;
  user_slug?: string;
}

export function billingEventsDir(): string {
  return join(resolveDataRoot(), 'billing', 'events');
}

function eventPath(eventId: string): string {
  if (!eventId || typeof eventId !== 'string' || eventId.includes('/') || eventId.includes('..')) {
    throw new Error(`Invalid Stripe event id: ${String(eventId)}`);
  }
  return join(billingEventsDir(), `${eventId}.json`);
}

export function eventAlreadyProcessed(eventId: string): boolean {
  return existsSync(eventPath(eventId));
}

export function markEventProcessed(
  eventId: string,
  type: string,
  userSlug?: string,
): void {
  const path = eventPath(eventId);
  mkdirSync(billingEventsDir(), { recursive: true });
  const receipt: BillingEventReceipt = {
    id: eventId,
    type,
    processed_at: new Date().toISOString(),
    ...(userSlug ? { user_slug: userSlug } : {}),
  };
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(receipt, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path);
}

export function readEventReceipt(eventId: string): BillingEventReceipt | null {
  const path = eventPath(eventId);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as BillingEventReceipt;
}
