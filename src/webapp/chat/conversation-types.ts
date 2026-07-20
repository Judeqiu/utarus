/**
 * Server-side WebUI conversation model (Claude-style multi-chat).
 *
 * On-disk layout (under UTARUS_DATA_ROOT):
 *   data/chats/<slug>/index.json          — ConversationSummary[]
 *   data/chats/<slug>/<conversationId>.json — Conversation (with messages)
 *
 * Fail-fast: missing/corrupt files throw; callers map to HTTP errors.
 */

export interface ConversationSummary {
  id: string;
  title: string;
  created_at: string; // ISO-8601
  updated_at: string; // ISO-8601
  message_count: number;
  /** First ~120 chars of the latest message for the sidebar preview. */
  preview: string;
}

export type StoredMessageRole = 'user' | 'assistant';

/** Photo attached to a user message (file lives in data/chats/<slug>/attachments/). */
export interface StoredAttachment {
  id: string;
  name: string;
  mimeType: string;
}

/**
 * Quote reference attached to a user message (ChatGPT-style selection).
 * - Chat message quote: `source` omitted or `'message'`; `messageId` is a conversation message UUID; `role` is user|assistant.
 * - Widget quote: `source: 'widget'`; `messageId` is the widget **instanceId** (UUID); `role` is `'widget'`.
 */
export interface StoredQuote {
  messageId: string;
  role: StoredMessageRole | 'widget';
  text: string;
  /** Defaults to message when omitted (back-compat). */
  source?: 'message' | 'widget';
  /** Present when source is widget. */
  widgetKind?: string;
  widgetTitle?: string;
}

/** LLM route that produced an assistant turn (audit / hydrate). */
export interface StoredMessageLlm {
  profile: string;
  provider: string;
  model: string;
  reason?: string;
}

/**
 * Rich-document (or other widget) Submit — agent-only metadata.
 * User bubble shows only `StoredChatMessage.text` (short label);
 * agent prompt is rebuilt via formatWidgetSubmitForAgent on send/hydrate.
 */
export interface StoredWidgetSubmit {
  instanceId: string;
  kind: string;
  revision: number;
  title?: string;
}

export interface StoredChatMessage {
  id: string;
  role: StoredMessageRole;
  text: string;
  created_at: string; // ISO-8601
  stopReason?: string;
  error?: string;
  attachments?: StoredAttachment[];
  /** Present on user turns when the client quoted a prior message span. */
  quotes?: StoredQuote[];
  /** Present on user turns when the client submitted a side-panel document. */
  widgetSubmit?: StoredWidgetSubmit;
  /** Present on assistant turns after multi-LLM routing. */
  llm?: StoredMessageLlm;
  tools?: Array<{
    toolCallId: string;
    name: string;
    ok?: boolean;
    durationMs?: number;
  }>;
}

export interface Conversation {
  id: string;
  /** Owner slug — must match directory name. */
  slug: string;
  title: string;
  /**
   * How the title was set:
   * - undefined / 'auto' — first-user-message heuristic
   * - 'ai' — LLM summary (do not overwrite unless user renames)
   * - 'user' — explicit rename via PATCH
   */
  title_source?: 'auto' | 'ai' | 'user';
  created_at: string;
  updated_at: string;
  messages: StoredChatMessage[];
}

export interface ConversationIndex {
  conversations: ConversationSummary[];
}
