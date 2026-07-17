/**
 * Composer — message input box at the bottom of the chat page.
 *
 * StoreClaw-style pill: one rounded container holding the textarea and a
 * bottom row with a "+" button (opens the slash-command menu) and a black
 * circular send/stop button. A disclaimer line sits centered below.
 *
 * States:
 *  - idle: type + ↵ to send
 *  - streaming: send button replaced with stop
 *
 * Slash commands (Slack-style):
 *  - Type `/` (or press "+") to open the command menu (framework + domain webCommands)
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
import { ArrowUp, Plus, Square } from 'lucide-react';
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

  function openSlashMenu() {
    setText('/');
    setMenuOpen(true);
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
      className="pb-safe bg-white px-3 pb-2 pt-1 sm:px-4"
    >
      <div className="relative mx-auto max-w-3xl">
        {showMenu && (
          <div
            className="absolute bottom-full left-0 right-0 z-20 mb-2 max-h-56 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-lg"
            role="listbox"
            aria-label="Slash commands"
          >
            <div className="border-b border-stone-100 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-stone-400">
              Commands
            </div>
            {commands === null && (
              <div className="px-3 py-3 text-xs text-stone-400">Loading…</div>
            )}
            {loadError && (
              <div className="px-3 py-3 text-xs text-rose-600">{loadError}</div>
            )}
            {commands !== null && !loadError && filtered.length === 0 && (
              <div className="px-3 py-3 text-xs text-stone-400">
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
                          (active ? 'bg-stone-100 text-stone-900' : 'text-stone-700 hover:bg-stone-50')
                        }
                      >
                        <code className="shrink-0 rounded bg-stone-100 px-1.5 py-0.5 font-mono text-xs text-stone-800">
                          /{cmd.name}
                        </code>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs text-stone-600">
                            {cmd.description}
                            {cmd.adminOnly ? (
                              <span className="ml-1 text-amber-700">(admin)</span>
                            ) : null}
                          </span>
                          {cmd.usageHint ? (
                            <span className="block truncate text-[11px] text-stone-400">
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

        <div className="rounded-[28px] border border-stone-200 bg-white shadow-sm transition focus-within:border-stone-400">
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
            className="w-full resize-none rounded-t-[28px] bg-transparent px-4 pb-1 pt-3.5 text-sm text-stone-900 placeholder:text-stone-400 focus:outline-none"
          />
          <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
            <button
              type="button"
              onClick={openSlashMenu}
              title="Commands"
              aria-label="Open commands"
              className="rounded-full p-2 text-stone-500 hover:bg-stone-100 hover:text-stone-800"
            >
              <Plus className="h-4 w-4" />
            </button>
            {isStreaming ? (
              <button
                type="button"
                onClick={onAbort}
                title="Stop"
                aria-label="Stop"
                className="rounded-full bg-stone-900 p-2 text-white hover:bg-stone-700"
              >
                <Square className="h-4 w-4" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!text.trim()}
                title="Send"
                aria-label="Send"
                className="rounded-full bg-stone-900 p-2 text-white hover:bg-stone-700 disabled:bg-stone-300"
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        <div className="mt-1.5 text-center text-[11px] text-stone-400">
          {agentName} can make mistakes. Check important info.
        </div>
      </div>
    </form>
  );
}
