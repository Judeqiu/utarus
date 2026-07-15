/**
 * Persist WebUI conversations under data/chats/<slug>/.
 *
 * Atomic writes via temp file + rename. No caching (project rule).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { resolveDataRoot } from '../../config.js';
import type {
  Conversation,
  ConversationIndex,
  ConversationSummary,
  StoredChatMessage,
} from './conversation-types.js';

const TITLE_MAX = 60;
const PREVIEW_MAX = 120;

function chatsRoot(): string {
  return join(resolveDataRoot(), 'chats');
}

function userDir(slug: string): string {
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`Invalid chat slug: ${JSON.stringify(slug)}`);
  }
  return join(chatsRoot(), slug);
}

function indexPath(slug: string): string {
  return join(userDir(slug), 'index.json');
}

function convPath(slug: string, id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error(`Invalid conversation id: ${JSON.stringify(id)}`);
  }
  return join(userDir(slug), `${id}.json`);
}

function ensureUserDir(slug: string): void {
  const dir = userDir(slug);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path);
}

function readJsonFile<T>(path: string): T {
  if (!existsSync(path)) {
    throw new Error(`Chat file not found: ${path}`);
  }
  const raw = readFileSync(path, 'utf-8');
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    throw new Error(
      `Corrupt chat JSON at ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function emptyIndex(): ConversationIndex {
  return { conversations: [] };
}

function loadIndex(slug: string): ConversationIndex {
  const path = indexPath(slug);
  if (!existsSync(path)) {
    return emptyIndex();
  }
  const idx = readJsonFile<ConversationIndex>(path);
  if (!idx || !Array.isArray(idx.conversations)) {
    throw new Error(`Invalid conversation index for slug=${slug}`);
  }
  return idx;
}

function saveIndex(slug: string, idx: ConversationIndex): void {
  ensureUserDir(slug);
  writeJsonAtomic(indexPath(slug), idx);
}

function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + '…';
}

/**
 * Strip domain enrichMessage / channel-hint prefixes that were historically
 * stored on user turns. Display and titles must show only what the human typed.
 * Pattern: one or more leading `[...]` blocks, then a blank line, then the user text.
 */
export function stripAgentContextPrefix(text: string): string {
  if (!text) return text;
  // Fast path: pure user text
  if (!text.startsWith('[')) return text;
  // Prefer last blank-line-separated segment when the first is a bracketed block
  const parts = text.split(/\n\n+/);
  if (parts.length >= 2 && parts[0].trimStart().startsWith('[')) {
    const last = parts[parts.length - 1].trim();
    if (last && !last.startsWith('[')) return last;
  }
  return text;
}

function titleFromText(text: string): string {
  const clean = stripAgentContextPrefix(text);
  const line = clean.split('\n').find((l) => l.trim()) ?? clean;
  return truncate(line, TITLE_MAX) || 'New chat';
}

function previewFromMessages(messages: StoredChatMessage[]): string {
  if (messages.length === 0) return '';
  const last = messages[messages.length - 1];
  const body = last.role === 'user' ? stripAgentContextPrefix(last.text) : last.text;
  return truncate(body, PREVIEW_MAX);
}

function toSummary(c: Conversation): ConversationSummary {
  return {
    id: c.id,
    title: c.title,
    created_at: c.created_at,
    updated_at: c.updated_at,
    message_count: c.messages.length,
    preview: previewFromMessages(c.messages),
  };
}

function upsertIndexEntry(slug: string, summary: ConversationSummary): void {
  const idx = loadIndex(slug);
  const i = idx.conversations.findIndex((c) => c.id === summary.id);
  if (i >= 0) {
    idx.conversations[i] = summary;
  } else {
    idx.conversations.unshift(summary);
  }
  // Newest first
  idx.conversations.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  saveIndex(slug, idx);
}

function removeIndexEntry(slug: string, id: string): void {
  const idx = loadIndex(slug);
  idx.conversations = idx.conversations.filter((c) => c.id !== id);
  saveIndex(slug, idx);
}

/** List conversations for a user (newest first). */
export function listConversations(slug: string): ConversationSummary[] {
  ensureUserDir(slug);
  return loadIndex(slug).conversations.map((s) => {
    if (!s.title.startsWith('[') && !s.preview.startsWith('[')) return s;
    try {
      const client = getConversationForClient(slug, s.id);
      return {
        ...s,
        title: client.title,
        preview: previewFromMessages(client.messages),
      };
    } catch {
      return s;
    }
  });
}

/** Create an empty conversation. */
export function createConversation(
  slug: string,
  opts?: { title?: string },
): Conversation {
  ensureUserDir(slug);
  const now = new Date().toISOString();
  const conv: Conversation = {
    id: randomUUID(),
    slug,
    title: opts?.title?.trim() || 'New chat',
    created_at: now,
    updated_at: now,
    messages: [],
  };
  writeJsonAtomic(convPath(slug, conv.id), conv);
  upsertIndexEntry(slug, toSummary(conv));
  return conv;
}

