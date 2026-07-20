/**
 * API + SSE client. All endpoints are same-origin (Vite dev proxy or the
 * production express server). Cookies travel with `credentials: 'include'`.
 *
 * Spec: docs/webui-chat-design.md §6, §7.
 *
 * Resilience: transient network / 5xx failures are retried with backoff.
 * 401 surfaces as a clear re-login message (not opaque "Failed to fetch").
 */

import type {
  AssetRef,
  ChatEvent,
  ChatQuoteRef,
  InviteCode,
  AdminUserSummary,
  ConversationSummary,
  ConversationDetail,
} from './types.js';

const DEFAULT_RETRIES = 3;
const BASE_DELAY_MS = 350;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  // Browser TypeError: Failed to fetch / NetworkError / connection closed
  return (
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('network request failed') ||
    msg.includes('load failed') ||
    msg.includes('connection') ||
    msg.includes('aborted') ||
    err.name === 'TypeError'
  );
}

export class CapExceededError extends Error {
  readonly code = 'cap_exceeded' as const;
  constructor(
    message: string,
    readonly upgradeUrl?: string,
    readonly planId?: string,
    readonly current?: number,
    readonly cap?: number,
  ) {
    super(message);
    this.name = 'CapExceededError';
  }
}

export class BillingStateError extends Error {
  readonly code = 'billing_state_error' as const;
  constructor(message: string) {
    super(message);
    this.name = 'BillingStateError';
  }
}

function friendlyHttpError(
  status: number,
  body: {
    error?: string;
    message?: string;
    upgrade_url?: string;
    plan_id?: string;
    current?: number;
    cap?: number;
  },
): Error {
  if (status === 401) {
    return new Error(
      body.message ||
        body.error ||
        'Session expired or server restarted — please log in again.',
    );
  }
  if (status === 429 && body.error === 'cap_exceeded') {
    return new CapExceededError(
      body.message || 'Monthly usage cap reached.',
      body.upgrade_url,
      body.plan_id,
      body.current,
      body.cap,
    );
  }
  if (status === 503 && body.error === 'billing_state_error') {
    return new BillingStateError(
      body.message || 'Billing/usage state is temporarily unavailable.',
    );
  }
  if (status === 502 || status === 503 || status === 504) {
    return new Error(
      body.message ||
        'Server temporarily unavailable (restart or overload). Retry in a moment.',
    );
  }
  return new Error(body.message || body.error || `HTTP ${status}`);
}

/**
 * fetch with credentials, JSON helpers, and retries on network / 5xx.
 * Does not retry 4xx except optionally 408/429.
 */
export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  opts?: { retries?: number; retryOnPost?: boolean },
): Promise<Response> {
  const retries = opts?.retries ?? DEFAULT_RETRIES;
  const method = (init?.method ?? 'GET').toUpperCase();
  // Safe to retry GET/HEAD always; POST only when caller opts in (idempotent enough for send).
  const allowRetry =
    method === 'GET' || method === 'HEAD' || opts?.retryOnPost === true;

  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(input, { credentials: 'include', ...init });
      // Never retry 429 on chat POST (cap_exceeded is not transient).
  // Still allow optional 429 retry for other methods if caller opts in.
  const isChatPost =
    method === 'POST' &&
    String(input).includes('/api/chat/messages');
  if (
        allowRetry &&
        attempt < retries - 1 &&
        (res.status >= 500 ||
          res.status === 408 ||
          (res.status === 429 && !isChatPost))
      ) {
        await sleep(BASE_DELAY_MS * 2 ** attempt);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (init?.signal?.aborted) throw err;
      if (allowRetry && isTransientNetworkError(err) && attempt < retries - 1) {
        await sleep(BASE_DELAY_MS * 2 ** attempt);
        continue;
      }
      if (isTransientNetworkError(err)) {
        throw new Error(
          'Connection lost (server may be restarting). Please try again.',
        );
      }
      throw err;
    }
  }
  if (lastErr instanceof Error) throw lastErr;
  throw new Error('Request failed after retries');
}

async function readErrorBody(res: Response): Promise<{
  error?: string;
  message?: string;
  upgrade_url?: string;
  plan_id?: string;
  current?: number;
  cap?: number;
}> {
  return (await res.json().catch(() => ({
    error: res.statusText,
  }))) as {
    error?: string;
    message?: string;
    upgrade_url?: string;
    plan_id?: string;
    current?: number;
    cap?: number;
  };
}

export type SendOutcome =
  | {
      kind: 'run';
      messageId: string;
      conversationId: string;
      userMessageId?: string;
      assistantMessageId?: string;
    }
  | { kind: 'queued'; conversationId?: string }
  | { kind: 'reply'; text: string };

export interface WebCommandInfo {
  name: string;
  description: string;
  adminOnly: boolean;
  usageHint?: string;
  source: 'framework' | 'domain';
}

