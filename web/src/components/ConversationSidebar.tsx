/**
 * StoreClaw-style left rail: serif brand wordmark, icon nav (New chat /
 * Commands / Admin), "Recents" conversation list, and a user footer with
 * avatar, password and logout actions. Drawer on mobile.
 */

import {
  CirclePlus,
  KeyRound,
  LogOut,
  MessageCircle,
  MessageSquarePlus,
  PanelLeft,
  PanelLeftClose,
  Settings,
  SquareSlash,
  Trash2,
  X,
} from 'lucide-react';
import type { ConversationSummary, SessionUser } from '../types.js';

interface ConversationSidebarProps {
  conversations: ConversationSummary[];
  activeId: string | null;
  collapsed: boolean;
  busy: boolean;
  mobileOpen: boolean;
  session: SessionUser;
  agentName: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onToggleCollapse: () => void;
  onCloseMobile: () => void;
  onLogout: () => void;
  onChangePassword: () => void;
  onHelp: () => void;
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

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return parts
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

export function ConversationSidebar({
  conversations,
  activeId,
  collapsed,
  busy,
  mobileOpen,
  session,
  agentName,
  onSelect,
  onNew,
  onDelete,
  onToggleCollapse,
  onCloseMobile,
  onLogout,
  onChangePassword,
  onHelp,
}: ConversationSidebarProps) {
  const bodyProps: SidebarBodyProps = {
    conversations,
    activeId,
    busy,
    session,
    agentName,
    onSelect,
    onNew,
    onDelete,
    onLogout,
    onChangePassword,
    onHelp,
  };

  // Mobile drawer takes priority over the desktop collapsed rail.
  if (mobileOpen) {
    return (
      <aside className="fixed inset-y-0 left-0 z-40 flex w-[85vw] max-w-xs flex-col bg-[#f7f5f2] pl-safe pt-safe shadow-xl sm:hidden">
        <SidebarBody
          {...bodyProps}
          headerAction={
            <button
              type="button"
              onClick={onCloseMobile}
              className="rounded-lg p-1.5 text-stone-500 hover:bg-stone-200"
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
      <aside className="hidden w-12 flex-col items-center gap-2 bg-[#f7f5f2] py-3 sm:flex">
        <button
          type="button"
          onClick={onToggleCollapse}
          className="rounded-lg p-2 text-stone-600 hover:bg-stone-200"
          title="Show chats"
          aria-label="Show chats"
        >
          <PanelLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onNew}
          className="rounded-lg p-2 text-stone-600 hover:bg-stone-200"
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
    <aside className="hidden w-64 shrink-0 flex-col bg-[#f7f5f2] sm:flex">
      <SidebarBody
        {...bodyProps}
        headerAction={
          <button
            type="button"
            onClick={onToggleCollapse}
            className="rounded-lg p-1.5 text-stone-500 hover:bg-stone-200"
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
  session: SessionUser;
  agentName: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onLogout: () => void;
  onChangePassword: () => void;
  onHelp: () => void;
  headerAction?: React.ReactNode;
  forceDeleteVisible?: boolean;
}

function SidebarBody({
  conversations,
  activeId,
  busy,
  session,
  agentName,
  onSelect,
  onNew,
  onDelete,
  onLogout,
  onChangePassword,
  onHelp,
  headerAction,
  forceDeleteVisible,
}: SidebarBodyProps) {
  return (
    <>
      {/* Brand wordmark */}
      <div className="flex items-center justify-between gap-2 px-4 pb-1 pt-4">
        <span className="truncate font-serif text-xl font-semibold text-stone-900">
          {agentName}
        </span>
        {headerAction}
      </div>

      {/* Primary nav */}
      <nav className="flex flex-col gap-0.5 px-2 pt-2">
        <button
          type="button"
          onClick={onNew}
          className="flex items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm text-stone-800 hover:bg-stone-200/70"
        >
          <CirclePlus className="h-4 w-4 shrink-0 text-stone-600" />
          New chat
        </button>
        <button
          type="button"
          onClick={onHelp}
          className="flex items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm text-stone-800 hover:bg-stone-200/70"
        >
          <SquareSlash className="h-4 w-4 shrink-0 text-stone-600" />
          Commands
        </button>
        {session.type === 'admin' && (
          <a
            href="/admin"
            className="flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm text-stone-800 hover:bg-stone-200/70"
          >
            <Settings className="h-4 w-4 shrink-0 text-stone-600" />
            Admin
          </a>
        )}
      </nav>

      {/* Recents */}
      <div className="mt-4 px-4 pb-1 text-[11px] font-medium uppercase tracking-wide text-stone-400">
        Recents
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {conversations.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-stone-500">
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
                      'group flex items-center gap-2 rounded-lg px-2 py-2 text-left transition ' +
                      (active ? 'bg-stone-200/70' : 'hover:bg-stone-200/50')
                    }
                  >
                    <MessageCircle className="h-4 w-4 shrink-0 text-stone-400" />
                    <button
                      type="button"
                      onClick={() => onSelect(c.id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="truncate text-sm text-stone-800">
                        {c.title || 'New chat'}
                      </div>
                      <div className="text-[10px] text-stone-400">
                        {formatWhen(c.updated_at)}
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(c.id);
                      }}
                      disabled={busy && active}
                      className={
                        'shrink-0 rounded p-1.5 text-stone-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-30 ' +
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

      {/* User footer */}
      <div className="flex items-center gap-2.5 border-t border-stone-200 px-3 py-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-stone-900 text-xs font-semibold text-white">
          {initials(session.displayName || session.slug)}
        </div>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-sm font-medium text-stone-900">
            {session.displayName}
          </div>
          <div className="truncate text-[11px] text-stone-400">{session.slug}</div>
        </div>
        {session.type === 'user' && (
          <button
            type="button"
            onClick={onChangePassword}
            className="rounded-lg p-1.5 text-stone-400 hover:bg-stone-200 hover:text-stone-700"
            title="Change password"
            aria-label="Change password"
          >
            <KeyRound className="h-4 w-4" />
          </button>
        )}
        <button
          type="button"
          onClick={onLogout}
          className="rounded-lg p-1.5 text-stone-400 hover:bg-stone-200 hover:text-stone-700"
          title="Logout"
          aria-label="Logout"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </>
  );
}
