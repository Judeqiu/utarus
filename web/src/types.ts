/**
 * Shared types — mirror docs/webui-chat-design.md §6 (protocol) and §8 (assets).
 * Keep in sync with src/webapp/chat/types.ts on the backend.
 */

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
  | { type: 'delta'; text: string; cumulative: string }
  | { type: 'heartbeat'; elapsedMs: number; activeTools: string[] }
  | { type: 'done'; text: string; stopReason: string; assets: AssetRef[] }
  | {
      type: 'error';
      message: string;
      phase: 'pre_run' | 'during_run' | 'watchdog' | 'disconnected';
    }
  | { type: 'cap'; message: string; current: number; cap: number }
  | { type: 'title'; conversationId: string; title: string }
  | { type: 'end' };

export interface ToolChip {
  toolCallId: string;
  name: string;
  startedAt: number;
  endedAt?: boolean;
  ok?: boolean;
  durationMs?: number;
}

export interface ChatMessage {
  /** Client-generated UUID; not the server messageId. */
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Present when an assistant message is tied to a server run. */
  messageId?: string;
  tools?: ToolChip[];
  assets?: AssetRef[];
  stopReason?: string;
  error?: string;
  pending?: boolean;
  streamedAt?: number;
  /** True while the assistant run is in flight (until done/error/cap). */
  streaming?: boolean;
  /** Client timestamp when the run started (drives the elapsed timer). */
  startedAt?: number;
  /** Server-reported elapsed time from heartbeat events (reconnect-safe). */
  workElapsedMs?: number;
}

export interface AgentStatus {
  slug: string;
  displayName: string;
  /** Framework agent display name (UTARUS_AGENT_NAME). */
  agentName: string;
  /** Utarus framework package version (e.g. 0.2.0). */
  version: string;
  isStreaming: boolean;
  hasContext: boolean;
  conversationId?: string | null;
}

/** Sidebar list item (server ConversationSummary). */
export interface ConversationSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  preview: string;
}

export interface ConversationDetail {
  id: string;
  slug: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    text: string;
    created_at: string;
    stopReason?: string;
    error?: string;
  }>;
}

export interface SessionUser {
  type: 'user' | 'admin';
  slug: string;
  displayName: string;
}

export interface InviteCode {
  code: string;
  created_at: string;
  comment?: string;
  created_by?: number;
  created_by_slack?: string;
  created_via_web?: string;
  used_by?: number;
  used_by_slack?: string;
  used_at?: string;
  slug?: string;
}

export interface AdminUserSummary {
  slug: string;
  displayName: string;
  createdAt: string;
}
