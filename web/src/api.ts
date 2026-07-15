/**
 * API + SSE client. All endpoints are same-origin (Vite dev proxy or the
 * production express server). Cookies travel with `credentials: 'include'`.
 *
 * Spec: docs/webui-chat-design.md §6, §7.
 */

import type { AssetRef, ChatEvent, InviteCode, AdminUserSummary } from './types.js';

export type SendOutcome =
  | { kind: 'run'; messageId: string }
  | { kind: 'queued' }
  | { kind: 'reply'; text: string };

export async function sendMessage(text: string, opts?: { queue?: boolean }): Promise<SendOutcome> {
  const res = await fetch('/api/chat/messages', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, queue: opts?.queue === true }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || body.message || `HTTP ${res.status}`);
  }
  return (await res.json()) as SendOutcome;
}

export async function clearContext(): Promise<void> {
  const res = await fetch('/api/chat/clear', {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) {
    throw new Error(`Clear failed: HTTP ${res.status}`);
  }
}

export async function abortRun(): Promise<void> {
  const res = await fetch('/api/chat/abort', {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`Abort failed: HTTP ${res.status}`);
  }
}

export interface SubscribeHandlers {
  onEvent: (event: ChatEvent) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
}

/**
 * Subscribe to a run's SSE stream using fetch-streaming (works with cookies
 * and Last-Event-ID replay, which EventSource does not let us customise).
 *
 * Returns an AbortController. Call `.abort()` to cancel.
 *
 * Reconnect: on transient close before `end`, the caller can re-invoke with
 * the same messageId and the server will replay buffered events via
 * Last-Event-ID.
 */
export function subscribeStream(
  messageId: string,
  lastEventId: number | undefined,
  handlers: SubscribeHandlers,
): AbortController {
  const controller = new AbortController();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEventType = '';
  let currentData = '';
  let currentId: number | undefined;

  (async () => {
    const headers: Record<string, string> = {};
    if (lastEventId !== undefined) {
      headers['Last-Event-ID'] = String(lastEventId);
    }
    let res: Response;
    try {
      res = await fetch(`/api/chat/stream/${messageId}`, {
        method: 'GET',
        credentials: 'include',
        signal: controller.signal,
        headers,
      });
    } catch (e) {
      if (!controller.signal.aborted) {
        handlers.onError?.(e instanceof Error ? e : new Error(String(e)));
      }
      handlers.onClose?.();
      return;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      handlers.onError?.(new Error(`HTTP ${res.status}: ${text}`));
      handlers.onClose?.();
      return;
    }
    if (!res.body) {
      handlers.onError?.(new Error('No response body'));
      handlers.onClose?.();
      return;
    }

    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          parseEventBlock(chunk);
        }
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        handlers.onError?.(e instanceof Error ? e : new Error(String(e)));
      }
    } finally {
      handlers.onClose?.();
    }
  })();

  function parseEventBlock(block: string): void {
    currentEventType = '';
    currentData = '';
    currentId = undefined;
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue; // comment
      if (line.startsWith('event: ')) {
        currentEventType = line.slice('event: '.length);
      } else if (line.startsWith('data: ')) {
        currentData += line.slice('data: '.length);
      } else if (line.startsWith('id: ')) {
        const idStr = line.slice('id: '.length).trim();
        const n = Number(idStr);
        if (Number.isFinite(n)) currentId = n;
      }
    }
    if (!currentEventType || !currentData) return;
    let payload: unknown;
    try {
      payload = JSON.parse(currentData);
    } catch {
      // skip malformed
      return;
    }
    const ev = payload as ChatEvent;
    // sanity: enforce type matches the event: line
    if (ev.type !== currentEventType) {
      return;
    }
    handlers.onEvent(ev);
    if (currentId !== undefined && ev.type !== 'end') {
      lastEventId = currentId;
    }
  }

  return controller;
}

// ── Onboard ────────────────────────────────────────────────────────────

export interface RedeemResponse {
  slug: string;
  display_name: string;
  contact_email: string;
  /** One-shot plaintext preset password. Populated when a new profile was
   *  created this call. Show it once to the user; never persist client-side. */
  preset_password: string;
  redirect: string;
}

export async function redeemInvite(
  displayName: string,
  code: string | null,
): Promise<RedeemResponse> {
  const res = await fetch('/api/onboard/redeem', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ display_name: displayName, code }),
  });
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) {
    throw new Error(body.error || body.message || `HTTP ${res.status}`);
  }
  return body as RedeemResponse;
}

export interface LoginResponse {
  type: 'user' | 'admin';
  slug: string;
  displayName?: string;
}

/**
 * Sign in with username (slug OR contact_email) + password. The server
 * dispatches via utarus `authenticateUser`. Throws on 401 / 400 / network.
 */
export async function loginWithPassword(
  identifier: string,
  password: string,
): Promise<LoginResponse> {
  const res = await fetch('/api/onboard/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  });
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) {
    throw new Error(body.error || body.message || `HTTP ${res.status}`);
  }
  return body as LoginResponse;
}

/**
 * Change the signed-in user's password. Requires active session cookie.
 * `newPassword` must be ≥6 chars. Returns { ok: true } on success.
 */
export async function changePassword(newPassword: string): Promise<{ ok: boolean }> {
  const res = await fetch('/api/onboard/profile/password', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ new_password: newPassword }),
  });
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) {
    throw new Error(body.error || body.message || `HTTP ${res.status}`);
  }
  return body as { ok: boolean };
}

// ── Admin ──────────────────────────────────────────────────────────────

export async function listInvites(filter: 'all' | 'unused' | 'used' = 'all'): Promise<InviteCode[]> {
  const res = await fetch(`/api/admin/invites?filter=${encodeURIComponent(filter)}`, {
    method: 'GET',
    credentials: 'include',
  });
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) {
    throw new Error(body.error || body.message || `HTTP ${res.status}`);
  }
  return (body.codes ?? []) as InviteCode[];
}

export async function createInvite(comment?: string): Promise<InviteCode> {
  const res = await fetch('/api/admin/invites', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment }),
  });
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) {
    throw new Error(body.error || body.message || `HTTP ${res.status}`);
  }
  return body as InviteCode;
}

export async function listUsers(): Promise<AdminUserSummary[]> {
  const res = await fetch('/api/admin/users', {
    method: 'GET',
    credentials: 'include',
  });
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) {
    throw new Error(body.error || body.message || `HTTP ${res.status}`);
  }
  return (body.users ?? []) as AdminUserSummary[];
}

// ── Asset fetch (for CsvTable, AssetJson) ──────────────────────────────

export async function fetchAssetText(url: string): Promise<string> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    throw new Error(`Asset fetch HTTP ${res.status}`);
  }
  return await res.text();
}

export function assetUrlFromRef(ref: AssetRef): string {
  // ref.url is already /api/files/<name>(/view|/raw)?slug=...
  return ref.url;
}