/** Load a conversation; throws if missing or wrong owner. */
export function getConversation(slug: string, id: string): Conversation {
  const path = convPath(slug, id);
  if (!existsSync(path)) {
    throw new Error(`Conversation not found: ${id}`);
  }
  const c = readJsonFile<Conversation>(path);
  if (c.slug !== slug) {
    throw new Error(`Conversation ${id} does not belong to slug=${slug}`);
  }
  if (!Array.isArray(c.messages)) {
    throw new Error(`Conversation ${id} has invalid messages array`);
  }
  return c;
}

/**
 * Conversation for the WebUI: user bubbles show only human-typed text
 * (legacy rows that stored enrichMessage context are cleaned for display).
 * Agent hydration should use getConversation (raw) so history stays complete.
 */
export function getConversationForClient(slug: string, id: string): Conversation {
  const c = getConversation(slug, id);
  const messages = c.messages.map((m) =>
    m.role === 'user'
      ? { ...m, text: stripAgentContextPrefix(m.text) }
      : m,
  );
  let title = c.title;
  if (title.startsWith('[')) {
    const firstUser = messages.find((m) => m.role === 'user');
    if (firstUser?.text) title = titleFromText(firstUser.text);
  }
  return { ...c, title, messages };
}

/** Rename a conversation (user or AI). */
export function renameConversation(
  slug: string,
  id: string,
  title: string,
  source: 'user' | 'ai' | 'auto' = 'user',
): Conversation {
  const trimmed = title.trim();
  if (!trimmed) {
    throw new Error('title required');
  }
  if (trimmed.length > TITLE_MAX * 2) {
    throw new Error(`title too long (max ${TITLE_MAX * 2})`);
  }
  const c = getConversation(slug, id);
  c.title = truncate(trimmed, TITLE_MAX * 2);
  c.title_source = source;
  c.updated_at = new Date().toISOString();
  writeJsonAtomic(convPath(slug, id), c);
  upsertIndexEntry(slug, toSummary(c));
  return c;
}

/** True when this conversation still needs an AI-generated title. */
export function needsAiTitle(slug: string, id: string): boolean {
  const c = getConversation(slug, id);
  if (c.title_source === 'ai' || c.title_source === 'user') return false;
  const users = c.messages.filter((m) => m.role === 'user');
  const assistants = c.messages.filter((m) => m.role === 'assistant' && m.text.trim());
  return users.length >= 1 && assistants.length >= 1;
}

/** Delete conversation file + index entry. */
export function deleteConversation(slug: string, id: string): void {
  const path = convPath(slug, id);
  if (!existsSync(path)) {
    throw new Error(`Conversation not found: ${id}`);
  }
  unlinkSync(path);
  removeIndexEntry(slug, id);
}

/**
 * Append a message and update title (first user message) + index.
 * Returns the updated conversation.
 */
export function appendMessage(
  slug: string,
  id: string,
  message: Omit<StoredChatMessage, 'id' | 'created_at'> & {
    id?: string;
    created_at?: string;
  },
): Conversation {
  const c = getConversation(slug, id);
  const msg: StoredChatMessage = {
    id: message.id ?? randomUUID(),
    role: message.role,
    text: message.text,
    created_at: message.created_at ?? new Date().toISOString(),
    stopReason: message.stopReason,
    error: message.error,
    tools: message.tools,
  };
  if (msg.role !== 'user' && msg.role !== 'assistant') {
    throw new Error(`Invalid message role: ${String(msg.role)}`);
  }
  if (typeof msg.text !== 'string') {
    throw new Error('message.text must be a string');
  }

  // Temporary title from first user message (AI summary replaces it after first reply)
  if (
    msg.role === 'user' &&
    c.messages.filter((m) => m.role === 'user').length === 0 &&
    (c.title === 'New chat' || !c.title) &&
    c.title_source !== 'ai' &&
    c.title_source !== 'user'
  ) {
    c.title = titleFromText(msg.text);
    c.title_source = 'auto';
  }

  c.messages.push(msg);
  c.updated_at = new Date().toISOString();
  writeJsonAtomic(convPath(slug, id), c);
  upsertIndexEntry(slug, toSummary(c));
  return c;
}

/** Replace all messages (e.g. clear conversation thread). Keeps the conversation id. */
export function clearConversationMessages(slug: string, id: string): Conversation {
  const c = getConversation(slug, id);
  c.messages = [];
  c.updated_at = new Date().toISOString();
  writeJsonAtomic(convPath(slug, id), c);
  upsertIndexEntry(slug, toSummary(c));
  return c;
}

/**
 * Repair index by scanning conversation files (fail-fast if a file is corrupt).
 * Used only when index is missing but files exist.
 */
export function rebuildIndex(slug: string): ConversationSummary[] {
  ensureUserDir(slug);
  const dir = userDir(slug);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json');
  const summaries: ConversationSummary[] = [];
  for (const f of files) {
    const id = f.replace(/\.json$/, '');
    const c = getConversation(slug, id);
    summaries.push(toSummary(c));
  }
  summaries.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  saveIndex(slug, { conversations: summaries });
  return summaries;
}
