/**
 * Shared types for the WebUI chat layer.
 * See docs/webui-chat-design.md §6 (protocol) and §8 (assets).
 *
 * Note: we model `WebAgent` as a structural type rather than importing the
 * canonical `Agent` from `@earendil-works/pi-agent-core`. The framework
 * re-exports the same runtime object, but TypeScript can resolve two
 * physically-distinct copies of pi-agent-core under a `file:` link, causing
 * "private property _state" assignability errors. The structural type is
 * the minimal surface the chat layer actually uses.
 */

export interface WebAgentState {
  isStreaming?: boolean;
  errorMessage?: string;
  messages?: unknown[];
}

/** Mirror of pi-ai's ImageContent (structural — see header note). */
export interface WebImageContent {
  type: 'image';
  /** base64-encoded image bytes. */
  data: string;
  mimeType: string;
}

export interface WebAgent {
  subscribe(handler: (event: any) => void): () => void;
  prompt(message: string, images?: WebImageContent[]): void;
  /** Steer signature is intentionally permissive — the canonical AgentMessage
   *  type carries extra optional fields (customType, display) we don't set. */
  steer(input: unknown): void;
  abort(): void;
  waitForIdle(): Promise<void>;
  state: WebAgentState;
}

export type AssetKind =
  | 'html'
  | 'pdf'
  | 'image'
  | 'video'
  | 'audio'
  | 'csv'
  | 'json'
  | 'text'
  | 'unknown';

export interface AssetRef {
  kind: AssetKind;
  url: string;
  filename: string;
  ownerSlug: string;
}

export type ChatEvent =
  | { type: 'ack'; messageId: string; slug: string; agentName: string }
  | { type: 'tool_start'; toolCallId: string; name: string; startedAt: number }
  | { type: 'tool_end'; toolCallId: string; ok: boolean; durationMs: number }
  /**
   * Successful show_widget / update_widget — fence body (no outer ```).
   * Client opens the side panel even if the model forgets to paste the fence.
   */
  | { type: 'widget'; fence: string }
  | { type: 'delta'; text: string; cumulative: string }
  | { type: 'heartbeat'; elapsedMs: number; activeTools: string[] }
  | { type: 'done'; text: string; stopReason: string; assets: AssetRef[] }
  | {
      type: 'error';
      message: string;
      phase: 'pre_run' | 'during_run' | 'watchdog' | 'disconnected';
    }
  | { type: 'cap'; message: string; current: number; cap: number }
  /** AI-generated conversation title (sidebar + browser tab). */
  | { type: 'title'; conversationId: string; title: string }
  | { type: 'end' };

/**
 * In-memory state for a single agent run. One entry per messageId in the
 * stream registry. Evicted 5 min after the run terminates.
 */
export interface RunState {
  messageId: string;
  /** Conversation this run belongs to (for reattach after chat switch). */
  conversationId: string;
  /** Server UUID of the in-flight assistant message (not yet on disk until done). */
  assistantMessageId: string;
  userSlug: string;
  isAdmin: boolean;
  agent: WebAgent;
  startedAt: number;
  /** Ring buffer of events for SSE replay on reconnect. */
  bufferedEvents: ChatEvent[];
  /** Live subscriber push; null when no SSE client is connected. */
  subscriber: ((event: ChatEvent) => void) | null;
  /** True once `done` / `error` / `cap` has fired. */
  ended: boolean;
  /** Eviction timer set when the run terminates. */
  evictionTimeout?: NodeJS.Timeout;
}

/** Live run metadata returned with GET /conversations/:id for SSE reattach. */
export interface ActiveRunInfo {
  messageId: string;
  assistantMessageId: string;
  startedAt: number;
}

export type SendMessageResponse =
  | { kind: 'run'; messageId: string }
  | { kind: 'queued' }
  | { kind: 'reply'; text: string };
