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
}

export interface AgentStatus {
  slug: string;
  displayName: string;
  /** Framework agent display name (UTARUS_AGENT_NAME). */
  agentName: string;
  isStreaming: boolean;
  hasContext: boolean;
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