/** List slash commands available in WebUI (framework + domain webCommands). */
export async function listChatCommands(): Promise<WebCommandInfo[]> {
  const res = await fetchWithRetry('/api/chat/commands', { method: 'GET' });
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) {
    throw friendlyHttpError(res.status, body);
  }
  return (body.commands ?? []) as WebCommandInfo[];
}

export async function sendMessage(
  text: string,
  opts?: {
    queue?: boolean;
    conversationId?: string;
    attachments?: Array<{ id: string; name?: string }>;
    quotes?: ChatQuoteRef[];
  },
): Promise<SendOutcome> {
  const res = await fetchWithRetry(
    '/api/chat/messages',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        queue: opts?.queue === true,
        conversationId: opts?.conversationId,
        ...(opts?.attachments?.length
          ? {
              attachments: opts.attachments.map((a) => ({
                id: a.id,
                name: a.name,
              })),
            }
          : {}),
        ...(opts?.quotes?.length
          ? {
              quotes: opts.quotes.map((q) => ({
                messageId: q.messageId,
                role: q.role,
                text: q.text,
                ...(q.source !== undefined ? { source: q.source } : {}),
                ...(q.widgetKind !== undefined ? { widgetKind: q.widgetKind } : {}),
                ...(q.widgetTitle !== undefined ? { widgetTitle: q.widgetTitle } : {}),
              })),
            }
          : {}),
      }),
    },
    // Retry POST: message create is safe enough if server never accepted (connection drop).
    { retryOnPost: true, retries: 3 },
  );
  if (!res.ok) {
    throw friendlyHttpError(res.status, await readErrorBody(res));
  }
  return (await res.json()) as SendOutcome;
}

// ── Chat attachments (user-uploaded photos) ───────────────────────────

export interface ChatAttachmentUpload {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
}

export async function uploadChatAttachment(input: {
  name: string;
  mimeType: string;
  dataBase64: string;
}): Promise<ChatAttachmentUpload> {
  const res = await fetchWithRetry(
    '/api/chat/attachments',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: input.name,
        mimeType: input.mimeType,
        data: input.dataBase64,
      }),
    },
    { retryOnPost: true },
  );
  if (!res.ok) {
    throw friendlyHttpError(res.status, await readErrorBody(res));
  }
  return (await res.json()) as ChatAttachmentUpload;
}

export function attachmentUrl(id: string): string {
  return `/api/chat/attachments/${encodeURIComponent(id)}`;
}

export async function clearContext(conversationId: string): Promise<void> {
  const res = await fetchWithRetry(
    '/api/chat/clear',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId }),
    },
    { retryOnPost: true },
  );
  if (!res.ok) {
    throw friendlyHttpError(res.status, await readErrorBody(res));
  }
}

export async function abortRun(conversationId?: string): Promise<void> {
  const res = await fetchWithRetry(
    '/api/chat/abort',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId }),
    },
    { retryOnPost: true },
  );
  if (!res.ok && res.status !== 409) {
    throw friendlyHttpError(res.status, await readErrorBody(res));
  }
}
// ── Conversations ────────────────────────────────────────────────────

export async function listConversations(): Promise<ConversationSummary[]> {
  const res = await fetchWithRetry('/api/chat/conversations', { method: 'GET' });
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) {
    throw friendlyHttpError(res.status, body);
  }
  return (body.conversations ?? []) as ConversationSummary[];
}

export async function createConversation(title?: string): Promise<ConversationDetail> {
  const res = await fetchWithRetry(
    '/api/chat/conversations',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(title ? { title } : {}),
    },
    { retryOnPost: true },
  );
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) {
    throw friendlyHttpError(res.status, body);
  }
  return body as ConversationDetail;
}

export async function getConversation(id: string): Promise<ConversationDetail> {
  const res = await fetchWithRetry(
    `/api/chat/conversations/${encodeURIComponent(id)}`,
    { method: 'GET' },
  );
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) {
    throw friendlyHttpError(res.status, body);
  }
  return body as ConversationDetail;
}

