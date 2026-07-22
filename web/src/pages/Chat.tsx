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
  CapExceededError,
  type WebCommandInfo,
} from '../api.js';
import { fetchAgentStatus, logout } from '../auth.js';
import type {
  AgentStatus,
  AssetRef,
  ChatAttachmentRef,
  ChatEvent,
  ChatMessage,
  ChatQuoteRef,
  ConversationSummary,
  SessionUser,
  ToolChip,
} from '../types.js';
import { ThreadView, type ChatEmptyStateView } from '../components/ThreadView.js';
import { Composer } from '../components/Composer.js';
import { ConversationSidebar } from '../components/ConversationSidebar.js';
import { AssetPanel } from '../components/AssetPanel.js';
import { WidgetPanelHost } from '../components/widgets/WidgetPanelHost.js';
import {
  AssetPanelContext,
  PanelContext,
  type PanelAsset,
  type PanelContent,
} from '../panel.js';
import {
  lastOpenInAssistantText,
  lastWidgetFenceInAssistantText,
  resolveWidgetInstance,
} from '../widgets/resolve-instance.js';
import { parseWidgetFenceBody, type WidgetSpec } from '../widgets/widget-spec.js';
import { Menu, Sparkles, X } from 'lucide-react';

interface ChatPageProps {
  session: SessionUser;
  /** Domain empty-chat guidance from WebUI manifest (Web only). */
  emptyState?: ChatEmptyStateView | null;
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
    quotes?: ChatQuoteRef[];
  }>,
): ChatMessage[] {
  return messages.map((m) => ({
    id: m.id,
    role: m.role,
    text: m.text,
    stopReason: m.stopReason,
    error: m.error,
    attachments: m.attachments,
    quotes: m.quotes,
    pending: false,
  }));
}

