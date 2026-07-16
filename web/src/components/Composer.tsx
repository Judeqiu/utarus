/**
 * Composer — message input box at the bottom of the chat page.
 *
 * States:
 *  - idle: type + ↵ to send
 *  - streaming: input disabled, send button replaced with "■ stop"
 *
 * Slash commands (Slack-style):
 *  - Type `/` to open the command menu (framework + domain webCommands)
 *  - Filter as you type; ↑/↓ + Enter or click to pick; Esc to dismiss
 *  - /clear → clears agent context (client)
 *  - /help  → opens help modal (client)
 *  - domain /name args → sent to server, handled without the LLM
 *
 * Spec: docs/webui-chat-design.md §7.5, §9.
 */

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { CornerDownLeft, Square } from 'lucide-react';
import { listChatCommands, type WebCommandInfo } from '../api.js';

interface ComposerProps {
  isStreaming: boolean;
  agentName: string;
  onSend: (text: string, opts: { queue: boolean }) => void;
  onAbort: () => void;
  onClear: () => void;
  onHelp: () => void;
}

/**
 * Menu is open while the message is exactly `/` or `/partialName` (no args yet).
 * Once the user adds a space (`/status foo`), the menu closes — same as Slack.
 */
function slashQuery(text: string): string | null {
  const m = text.match(/^\/([a-z0-9_]*)$/i);
  if (!m) return null;
  return m[1]!.toLowerCase();
}

