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
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { AlertCircle, ArrowUp, ImagePlus, Loader2, Plus, Square, X } from 'lucide-react';
import { listChatCommands, uploadChatAttachment, type WebCommandInfo } from '../api.js';
import type { ChatAttachmentRef, ChatQuoteRef } from '../types.js';
import { QuoteChip } from './QuoteChip.js';

interface ComposerProps {
  isStreaming: boolean;
  agentName: string;
  /** Show the photo attach button — bound to the LLM's imageInput capability
   *  reported by the server (false for text-only models, e.g. DeepSeek). */
  imageInputEnabled?: boolean;
  /** Controlled pending quote (lifted in Chat.tsx). */
  pendingQuote?: ChatQuoteRef | null;
  onClearQuote?: () => void;
  onSend: (
    text: string,
    opts: {
      queue: boolean;
      attachments?: ChatAttachmentRef[];
      quotes?: ChatQuoteRef[];
    },
  ) => void;
  onAbort: () => void;
  onClear: () => void;
  onHelp: () => void;
}

const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_ATTACHMENTS = 4;
const MAX_DIM = 1568;
const MAX_BYTES = 5 * 1024 * 1024;
const SKIP_DIM = 1024;
const SKIP_BYTES = 300 * 1024;

interface PendingAttachment {
  localId: string;
  name: string;
  previewUrl: string;
  uploading: boolean;
  uploaded?: ChatAttachmentRef;
  error?: string;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Downscale for upload: cap the long edge at 1568px and re-encode as JPEG
 * q0.85. Small files (≤1024px long edge and ≤300KB) go through unchanged.
 * Throws when the result still exceeds the 5MB server limit.
 */
async function prepareImage(
  file: File,
): Promise<{ dataBase64: string; mimeType: string }> {
  const bitmap = await createImageBitmap(file);
  const longEdge = Math.max(bitmap.width, bitmap.height);
  if (longEdge <= SKIP_DIM && file.size <= SKIP_BYTES) {
    bitmap.close();
    return { dataBase64: await blobToBase64(file), mimeType: file.type };
  }
  const scale = Math.min(1, MAX_DIM / longEdge);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(`${file.name}: canvas unavailable.`);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((r) =>
    canvas.toBlob(r, 'image/jpeg', 0.85),
  );
  if (!blob) throw new Error(`${file.name}: could not re-encode image.`);
  if (blob.size > MAX_BYTES) {
    throw new Error(`${file.name} is still over 5MB after resizing.`);
  }
  return { dataBase64: await blobToBase64(blob), mimeType: 'image/jpeg' };
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
  imageInputEnabled = false,
  pendingQuote = null,
  onClearQuote,
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
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const anyUploading = attachments.some((a) => a.uploading);

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

  function removeAttachment(localId: string) {
    setAttachments((prev) => {
      const item = prev.find((a) => a.localId === localId);
      if (item) URL.revokeObjectURL(item.previewUrl);
      return prev.filter((a) => a.localId !== localId);
    });
  }

  function clearAttachments() {
    setAttachments((prev) => {
      for (const a of prev) URL.revokeObjectURL(a.previewUrl);
      return [];
    });
  }

  async function handleFiles(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    setAttachError(null);
    const room = Math.max(0, MAX_ATTACHMENTS - attachments.length);
    if (files.length > room) {
      setAttachError(`Up to ${MAX_ATTACHMENTS} images per message.`);
    }
    for (const file of files.slice(0, room)) {
      if (!IMAGE_MIMES.includes(file.type)) {
        setAttachError(`${file.name}: only JPEG, PNG, WebP or GIF images.`);
        continue;
      }
      const localId = crypto.randomUUID();
      setAttachments((prev) => [
        ...prev,
        {
          localId,
          name: file.name,
          previewUrl: URL.createObjectURL(file),
          uploading: true,
        },
      ]);
      let prepared: { dataBase64: string; mimeType: string };
      try {
        prepared = await prepareImage(file);
      } catch (err: unknown) {
        removeAttachment(localId);
        setAttachError(err instanceof Error ? err.message : String(err));
        continue;
      }
      try {
        const up = await uploadChatAttachment({
          name: file.name,
          mimeType: prepared.mimeType,
          dataBase64: prepared.dataBase64,
        });
        setAttachments((prev) =>
          prev.map((a) =>
            a.localId === localId
              ? {
                  ...a,
                  uploading: false,
                  uploaded: { id: up.id, name: up.name, mimeType: up.mimeType },
                }
              : a,
          ),
        );
      } catch (err: unknown) {
        setAttachments((prev) =>
          prev.map((a) =>
            a.localId === localId
              ? {
                  ...a,
                  uploading: false,
                  error: err instanceof Error ? err.message : String(err),
                }
              : a,
          ),
        );
      }
    }
  }

  function submit() {
    const trimmed = text.trim();
    if (!trimmed || isStreaming || anyUploading) return;
    if (trimmed === '/clear') {
      onClearQuote?.();
      onClear();
      setText('');
      setMenuOpen(false);
      focusInput();
      return;
    }
    if (trimmed === '/help') {
      onClearQuote?.();
      onHelp();
      setText('');
      setMenuOpen(false);
      focusInput();
      return;
    }
    const ready = attachments
      .map((a) => a.uploaded)
      .filter((a): a is ChatAttachmentRef => a !== undefined);
    onSend(trimmed, {
      queue: false,
      attachments: ready.length > 0 ? ready : undefined,
      quotes: pendingQuote ? [pendingQuote] : undefined,
    });
    setText('');
    clearAttachments();
    setAttachError(null);
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
          {pendingQuote && (
            <div className="px-3 pt-3">
              <QuoteChip quote={pendingQuote} onRemove={onClearQuote} />
            </div>
          )}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pt-3">
              {attachments.map((a) => (
                <div key={a.localId} className="relative" title={a.error ?? a.name}>
                  <img
                    src={a.previewUrl}
                    alt={a.name}
                    className={
                      'h-16 w-16 rounded-lg border object-cover ' +
                      (a.error
                        ? 'border-rose-300 opacity-60'
                        : 'border-stone-200' + (a.uploading ? ' opacity-50' : ''))
                    }
                  />
                  {a.uploading && (
                    <Loader2 className="absolute inset-0 m-auto h-4 w-4 animate-spin text-stone-600" />
                  )}
                  {a.error && (
                    <AlertCircle className="absolute inset-0 m-auto h-4 w-4 text-rose-600" />
                  )}
                  <button
                    type="button"
                    onClick={() => removeAttachment(a.localId)}
                    title={a.error ? 'Dismiss' : 'Remove'}
                    aria-label={`Remove ${a.name}`}
                    className="absolute -right-1.5 -top-1.5 rounded-full bg-stone-900 p-0.5 text-white hover:bg-stone-700"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
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
            <div className="flex items-center">
              <button
                type="button"
                onClick={openSlashMenu}
                title="Commands"
                aria-label="Open commands"
                className="rounded-full p-2 text-stone-500 hover:bg-stone-100 hover:text-stone-800"
              >
                <Plus className="h-4 w-4" />
              </button>
              {imageInputEnabled && (
                <>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    title="Attach images"
                    aria-label="Attach images"
                    className="rounded-full p-2 text-stone-500 hover:bg-stone-100 hover:text-stone-800"
                  >
                    <ImagePlus className="h-4 w-4" />
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    multiple
                    onChange={(e) => void handleFiles(e)}
                    className="hidden"
                    tabIndex={-1}
                    aria-hidden="true"
                  />
                </>
              )}
            </div>
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
                disabled={!text.trim() || anyUploading}
                title={anyUploading ? 'Uploading images…' : 'Send'}
                aria-label="Send"
                className="rounded-full bg-stone-900 p-2 text-white hover:bg-stone-700 disabled:bg-stone-300"
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {attachError && (
          <div className="mt-1 px-2 text-xs text-rose-600">{attachError}</div>
        )}

        <div className="mt-1.5 text-center text-[11px] text-stone-400">
          {agentName} can make mistakes. Check important info.
        </div>
      </div>
    </form>
  );
}
