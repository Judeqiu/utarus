/**
 * Claude-style conversation list (left rail on desktop, drawer on mobile).
 */

import { MessageSquarePlus, Trash2, PanelLeftClose, PanelLeft, X } from 'lucide-react';
import type { ConversationSummary } from '../types.js';

interface ConversationSidebarProps {
  conversations: ConversationSummary[];
  activeId: string | null;
  collapsed: boolean;
  busy: boolean;
  mobileOpen: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onToggleCollapse: () => void;
  onCloseMobile: () => void;
}

function formatWhen(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function ConversationSidebar({
  conversations,
  activeId,
  collapsed,
  busy,
  mobileOpen,
  onSelect,
  onNew,
  onDelete,
  onToggleCollapse,
  onCloseMobile,
}: ConversationSidebarProps) {
  // Mobile drawer takes priority over the desktop collapsed rail.
  if (mobileOpen) {
    return (
      <aside className="fixed inset-y-0 left-0 z-40 flex w-[85vw] max-w-xs flex-col bg-slate-100 pl-safe pt-safe shadow-xl sm:hidden">
        <SidebarBody
          conversations={conversations}
          activeId={activeId}
          busy={busy}
          onSelect={onSelect}
          onNew={onNew}
          onDelete={onDelete}
          headerAction={
            <button
              type="button"
              onClick={onCloseMobile}
              className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-200"
              title="Close"
              aria-label="Close chats"
            >
              <X className="h-4 w-4" />
            </button>
          }
          forceDeleteVisible
        />
      </aside>
    );
  }

  // Desktop collapsed rail — hidden on mobile (drawer used instead).
  if (collapsed) {
    return (
      <aside className="hidden w-12 flex-col items-center gap-2 border-r border-slate-200 bg-slate-100 py-3 sm:flex">
        <button
          type="button"
          onClick={onToggleCollapse}
          className="rounded-lg p-2 text-slate-600 hover:bg-slate-200"
          title="Show chats"
          aria-label="Show chats"
        >
          <PanelLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onNew}
          disabled={busy}
          className="rounded-lg p-2 text-slate-600 hover:bg-slate-200 disabled:opacity-40"
          title="New chat"
          aria-label="New chat"
        >
          <MessageSquarePlus className="h-4 w-4" />
        </button>
      </aside>
    );
  }

  // Desktop expanded rail — hidden on mobile.
  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-slate-200 bg-slate-100 sm:flex">
      <SidebarBody
        conversations={conversations}
        activeId={activeId}
        busy={busy}
        onSelect={onSelect}
        onNew={onNew}
        onDelete={onDelete}
        headerAction={
          <button
            type="button"
            onClick={onToggleCollapse}
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-200"
            title="Hide sidebar"
            aria-label="Hide sidebar"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        }
      />
    </aside>
  );
}

interface SidebarBodyProps {
  conversations: ConversationSummary[];
  activeId: string | null;
  busy: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  headerAction: React.ReactNode;
  forceDeleteVisible?: boolean;
}

function SidebarBody({
  conversations,
  activeId,
  busy,
  onSelect,
  onNew,
  onDelete,
  headerAction,
  forceDeleteVisible,
}: SidebarBodyProps) {
  return (
    <>
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Chats
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onNew}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:bg-slate-300"
            title="New chat"
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
            New
          </button>
          {headerAction}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {conversations.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-slate-500">
            No chats yet. Send a message to start.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {conversations.map((c) => {
              const active = c.id === activeId;
              return (
                <li key={c.id}>
                  <div
                    className={
                      'group flex items-start gap-1 rounded-lg px-2 py-2 text-left transition ' +
                      (active
                        ? 'bg-white shadow-sm ring-1 ring-slate-200'
                        : 'hover:bg-slate-200/70')
                    }
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(c.id)}
                      disabled={busy && !active}
                      className="min-w-0 flex-1 text-left disabled:opacity-50"
                    >
                      <div className="truncate text-sm font-medium text-slate-900">
                        {c.title || 'New chat'}
                      </div>
                      <div className="mt-0.5 flex items-center justify-between gap-2">
                        <span className="truncate text-[11px] text-slate-500">
                          {c.preview || 'Empty'}
                        </span>
                        <span className="shrink-0 text-[10px] text-slate-400">
                          {formatWhen(c.updated_at)}
                        </span>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(c.id);
                      }}
                      disabled={busy}
                      className={
                        'mt-0.5 shrink-0 rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-30 ' +
                        (forceDeleteVisible ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')
                      }
                      title="Delete chat"
                      aria-label="Delete chat"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}