export function ChatPage({ session, emptyState = null }: ChatPageProps) {
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
  const [panelContent, setPanelContent] = useState<PanelContent | null>(null);
  const [pendingQuote, setPendingQuote] = useState<ChatQuoteRef | null>(null);
  /** Message ids known to exist on the server (conversation load + run ack swaps). */
  const [serverKnownMessageIds, setServerKnownMessageIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const currentRunController = useRef<AbortController | null>(null);
  const activeMessageId = useRef<string | null>(null);
  const toolMap = useRef<Map<string, ToolChip>>(new Map());
  const activeConvRef = useRef<string | null>(activeConversationId);
  /** Monotonic load generation — drop stale async loadConversation results. */
  const loadGenRef = useRef(0);

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

  /**
   * Drop the client SSE subscription without aborting the agent run.
   * Used when switching chats mid-stream so we can reattach later via replay.
   */
  function detachStreamUi() {
    const prev = currentRunController.current;
    // Clear refs before abort so onClose treats this as intentional.
    currentRunController.current = null;
    activeMessageId.current = null;
    toolMap.current.clear();
    prev?.abort();
  }

  function finalize() {
    setIsStreaming(false);
    currentRunController.current = null;
    activeMessageId.current = null;
    toolMap.current.clear();
  }

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
      case 'widget': {
        // Tool-success path: open side panel even when the model omits the fence.
        const parsed = parseWidgetFenceBody(ev.fence);
        if (!parsed.ok) {
          console.error(`[chat] invalid widget SSE fence: ${parsed.error}`);
          break;
        }
        setPanelContent({
          type: 'widget',
          spec: parsed.spec,
          contentEpoch: Date.now(),
        });
        setPanelAsset(null);
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
        // Panel widgets after this turn:
        // - action:open → open/replace panel (K8)
        // - action:update → auto-open if closed, or soft-refresh if same instance open
        //   so agent refinements (e.g. quoted title edit) show without clicking a card
        const openSpec = lastOpenInAssistantText(ev.text);
        const lastFence = lastWidgetFenceInAssistantText(ev.text);
        const epoch = Date.now();
        if (openSpec) {
          setPanelContent({ type: 'widget', spec: openSpec, contentEpoch: epoch });
          setPanelAsset(null);
        } else if (lastFence?.action === 'update') {
          setPanelContent({
            type: 'widget',
            spec: lastFence,
            contentEpoch: epoch,
          });
          setPanelAsset(null);
        }
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

  const handleEventRef = useRef(handleEvent);
  handleEventRef.current = handleEvent;

  /**
   * Subscribe to a run's SSE stream (fresh send or reattach after switch-back).
   * Replay from the registry restores tool chips, text, and work elapsed.
   */
  function attachToRun(messageId: string, assistantServerId: string) {
    activeMessageId.current = messageId;
    setIsStreaming(true);
    toolMap.current.clear();
    const controller = subscribeStream(messageId, undefined, {
      onEvent: (ev) => handleEventRef.current(assistantServerId, ev),
      onError: (err) => {
        // Ignore errors from a subscription we already replaced/detached.
        if (currentRunController.current !== controller) return;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantServerId
              ? {
                  ...m,
                  error: `Connection error: ${err.message}`,
                  pending: false,
                  streaming: false,
                }
              : m,
          ),
        );
        finalize();
      },
      onClose: () => {
        // Intentional detach (switch chat) clears activeMessageId first.
        if (activeMessageId.current !== messageId) return;
        if (currentRunController.current !== controller) return;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantServerId && (m.pending || m.streaming)
              ? {
                  ...m,
                  error:
                    m.error ??
                    'Stream closed before completion. Your last message may have been interrupted — please resend.',
                  pending: false,
                  streaming: false,
                }
              : m,
          ),
        );
        finalize();
      },
    });
    currentRunController.current = controller;
  }

  const loadConversation = useCallback(async (id: string) => {
    const gen = ++loadGenRef.current;
    // Leaving a streaming chat: keep the agent run; reattach if we return.
    detachStreamUi();
    setIsStreaming(false);

    const conv = await getConversation(id);
    if (gen !== loadGenRef.current) return;

    setActiveConversationId(conv.id);
    const ui = storedMessagesToUi(conv.messages);
    setServerKnownMessageIds(new Set(ui.map((m) => m.id)));
    setPendingQuote(null);
    toolMap.current.clear();

    const run = conv.activeRun;
    if (run) {
      // In-flight assistant is not on disk yet — synthesise the bubble and
      // reattach SSE (buffer replay restores deltas / tools / heartbeats).
      const streamingMsg: ChatMessage = {
        id: run.assistantMessageId,
        role: 'assistant',
        text: '',
        messageId: run.messageId,
        pending: true,
        streaming: true,
        startedAt: run.startedAt,
        tools: [],
      };
      setMessages([...ui, streamingMsg]);
      setServerKnownMessageIds((prev) => {
        const next = new Set(prev);
        next.add(run.assistantMessageId);
        return next;
      });
      attachToRun(run.messageId, run.assistantMessageId);
    } else {
      setMessages(ui);
    }
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
          setServerKnownMessageIds(new Set());
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
      // Detach SSE on unmount (agent keeps running; reattach on remount).
      detachStreamUi();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boot once
  }, []);

  const handleOpenWidget = useCallback(
    (spec: WidgetSpec) => {
      // Prefer latest resolved props from full thread for this instance.
      const resolved = resolveWidgetInstance(
        messages.map((m) => ({ role: m.role, text: m.text })),
        spec.instanceId,
      );
      const openSpec = resolved.ok ? resolved.spec : spec;
      setPanelContent({ type: 'widget', spec: openSpec });
      setPanelAsset(null);
    },
    [messages],
  );

  async function handleSend(
    text: string,
    opts: {
      queue: boolean;
      attachments?: ChatAttachmentRef[];
      quotes?: ChatQuoteRef[];
      widgetSubmit?: {
        instanceId: string;
        kind: string;
        revision: number;
        title?: string;
      };
    },
  ) {
    if (isStreaming) return;
    // Capture → clear immediately → restore only on throw (quote lifecycle).
    const quoteForSend = opts.quotes?.[0] ?? pendingQuote;
    setPendingQuote(null);

    const userMsg: ChatMessage = {
      id: newLocalId(),
      role: 'user',
      text,
      attachments: opts.attachments,
      quotes: quoteForSend ? [quoteForSend] : undefined,
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
    // Mark busy immediately so sidebar/composer stay consistent during POST.
    setIsStreaming(true);
    setMessages((prev) => [...prev, userMsg, assistantMsg]);

    try {
      const outcome = await sendMessage(text, {
        queue: opts.queue,
        conversationId: activeConversationId ?? undefined,
        attachments: opts.attachments,
        quotes: quoteForSend ? [quoteForSend] : undefined,
        widgetSubmit: opts.widgetSubmit,
      });
      if (outcome.kind === 'reply') {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id
              ? { ...m, text: outcome.text, pending: false, streaming: false }
              : m,
          ),
        );
        setIsStreaming(false);
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
        setIsStreaming(false);
        void refreshList();
        return;
      }
      // kind === 'run'
      const convId = outcome.conversationId ?? activeConversationId;
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
      const assistantServerId = outcome.assistantMessageId ?? assistantMsg.id;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsg.id
            ? {
                ...m,
                id: assistantServerId,
                messageId: serverMessageId,
              }
            : m,
        ),
      );
      // Mark server-acked message ids as quotable (not optimistic UUIDs).
      setServerKnownMessageIds((prev) => {
        const next = new Set(prev);
        if (outcome.userMessageId) next.add(outcome.userMessageId);
        if (outcome.assistantMessageId) next.add(outcome.assistantMessageId);
        return next;
      });
      void refreshList();
      if (!convId) {
        throw new Error('Missing conversationId for agent run.');
      }
      attachToRun(serverMessageId, assistantServerId);
    } catch (err: unknown) {
      setPendingQuote(quoteForSend); // restore chip for retry
      const msg = err instanceof Error ? err.message : String(err);
      const sessionLost =
        /session expired|unauthorized|log in again|401/i.test(msg);
      if (err instanceof CapExceededError) {
        const upgrade = err.upgradeUrl || '/billing';
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id
              ? {
                  ...m,
                  error: msg,
                  pending: false,
                  streaming: false,
                }
              : m,
          ),
        );
        setBanner(
          err.upgradeUrl
            ? `${msg} Open Billing (${upgrade}) to upgrade.`
            : msg,
        );
        finalize();
        return;
      }
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
    setPendingQuote(null);
    if (!activeConversationId) {
      setMessages([]);
      setServerKnownMessageIds(new Set());
      return;
    }
    try {
      await clearContext(activeConversationId);
      setMessages([]);
      setServerKnownMessageIds(new Set());
      toolMap.current.clear();
      void refreshList();
    } catch (err: unknown) {
      setBanner(`Clear failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleNewChat() {
    try {
      // Detach UI stream only — other chats may still be running on the server.
      detachStreamUi();
      setIsStreaming(false);
      const conv = await createConversation();
      setActiveConversationId(conv.id);
      setMessages([]);
      setServerKnownMessageIds(new Set());
      setPendingQuote(null);
      toolMap.current.clear();
      await refreshList();
      setSidebarMobileOpen(false);
    } catch (err: unknown) {
      setBanner(`New chat failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleSelectChat(id: string) {
    if (id === activeConversationId) {
      setSidebarMobileOpen(false);
      return;
    }
    try {
      // loadConversation detaches the current SSE UI and reattaches if the
      // target chat has an in-flight run (working section restored via replay).
      await loadConversation(id);
      setSidebarMobileOpen(false);
    } catch (err: unknown) {
      setBanner(`Load chat failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleDeleteChat(id: string) {
    // Don't delete the chat that currently has a live stream in this tab.
    if (isStreaming && id === activeConversationId) return;
    if (!window.confirm('Delete this chat permanently?')) return;
    try {
      await deleteConversation(id);
      const list = await refreshList();
      if (activeConversationId === id) {
        setPendingQuote(null);
        if (list.length > 0) {
          await loadConversation(list[0].id);
        } else {
          setActiveConversationId(null);
          setMessages([]);
          setServerKnownMessageIds(new Set());
        }
      }
    } catch (err: unknown) {
      setBanner(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function handleQuote(quote: ChatQuoteRef) {
    setPendingQuote(quote);
    setBanner(null);
  }

  function handleQuoteError(message: string) {
    setBanner(message);
  }

  /**
   * Rich-document Submit: document already saved to BinDrive. Post a user chat
   * turn so the agent loads state and continues (grade, review, next step).
   */
  async function handleDocumentSubmit(payload: {
    instanceId: string;
    kind: string;
    title: string;
    revision: number;
  }): Promise<void> {
    if (isStreaming) {
      throw new Error('Cannot submit while the agent is still responding');
    }
    const title = payload.title.trim() || 'Document';
    // User bubble: short label only. Agent gets instructions via widgetSubmit metadata.
    const text = `Submitted document: **${title}**`;
    await handleSend(text, {
      queue: false,
      widgetSubmit: {
        instanceId: payload.instanceId,
        kind: payload.kind,
        revision: payload.revision,
        title,
      },
    });
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

      <AssetPanelContext.Provider
        value={(asset) => {
          setPanelAsset(asset);
          if (asset) {
            setPanelContent({
              type: 'file',
              url: asset.url,
              filename: asset.filename,
              kind: asset.kind,
            });
          } else if (panelContent?.type === 'file') {
            setPanelContent(null);
          }
        }}
      >
        <PanelContext.Provider value={setPanelContent}>
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
              onHelp={() => {
                setPendingQuote(null);
                setShowHelp(true);
              }}
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
                conversationId={activeConversationId}
                serverKnownMessageIds={serverKnownMessageIds}
                emptyState={emptyState}
                onStarter={(message) => {
                  if (isStreaming) return;
                  handleSend(message, { queue: false });
                }}
                onQuote={handleQuote}
                onQuoteError={handleQuoteError}
                onOpenWidget={handleOpenWidget}
              />

              <Composer
                isStreaming={isStreaming}
                agentName={agentName}
                imageInputEnabled={imageInputEnabled}
                pendingQuote={pendingQuote}
                onClearQuote={() => setPendingQuote(null)}
                onSend={handleSend}
                onAbort={handleAbort}
                onClear={handleClear}
                onHelp={() => {
                  setPendingQuote(null);
                  setShowHelp(true);
                }}
              />
            </div>

            {panelContent?.type === 'widget' ? (
              <WidgetPanelHost
                spec={panelContent.spec}
                contentEpoch={panelContent.contentEpoch}
                conversationId={activeConversationId}
                onClose={() => {
                  setPanelContent(null);
                  setPanelAsset(null);
                }}
                onQuote={handleQuote}
                onQuoteError={handleQuoteError}
                onDocumentSubmit={handleDocumentSubmit}
                onArtifactMessage={(msg) => {
                  setMessages((prev) => {
                    if (prev.some((m) => m.id === msg.id)) return prev;
                    return [
                      ...prev,
                      {
                        id: msg.id,
                        role: msg.role,
                        text: msg.text,
                        stopReason: msg.stopReason,
                      },
                    ];
                  });
                  setServerKnownMessageIds((prev) => {
                    const next = new Set(prev);
                    next.add(msg.id);
                    return next;
                  });
                }}
              />
            ) : panelContent?.type === 'file' || panelAsset ? (
              <AssetPanel
                asset={
                  panelContent?.type === 'file'
                    ? {
                        url: panelContent.url,
                        filename: panelContent.filename,
                        kind: panelContent.kind,
                      }
                    : panelAsset!
                }
                viewerSlug={session.slug}
                onClose={() => {
                  setPanelContent(null);
                  setPanelAsset(null);
                }}
              />
            ) : null}
          </div>
        </PanelContext.Provider>
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
