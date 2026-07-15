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

export interface StoredChatMessage {
  id: string;
  role: StoredMessageRole;
  text: string;
  created_at: string; // ISO-8601
  stopReason?: string;
  error?: string;
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
  created_at: string;
  updated_at: string;
  messages: StoredChatMessage[];
}

export interface ConversationIndex {
  conversations: ConversationSummary[];
}
