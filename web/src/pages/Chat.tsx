/**
 * Chat — the main chat page.
 *
 * Owns:
 *   - the message list (local React state, fresh per page load per Phase-1
 *     design §4.5)
 *   - the SSE subscription (subscribeStream from api.ts)
 *   - the send/abort/clear flow
 *   - a 1-second ticker to keep active tool-chip durations live
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  abortRun,
  changePassword,
  clearContext,
  sendMessage,
  subscribeStream,
} from '../api.js';
import { fetchAgentStatus, logout } from '../auth.js';
import type {
  AgentStatus,
  AssetRef,
  ChatEvent,
  ChatMessage,
  SessionUser,
  ToolChip,
} from '../types.js';
import { ThreadView } from '../components/ThreadView.js';
import { Composer } from '../components/Composer.js';
import { KeyRound, LogOut, Settings, Sparkles, X } from 'lucide-react';

interface ChatPageProps {
  session: SessionUser;
}

function newLocalId(): string {
  return crypto.randomUUID();
}

export function ChatPage({ session }: ChatPageProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [banner, setBanner] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [agentName, setAgentName] = useState('Agent');
  const [version, setVersion] = useState<string | null>(null);
  const currentRunController = useRef<AbortController | null>(null);
  const activeMessageId = useRef<string | null>(null);
  const toolMap = useRef<Map<string, ToolChip>>(new Map());

  // 1-second ticker so active tool-chip durations tick.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // On mount, fetch agent status — if a run is already live (page refresh
  // mid-run), tell the user to refresh or wait.
  useEffect(() => {
    let cancelled = false;
    fetchAgentStatus()
      .then((status: AgentStatus) => {
        if (cancelled) return;
        if (status.agentName) setAgentName(status.agentName);
        if (status.version) setVersion(status.version);
        if (status.isStreaming) {
          setBanner(
            `An agent run is already in progress for "${status.displayName}". It started before this page loaded — its output won't appear here. Wait for it to finish, then resend.`,
          );
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // 401 → parent will redirect to login. Other errors surface as banner.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.toLowerCase().includes('unauthorized')) {
          setBanner(`Agent status check failed: ${msg}`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleEvent = useCallback(
    (assistantId: string, ev: ChatEvent) => {
      switch (ev.type) {
        case 'ack':
          // The server confirmed the run started; nothing to mutate yet
          // because the user-side optimistic message already has the
          // messageId attached via the run outcome.
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
          setMessages((prev) =>
            prev.map((m) =>
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
          // could surface elapsedMs; we tick the chip durations locally.
          break;
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
                  }
                : m,
            ),
          );
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
                  }
                : m,
            ),
          );
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
    },
    [],
  );

  function finalize() {
    setIsStreaming(false);
    currentRunController.current = null;
    activeMessageId.current = null;
    toolMap.current.clear();
  }

  async function handleSend(text: string, opts: { queue: boolean }) {
    if (isStreaming) return;
    const userMsg: ChatMessage = {
      id: newLocalId(),
      role: 'user',
      text,
    };
    const assistantMsg: ChatMessage = {
      id: newLocalId(),
      role: 'assistant',
      text: '',
      pending: true,
      tools: [],
    };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);

    try {
      const outcome = await sendMessage(text, opts);
      if (outcome.kind === 'reply') {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id
              ? { ...m, text: outcome.text, pending: false }
              : m,
          ),
        );
        return;
      }
      if (outcome.kind === 'queued') {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id
              ? { ...m, text: '_(queued — will be picked up after the current run)_', pending: false }
              : m,
          ),
        );
        return;
      }
      // kind === 'run'
      const serverMessageId = outcome.messageId;
      activeMessageId.current = serverMessageId;
      setIsStreaming(true);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsg.id ? { ...m, messageId: serverMessageId } : m,
        ),
      );
      const controller = subscribeStream(serverMessageId, undefined, {
        onEvent: (ev) => handleEvent(assistantMsg.id, ev),
        onError: (err) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsg.id
                ? { ...m, error: `Connection error: ${err.message}`, pending: false }
                : m,
            ),
          );
          finalize();
        },
        onClose: () => {
          // Stream closed — if still streaming, surface a disconnection.
          if (activeMessageId.current === serverMessageId) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsg.id && m.pending
                  ? {
                      ...m,
                      error: 'Stream closed before completion. Your last message may have been interrupted — please resend.',
                      pending: false,
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
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsg.id
            ? { ...m, error: `Send failed: ${msg}`, pending: false }
            : m,
        ),
      );
      finalize();
    }
  }

  async function handleAbort() {
    try {
      await abortRun();
    } catch (err: unknown) {
      setBanner(`Abort failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    currentRunController.current?.abort();
  }

  async function handleClear() {
    try {
      await clearContext();
      setMessages([]);
      toolMap.current.clear();
    } catch (err: unknown) {
      setBanner(`Clear failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <div className="flex h-screen flex-col bg-slate-50">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2.5">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600 text-white">
            <Sparkles className="h-4 w-4" />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold text-slate-900">
              {agentName} · {session.displayName}
            </div>
            <div className="text-[11px] text-slate-500">
              slug: <code className="rounded bg-slate-100 px-1 py-0.5">{session.slug}</code>
              {version && (
                <>
                  {' '}
                  · v{version}
                </>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {version && (
            <span
              className="hidden sm:inline rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] text-slate-500"
              title="Utarus framework version"
            >
              v{version}
            </span>
          )}
          {session.type === 'admin' && (
            <a
              href="/admin"
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
            >
              <Settings className="h-3 w-3" /> Admin
            </a>
          )}
          {session.type === 'user' && (
            <button
              type="button"
              onClick={() => setShowChangePassword(true)}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
            >
              <KeyRound className="h-3 w-3" /> Password
            </button>
          )}
          <button
            type="button"
            onClick={() => void logout()}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
          >
            <LogOut className="h-3 w-3" /> Logout
          </button>
        </div>
      </header>

      {banner && (
        <div className="flex items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
          <span>{banner}</span>
          <button
            type="button"
            onClick={() => setBanner(null)}
            className="text-amber-700 hover:text-amber-900"
            aria-label="Dismiss"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      <ThreadView
        messages={messages}
        viewerSlug={session.slug}
        now={now}
        agentName={agentName}
      />

      <Composer
        isStreaming={isStreaming}
        agentName={agentName}
        onSend={handleSend}
        onAbort={handleAbort}
        onClear={handleClear}
        onHelp={() => setShowHelp(true)}
      />

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
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900">Commands</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <ul className="space-y-2 text-sm text-slate-700">
          <li>
            <code className="rounded bg-slate-100 px-1 py-0.5">/clear</code> — reset the agent's
            conversation context (your portfolio/playbook are not affected).
          </li>
          <li>
            <code className="rounded bg-slate-100 px-1 py-0.5">/help</code> — show this message.
          </li>
          <li className="text-xs text-slate-500">
            Standard markdown is supported in replies: tables, code blocks, lists, images.
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
          <h2 className="text-base font-semibold text-slate-900">Change password</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
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
              className="w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-600">
                New password (≥6 chars)
              </span>
              <input
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-600">
                Confirm new password
              </span>
              <input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
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
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-slate-300"
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