export function Composer({
  isStreaming,
  agentName,
  onSend,
  onAbort,
  onClear,
  onHelp,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [commands, setCommands] = useState<WebCommandInfo[] | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);

  const query = slashQuery(text);
  const showMenu = menuOpen && query !== null && !isStreaming;

  const filtered =
    query === null || commands === null
      ? []
      : commands.filter(
          (c) =>
            c.name.startsWith(query) ||
            c.description.toLowerCase().includes(query),
        );

  // Keep highlight in range when the filter changes.
  useEffect(() => {
    if (highlight >= filtered.length) {
      setHighlight(filtered.length > 0 ? filtered.length - 1 : 0);
    }
  }, [filtered.length, highlight]);

  // Scroll highlighted row into view.
  useEffect(() => {
    if (!showMenu || !menuRef.current) return;
    const el = menuRef.current.querySelector<HTMLElement>(
      `[data-cmd-index="${highlight}"]`,
    );
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlight, showMenu]);

  const ensureCommands = useCallback(async () => {
    if (commands !== null) return;
    try {
      const list = await listChatCommands();
      setCommands(list);
      setLoadError(null);
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : String(err));
      setCommands([]);
    }
  }, [commands]);

  useEffect(() => {
    if (query === null) {
      setMenuOpen(false);
      return;
    }
    setMenuOpen(true);
    void ensureCommands();
  }, [query, ensureCommands]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [text]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!isStreaming) {
      textareaRef.current?.focus();
    }
  }, [isStreaming]);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      const el = textareaRef.current;
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    };
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, []);

  function focusInput() {
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }

  function applyCommand(cmd: WebCommandInfo) {
    // Fill `/name ` so the user can add args (Slack-style).
    setText(`/${cmd.name} `);
    setMenuOpen(false);
    setHighlight(0);
    focusInput();
  }

  function submit() {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;
    if (trimmed === '/clear') {
      onClear();
      setText('');
      setMenuOpen(false);
      focusInput();
      return;
    }
    if (trimmed === '/help') {
      onHelp();
      setText('');
      setMenuOpen(false);
      focusInput();
      return;
    }
    onSend(trimmed, { queue: false });
    setText('');
    setMenuOpen(false);
    focusInput();
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (showMenu && filtered.length > 0) {
      applyCommand(filtered[highlight]!);
      return;
    }
    submit();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (showMenu && filtered.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((i) => (i + 1) % filtered.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((i) => (i - 1 + filtered.length) % filtered.length);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        applyCommand(filtered[highlight]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMenuOpen(false);
        return;
      }
      // Enter: form onSubmit selects the highlighted command while menu is open.
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (showMenu && filtered.length > 0) {
        applyCommand(filtered[highlight]!);
        return;
      }
      submit();
    }
  }

  function handleChange(value: string) {
    setText(value);
    if (slashQuery(value) !== null) {
      setMenuOpen(true);
      setHighlight(0);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="pb-safe border-t border-slate-200 bg-white px-3 py-2 sm:px-4 sm:py-3"
    >
      <div className="relative flex items-end gap-2">
        {showMenu && (
          <div
            className="absolute bottom-full left-0 right-12 z-20 mb-1 max-h-56 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg sm:right-24"
            role="listbox"
            aria-label="Slash commands"
          >
            <div className="border-b border-slate-100 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400">
              Commands
            </div>
            {commands === null && (
              <div className="px-3 py-3 text-xs text-slate-400">Loading…</div>
            )}
            {loadError && (
              <div className="px-3 py-3 text-xs text-rose-600">{loadError}</div>
            )}
            {commands !== null && !loadError && filtered.length === 0 && (
              <div className="px-3 py-3 text-xs text-slate-400">
                No matching commands
              </div>
            )}
            {filtered.length > 0 && (
              <ul ref={menuRef} className="max-h-44 overflow-y-auto py-1">
                {filtered.map((cmd, i) => {
                  const active = i === highlight;
                  return (
                    <li key={`${cmd.source}-${cmd.name}`}>
                      <button
                        type="button"
                        data-cmd-index={i}
                        role="option"
                        aria-selected={active}
                        onMouseEnter={() => setHighlight(i)}
                        onMouseDown={(e) => {
                          // Prevent textarea blur before click applies.
                          e.preventDefault();
                          applyCommand(cmd);
                        }}
                        className={
                          'flex w-full items-start gap-2 px-3 py-2 text-left text-sm ' +
                          (active ? 'bg-blue-50 text-slate-900' : 'text-slate-700 hover:bg-slate-50')
                        }
                      >
                        <code className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-800">
                          /{cmd.name}
                        </code>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs text-slate-600">
                            {cmd.description}
                            {cmd.adminOnly ? (
                              <span className="ml-1 text-amber-700">(admin)</span>
                            ) : null}
                          </span>
                          {cmd.usageHint ? (
                            <span className="block truncate text-[11px] text-slate-400">
                              /{cmd.name} {cmd.usageHint}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        <div className="flex-1">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder={
              isStreaming
                ? `${agentName} is replying…`
                : `Message ${agentName}…  (type / for commands)`
            }
            className={
              'w-full resize-none rounded-2xl border border-slate-300 px-3 py-2 text-sm placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 ' +
              (isStreaming ? 'bg-slate-50 text-slate-700' : '')
            }
          />
        </div>
        {isStreaming ? (
          <button
            type="button"
            onClick={onAbort}
            title="Stop"
            aria-label="Stop"
            className="inline-flex items-center gap-1 rounded-2xl bg-rose-600 px-3 py-2 text-sm font-medium text-white hover:bg-rose-700"
          >
            <Square className="h-4 w-4" /> <span className="hidden sm:inline">Stop</span>
          </button>
        ) : (
          <button
            type="submit"
            disabled={!text.trim()}
            title="Send"
            aria-label="Send"
            className="inline-flex items-center gap-1 rounded-2xl bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-slate-300"
          >
            <CornerDownLeft className="h-4 w-4" /> <span className="hidden sm:inline">Send</span>
          </button>
        )}
      </div>
      <div className="mt-1 hidden items-center justify-between text-[11px] text-slate-400 sm:flex">
        <span>
          <code className="rounded bg-slate-100 px-1 py-0.5">/</code> commands ·{' '}
          <code className="rounded bg-slate-100 px-1 py-0.5">shift+enter</code> for newline
        </span>
      </div>
    </form>
  );
}