export async function renameConversation(
  id: string,
  title: string,
): Promise<ConversationDetail> {
  const res = await fetchWithRetry(
    `/api/chat/conversations/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    },
    { retryOnPost: true },
  );
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) {
    throw friendlyHttpError(res.status, body);
  }
  return body as ConversationDetail;
}

export async function deleteConversation(id: string): Promise<void> {
  const res = await fetchWithRetry(
    `/api/chat/conversations/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
    { retryOnPost: true },
  );
  if (!res.ok) {
    throw friendlyHttpError(res.status, await readErrorBody(res));
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
 * Auto-reconnect: on transient network drop before `end`/`error`, reconnects
 * up to 4 times with Last-Event-ID so buffered events are replayed.
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
  let sawTerminal = false;
  let cursor = lastEventId;
  const maxReconnects = 4;

  (async () => {
    for (let attempt = 0; attempt <= maxReconnects; attempt++) {
      if (controller.signal.aborted) {
        handlers.onClose?.();
        return;
      }
      buffer = '';
      const headers: Record<string, string> = {};
      if (cursor !== undefined) {
        headers['Last-Event-ID'] = String(cursor);
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
        if (controller.signal.aborted) {
          handlers.onClose?.();
          return;
        }
        if (attempt < maxReconnects) {
          await sleep(BASE_DELAY_MS * 2 ** attempt);
          continue;
        }
        handlers.onError?.(
          e instanceof Error
            ? new Error(
                isTransientNetworkError(e)
                  ? 'Stream connection lost after retries. Please resend if the reply did not finish.'
                  : e.message,
              )
            : new Error(String(e)),
        );
        handlers.onClose?.();
        return;
      }

      if (!res.ok) {
        if (res.status === 401) {
          handlers.onError?.(
            new Error('Session expired — please log in again.'),
          );
          handlers.onClose?.();
          return;
        }
        // 404/410: run gone — do not reconnect forever
        if (res.status === 404 || res.status === 410 || res.status === 409) {
          const text = await res.text().catch(() => '');
          handlers.onError?.(new Error(`HTTP ${res.status}: ${text || res.statusText}`));
          handlers.onClose?.();
          return;
        }
        if (attempt < maxReconnects && res.status >= 500) {
          await sleep(BASE_DELAY_MS * 2 ** attempt);
          continue;
        }
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
      let streamError: unknown = null;
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
        streamError = e;
      }

      if (sawTerminal || controller.signal.aborted) {
        handlers.onClose?.();
        return;
      }

      // Stream ended without terminal event — try reconnect (deploy blip).
      if (streamError && !controller.signal.aborted && attempt < maxReconnects) {
        await sleep(BASE_DELAY_MS * 2 ** attempt);
        continue;
      }
      if (!streamError && attempt < maxReconnects) {
        await sleep(BASE_DELAY_MS * 2 ** attempt);
        continue;
      }

      if (streamError && !controller.signal.aborted) {
        handlers.onError?.(
          streamError instanceof Error
            ? streamError
            : new Error(String(streamError)),
        );
      }
      handlers.onClose?.();
      return;
    }
    handlers.onClose?.();
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
      cursor = currentId;
    }
    // Only end/error stop reconnect — drop after `done` still tries Last-Event-ID resume.
    if (ev.type === 'end' || ev.type === 'error') {
      sawTerminal = true;
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
  const res = await fetchWithRetry(
    '/api/onboard/redeem',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: displayName, code }),
    },
    { retryOnPost: true },
  );
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) {
    throw friendlyHttpError(res.status, body);
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
  // Do not retry login POST blindly with password on ambiguous failures —
  // only network blips (fetchWithRetry still retries network/5xx).
  const res = await fetchWithRetry(
    '/api/onboard/login',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password }),
    },
    { retryOnPost: true, retries: 2 },
  );
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) {
    throw friendlyHttpError(res.status, body);
  }
  return body as LoginResponse;
}

/**
 * Change the signed-in user's password. Requires active session cookie.
 * `newPassword` must be ≥6 chars. Returns { ok: true } on success.
 */
export async function changePassword(newPassword: string): Promise<{ ok: boolean }> {
  const res = await fetchWithRetry(
    '/api/onboard/profile/password',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_password: newPassword }),
    },
    { retryOnPost: true },
  );
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) {
    throw friendlyHttpError(res.status, body);
  }
  return body as { ok: boolean };
}

// ── Admin ──────────────────────────────────────────────────────────────

export async function listInvites(filter: 'all' | 'unused' | 'used' = 'all'): Promise<InviteCode[]> {
  const res = await fetchWithRetry(
    `/api/admin/invites?filter=${encodeURIComponent(filter)}`,
    { method: 'GET' },
  );
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) {
    throw friendlyHttpError(res.status, body);
  }
  return (body.codes ?? []) as InviteCode[];
}

export async function createInvite(comment?: string): Promise<InviteCode> {
  const res = await fetchWithRetry(
    '/api/admin/invites',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment }),
    },
    { retryOnPost: true },
  );
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) {
    throw friendlyHttpError(res.status, body);
  }
  return body as InviteCode;
}

export async function listUsers(): Promise<AdminUserSummary[]> {
  const res = await fetchWithRetry('/api/admin/users', { method: 'GET' });
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) {
    throw friendlyHttpError(res.status, body);
  }
  return (body.users ?? []) as AdminUserSummary[];
}

// ── Asset fetch (for CsvTable, AssetJson) ──────────────────────────────

export async function fetchAssetText(url: string): Promise<string> {
  const res = await fetchWithRetry(url, { method: 'GET' });
  if (!res.ok) {
    throw friendlyHttpError(res.status, await readErrorBody(res));
  }
  return await res.text();
}

export function assetUrlFromRef(ref: AssetRef): string {
  // ref.url is already /api/files/<name>(/view|/raw)?slug=...
  return ref.url;
}
