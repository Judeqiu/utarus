/**
 * Chat — main page with StoreClaw-style sidebar (brand, nav, recents, user
 * footer) + thread.
 *
 * Conversations are server-persisted (data/chats/<slug>/). Refresh reloads
 * the list and the active conversation's messages.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  abortRun,
  changePassword,
  clearContext,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  listChatCommands,
  sendMessage,
  subscribeStream,
  type WebCommandInfo,
} from '../api.js';
import { fetchAgentStatus, logout } from '../auth.js';
import type {
  AgentStatus,
  AssetRef,
  ChatAttachmentRef,
  ChatEvent,
  ChatMessage,
  ConversationSummary,
  SessionUser,
  ToolChip,
} from '../types.js';
import { ThreadView } from '../components/ThreadView.js';
import { Composer } from '../components/Composer.js';
import { ConversationSidebar } from '../components/ConversationSidebar.js';
import { AssetPanel } from '../components/AssetPanel.js';
import { AssetPanelContext, type PanelAsset } from '../panel.js';
import { Menu, Sparkles, X } from 'lucide-react';

interface ChatPageProps {
  session: SessionUser;
}

const ACTIVE_CONV_KEY = 'utarus_active_conversation';

function newLocalId(): string {
  return crypto.randomUUID();
}

function storedMessagesToUi(
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    text: string;
    stopReason?: string;
    error?: string;
    attachments?: ChatAttachmentRef[];
  }>,
): ChatMessage[] {
  return messages.map((m) => ({
    id: m.id,
    role: m.role,
    text: m.text,
    stopReason: m.stopReason,
    error: m.error,
    attachments: m.attachments,
    pending: false,
  }));
}

export function ChatPage({ session }: ChatPageProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    () => localStorage.getItem(ACTIVE_CONV_KEY),
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarMobileOpen, setSidebarMobileOpen] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [banner, setBanner] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [agentName, setAgentName] = useState('Agent');
  const [version, setVersion] = useState<string | null>(null);
  // Photo attach button is hidden until the server reports the LLM can see.
  const [imageInputEnabled, setImageInputEnabled] = useState(false);
  const [bootLoading, setBootLoading] = useState(true);
  const [panelAsset, setPanelAsset] = useState<PanelAsset | null>(null);
  const currentRunController = useRef<AbortController | null>(null);
  const activeMessageId = useRef<string | null>(null);
  const toolMap = useRef<Map<string, ToolChip>>(new Map());
  const activeConvRef = useRef<string | null>(activeConversationId);

  useEffect(() => {
    activeConvRef.current = activeConversationId;
    if (activeConversationId) {
      localStorage.setItem(ACTIVE_CONV_KEY, activeConversationId);
    } else {
      localStorage.removeItem(ACTIVE_CONV_KEY);
    }
  }, [activeConversationId]);

  // Browser tab: "Chat title · Agent" (or just agent when no chat)
  useEffect(() => {
    const active = conversations.find((c) => c.id === activeConversationId);
    const chatTitle = active?.title?.trim();
    if (chatTitle && chatTitle !== 'New chat') {
      document.title = `${chatTitle} · ${agentName}`;
    } else {
      document.title = `${agentName} · Chat`;
    }
  }, [agentName, activeConversationId, conversations]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const refreshList = useCallback(async () => {
    const list = await listConversations();
    setConversations(list);
    return list;
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    const conv = await getConversation(id);
    setActiveConversationId(conv.id);
    setMessages(storedMessagesToUi(conv.messages));
    toolMap.current.clear();
  }, []);

  // Boot: agent status + conversation list + restore active chat
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status: AgentStatus = await fetchAgentStatus();
        if (cancelled) return;
        if (status.agentName) setAgentName(status.agentName);
        if (status.version) setVersion(status.version);
        setImageInputEnabled(status.capabilities?.imageInput === true);
        if (status.isStreaming) {
          setBanner(
            `An agent run is already in progress. Wait for it to finish, then continue.`,
          );
        }

        const list = await listConversations();
        if (cancelled) return;
        setConversations(list);

        const preferred = activeConversationId;
        if (preferred && list.some((c) => c.id === preferred)) {
          await loadConversation(preferred);
        } else if (list.length > 0) {
          await loadConversation(list[0].id);
        } else {
          setActiveConversationId(null);
          setMessages([]);
        }
      } catch (err: unknown) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.toLowerCase().includes('unauthorized')) {
          setBanner(`Failed to load chats: ${msg}`);
        }
      } finally {
        if (!cancelled) setBootLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boot once
  }, []);

  const handleEvent = useCallback((assistantId: string, ev: ChatEvent) => {
    switch (ev.type) {
      case 'ack':
        break;
      case 'tool_start': {
        const chip: ToolChip = {
          toolCallId: ev.toolCallId,
          name: ev.name,
          startedAt: ev.startedAt,
        };
        toolMap.current.set(ev.toolCallId, chip);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, tools: uniqTools([...(m.tools ?? []), chip]) }
              : m,
          ),
        );
        break;
      }
      case 'tool_end': {
        const prev = toolMap.current.get(ev.toolCallId);
        if (!prev) break;
        const updated: ToolChip = {
          ...prev,
          endedAt: true,
          ok: ev.ok,
          durationMs: ev.durationMs,
        };
        toolMap.current.set(ev.toolCallId, updated);
        setMessages((prevMsgs) =>
          prevMsgs.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  tools: (m.tools ?? []).map((t) =>
                    t.toolCallId === ev.toolCallId ? updated : t,
                  ),
                }
              : m,
          ),
        );
        break;
      }
      case 'delta': {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, text: ev.cumulative, pending: false }
              : m,
          ),
        );
        break;
      }
      case 'heartbeat':
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, workElapsedMs: ev.elapsedMs } : m,
          ),
        );
        break;
      case 'title': {
        setConversations((prev) => {
          const next = prev.map((c) =>
            c.id === ev.conversationId ? { ...c, title: ev.title } : c,
          );
          // Keep active chat at top after AI rename
          return [...next].sort((a, b) =>
            a.updated_at < b.updated_at ? 1 : -1,
          );
        });
        void refreshList();
        break;
      }
      case 'done': {
        const assets: AssetRef[] = ev.assets;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  text: ev.text,
                  assets,
                  stopReason: ev.stopReason,
                  pending: false,
                  streaming: false,
                }
              : m,
          ),
        );
        void refreshList();
        finalize();
        break;
      }
      case 'error': {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  error: `${ev.message} (phase: ${ev.phase})`,
                  pending: false,
                  streaming: false,
                }
              : m,
          ),
        );
        void refreshList();
        finalize();
        break;
      }
      case 'cap': {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  error: `${ev.message} (used ${ev.current}/${ev.cap})`,
                  pending: false,
                  streaming: false,
                }
              : m,
          ),
        );
        finalize();
        break;
      }
      case 'end':
        finalize();
        break;
    }
  }, [refreshList]);

  function finalize() {
    setIsStreaming(false);
    currentRunController.current = null;
    activeMessageId.current = null;
    toolMap.current.clear();
  }

  async function handleSend(
    text: string,
    opts: { queue: boolean; attachments?: ChatAttachmentRef[] },
  ) {
    if (isStreaming) return;
    const userMsg: ChatMessage = {
      id: newLocalId(),
      role: 'user',
      text,
      attachments: opts.attachments,
    };
    const assistantMsg: ChatMessage = {
      id: newLocalId(),
      role: 'assistant',
      text: '',
      pending: true,
      streaming: true,
      startedAt: Date.now(),
      tools: [],
    };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);

    try {
      const outcome = await sendMessage(text, {
        queue: opts.queue,
        conversationId: activeConversationId ?? undefined,
        attachments: opts.attachments,
      });
      if (outcome.kind === 'reply') {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id
              ? { ...m, text: outcome.text, pending: false, streaming: false }
              : m,
          ),
        );
        return;
      }
      if (outcome.kind === 'queued') {
        if (outcome.conversationId) {
          setActiveConversationId(outcome.conversationId);
        }
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id
              ? {
                  ...m,
                  text: '_(queued — will be picked up after the current run)_',
                  pending: false,
                  streaming: false,
                }
              : m,
          ),
        );
        void refreshList();
        return;
      }
      // kind === 'run'
      if (outcome.conversationId) {
        setActiveConversationId(outcome.conversationId);
      }
      if (outcome.userMessageId) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === userMsg.id ? { ...m, id: outcome.userMessageId! } : m,
          ),
        );
      }
      const serverMessageId = outcome.messageId;
      activeMessageId.current = serverMessageId;
      setIsStreaming(true);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsg.id
            ? {
                ...m,
                id: outcome.assistantMessageId ?? m.id,
                messageId: serverMessageId,
              }
            : m,
        ),
      );
      void refreshList();
      const controller = subscribeStream(serverMessageId, undefined, {
        onEvent: (ev) =>
          handleEvent(outcome.assistantMessageId ?? assistantMsg.id, ev),
        onError: (err) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === (outcome.assistantMessageId ?? assistantMsg.id)
                ? { ...m, error: `Connection error: ${err.message}`, pending: false, streaming: false }
                : m,
            ),
          );
          finalize();
        },
        onClose: () => {
          if (activeMessageId.current === serverMessageId) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === (outcome.assistantMessageId ?? assistantMsg.id) && m.pending
                  ? {
                      ...m,
                      error:
                        'Stream closed before completion. Your last message may have been interrupted — please resend.',
                      pending: false,
                      streaming: false,
                    }
                  : m,
              ),
            );
            finalize();
          }
        },
      });
      currentRunController.current = controller;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const sessionLost =
        /session expired|unauthorized|log in again|401/i.test(msg);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsg.id
            ? { ...m, error: `Send failed: ${msg}`, pending: false, streaming: false }
            : m,
        ),
      );
      if (sessionLost) {
        setBanner(`${msg} Refresh the page or log in again.`);
      }
      finalize();
    }
  }

  async function handleAbort() {
    try {
      await abortRun(activeConversationId ?? undefined);
    } catch (err: unknown) {
      setBanner(`Abort failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    currentRunController.current?.abort();
  }

  async function handleClear() {
    if (!activeConversationId) {
      setMessages([]);
      return;
    }
    try {
      await clearContext(activeConversationId);
      setMessages([]);
      toolMap.current.clear();
      void refreshList();
    } catch (err: unknown) {
      setBanner(`Clear failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleNewChat() {
    if (isStreaming) return;
    try {
      const conv = await createConversation();
      setActiveConversationId(conv.id);
      setMessages([]);
      toolMap.current.clear();
      await refreshList();
      setSidebarMobileOpen(false);
    } catch (err: unknown) {
      setBanner(`New chat failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleSelectChat(id: string) {
    if (isStreaming) {
      setBanner('Wait for the current reply to finish before switching chats.');
      return;
    }
    if (id === activeConversationId) {
      setSidebarMobileOpen(false);
      return;
    }
    try {
      await loadConversation(id);
      setSidebarMobileOpen(false);
    } catch (err: unknown) {
      setBanner(`Load chat failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleDeleteChat(id: string) {
    if (isStreaming) return;
    if (!window.confirm('Delete this chat permanently?')) return;
    try {
      await deleteConversation(id);
      const list = await refreshList();
      if (activeConversationId === id) {
        if (list.length > 0) {
          await loadConversation(list[0].id);
        } else {
          setActiveConversationId(null);
          setMessages([]);
        }
      }
    } catch (err: unknown) {
      setBanner(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (bootLoading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-white text-sm text-stone-500">
        Loading chats…
      </div>
    );
  }

  const activeConversation = conversations.find((c) => c.id === activeConversationId);
  const headerTitle = activeConversation?.title?.trim() || 'New chat';

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <header className="flex items-center justify-between gap-2 px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setSidebarMobileOpen(true)}
            className="-ml-1 rounded-lg p-2 text-stone-600 hover:bg-stone-100 sm:hidden"
            aria-label="Open chats"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="truncate text-sm font-medium text-stone-900">
            {headerTitle}
          </div>
        </div>
        {version && (
          <span
            className="hidden shrink-0 rounded-md border border-stone-200 bg-stone-50 px-1.5 py-0.5 font-mono text-[10px] text-stone-500 sm:inline"
            title="Utarus framework version"
          >
            v{version}
          </span>
        )}
      </header>

      {banner && (
        <div className="flex items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 sm:px-4">
          <span className="min-w-0 truncate">{banner}</span>
          <button
            type="button"
            onClick={() => setBanner(null)}
            className="shrink-0 rounded p-1 text-amber-700 hover:text-amber-900"
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <AssetPanelContext.Provider value={setPanelAsset}>
        <div className="relative flex min-h-0 flex-1">
          <ConversationSidebar
            conversations={conversations}
            activeId={activeConversationId}
            collapsed={sidebarCollapsed}
            busy={isStreaming}
            mobileOpen={sidebarMobileOpen}
            session={session}
            agentName={agentName}
            onSelect={(id) => void handleSelectChat(id)}
            onNew={() => void handleNewChat()}
            onDelete={(id) => void handleDeleteChat(id)}
            onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
            onCloseMobile={() => setSidebarMobileOpen(false)}
            onLogout={() => void logout()}
            onChangePassword={() => setShowChangePassword(true)}
            onHelp={() => setShowHelp(true)}
          />

          {sidebarMobileOpen && (
            <button
              type="button"
              onClick={() => setSidebarMobileOpen(false)}
              className="fixed inset-0 z-30 bg-black/40 sm:hidden"
              aria-label="Close chats"
            />
          )}

          <div className="flex min-w-0 flex-1 flex-col">
            <ThreadView
              messages={messages}
              viewerSlug={session.slug}
              now={now}
              agentName={agentName}
            />

            <Composer
              isStreaming={isStreaming}
              agentName={agentName}
              imageInputEnabled={imageInputEnabled}
              onSend={handleSend}
              onAbort={handleAbort}
              onClear={handleClear}
              onHelp={() => setShowHelp(true)}
            />
          </div>

          {panelAsset && (
            <AssetPanel
              asset={panelAsset}
              viewerSlug={session.slug}
              onClose={() => setPanelAsset(null)}
            />
          )}
        </div>
      </AssetPanelContext.Provider>

      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}

      {showChangePassword && (
        <ChangePasswordModal onClose={() => setShowChangePassword(false)} />
      )}
    </div>
  );
}

function uniqTools(chips: ToolChip[]): ToolChip[] {
  const map = new Map<string, ToolChip>();
  for (const c of chips) map.set(c.toolCallId, c);
  return [...map.values()];
}

function HelpModal({ onClose }: { onClose: () => void }) {
  const [commands, setCommands] = useState<WebCommandInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listChatCommands()
      .then((list) => {
        if (!cancelled) setCommands(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setCommands([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const framework = (commands ?? []).filter((c) => c.source === 'framework');
  const domain = (commands ?? []).filter((c) => c.source === 'domain');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-stone-900">Commands</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <ul className="space-y-2 text-sm text-stone-700">
          <li>
            <strong>New chat</strong> — start a separate conversation (sidebar).
          </li>
          {commands === null && !error && (
            <li className="text-xs text-stone-400">Loading commands…</li>
          )}
          {error && (
            <li className="text-xs text-rose-600">{error}</li>
          )}
          {framework.map((c) => (
            <li key={`fw-${c.name}`}>
              <code className="rounded bg-stone-100 px-1 py-0.5">/{c.name}</code>
              {c.usageHint ? (
                <span className="text-stone-500"> {c.usageHint}</span>
              ) : null}
              {' — '}
              {c.description}
            </li>
          ))}
          {domain.length > 0 && (
            <li className="pt-1 text-xs font-semibold uppercase tracking-wide text-stone-500">
              Domain
            </li>
          )}
          {domain.map((c) => (
            <li key={`dom-${c.name}`}>
              <code className="rounded bg-stone-100 px-1 py-0.5">/{c.name}</code>
              {c.usageHint ? (
                <span className="text-stone-500"> {c.usageHint}</span>
              ) : null}
              {c.adminOnly ? (
                <span className="ml-1 text-xs text-amber-700">(admin)</span>
              ) : null}
              {' — '}
              {c.description}
            </li>
          ))}
          <li className="text-xs text-stone-500">
            Chats are saved on the server. Refresh keeps history. Domain agents
            register extra commands via <code className="rounded bg-stone-100 px-1">webCommands</code>.
          </li>
        </ul>
      </div>
    </div>
  );
}

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (newPassword.length < 6) {
        throw new Error('Password must be at least 6 characters.');
      }
      if (newPassword !== confirm) {
        throw new Error('Passwords do not match.');
      }
      await changePassword(newPassword);
      setDone(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-stone-900">Change password</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {done ? (
          <div className="space-y-3">
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              Password updated. Use the new password next time you sign in.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-lg bg-stone-900 px-3 py-2 text-sm font-medium text-white hover:bg-stone-700"
            >
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-stone-600">
                New password (≥6 chars)
              </span>
              <input
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-stone-500 focus:outline-none focus:ring-1 focus:ring-stone-500"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-stone-600">
                Confirm new password
              </span>
              <input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-stone-500 focus:outline-none focus:ring-1 focus:ring-stone-500"
              />
            </label>
            {error && (
              <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-stone-900 px-3 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:bg-stone-300"
            >
              {busy && <Sparkles className="h-4 w-4 animate-spin" />}
              Update password
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
