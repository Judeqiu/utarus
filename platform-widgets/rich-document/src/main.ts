/**
 * Platform rich-document guest — classic IIFE entry (esbuild bundles this).
 * Bridge: utarus-widget. Durable body: Markdown in state.data.
 */

import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PmNode } from '@tiptap/pm/model';
import { marked } from 'marked';
import TurndownService from 'turndown';

const CHANNEL = 'utarus-widget';
const FORMAT = 'utarus-rich-document-v1';
/** Mirror web QUOTE_TEXT_MAX / server quotes.ts */
const QUOTE_TEXT_MAX = 2000;

const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/

type Theme = { colorScheme: 'light' | 'dark' };

type DocComment = {
  id: string;
  body: string;
  quote?: string;
  author: 'agent' | 'user';
  createdAt: string;
};

let instanceId: string | null = null;
let revision = 0;
let readySent = false;
let dirty = false;
let mode: 'edit' | 'view' = 'edit';
let editor: Editor | null = null;
/** Durable comments layer — not part of markdown. */
let comments: DocComment[] = [];

const statusEl = document.getElementById('status');
const errEl = document.getElementById('err');
const dirtyEl = document.getElementById('dirty');
const toolbarEl = document.getElementById('toolbar');
const saveBtn = document.getElementById('saveBtn') as HTMLButtonElement | null;
const submitBtn = document.getElementById('submitBtn') as HTMLButtonElement | null;
const editorEl = document.getElementById('editor');
const exportBar = document.getElementById('exportBar');
const exportDocxBtn = document.getElementById('exportDocx') as HTMLButtonElement | null;
const exportPdfBtn = document.getElementById('exportPdf') as HTMLButtonElement | null;
const quoteToolbar = document.getElementById('quoteToolbar');
const quoteBtn = document.getElementById('quoteBtn') as HTMLButtonElement | null;
const commentsPane = document.getElementById('commentsPane');
const commentsList = document.getElementById('commentsList');
const commentsCount = document.getElementById('commentsCount');
const commentsExpandBtn = document.getElementById(
  'commentsExpandBtn',
) as HTMLButtonElement | null;
const commentsRailBadge = document.getElementById('commentsRailBadge');

/** Panel title from last init (for export filenames). */
let documentTitle = 'Document';
let exporting = false;
/** After successful save, notify host to post a chat turn for the agent. */
let pendingSubmit = false;
let allowSubmit = true;
let submitLabel = 'Submit';
/** Frozen selection text for Quote action (pointerdown preventDefault collapses selection otherwise). */
let pendingQuoteText: string | null = null;
/** Session UI: comments rail shrunk to sidebar strip (still has comments). */
let commentsCollapsed = false;

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
  strongDelimiter: '**',
});
// Drop images (not supported in v1)
turndown.addRule('noImages', {
  filter: 'img',
  replacement: () => '',
});

function setStatus(t: string): void {
  if (statusEl) statusEl.textContent = t;
}

function setError(t: string | null): void {
  if (!errEl) return;
  if (!t) {
    errEl.hidden = true;
    errEl.textContent = '';
    return;
  }
  errEl.hidden = false;
  errEl.textContent = t;
}

function setDirty(v: boolean): void {
  dirty = v;
  if (dirtyEl) dirtyEl.hidden = !v;
}

function post(msg: Record<string, unknown>): void {
  if (!window.parent || window.parent === window) return;
  window.parent.postMessage(msg, '*');
}

function sendReady(): void {
  if (readySent || !instanceId) return;
  readySent = true;
  post({ channel: CHANNEL, type: 'ready', instanceId });
  setStatus(`ready · rev ${revision}${mode === 'view' ? ' · view' : ''}`);
}

function markdownToHtml(md: string): string {
  marked.setOptions({ gfm: true, breaks: false });
  // marked returns string when async:false (default in v15 for sync API)
  const html = marked.parse(md, { async: false }) as string;
  return html || '<p></p>';
}

function htmlToMarkdown(html: string): string {
  return turndown.turndown(html).trimEnd() + (html.trim() ? '\n' : '');
}

function validateMarkdown(md: string): string | null {
  if (CONTROL_CHARS.test(md)) {
    return 'markdown contains control characters';
  }
  return null;
}

function currentMarkdown(): string {
  if (!editor) return '';
  const html = editor.getHTML();
  return htmlToMarkdown(html);
}

function parseComments(raw: unknown): DocComment[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return [];
  const out: DocComment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.body !== 'string') continue;
    if (o.author !== 'agent' && o.author !== 'user') continue;
    if (typeof o.createdAt !== 'string') continue;
    const c: DocComment = {
      id: o.id,
      body: o.body,
      author: o.author,
      createdAt: o.createdAt,
    };
    if (typeof o.quote === 'string' && o.quote.trim()) c.quote = o.quote.trim();
    out.push(c);
  }
  return out;
}

function syncCommentsChrome(): void {
  const n = comments.length;
  if (!commentsPane) return;

  // No comments → hide the whole rail (neither expanded nor strip).
  if (n === 0) {
    commentsPane.hidden = true;
    commentsPane.classList.remove('collapsed');
    if (commentsExpandBtn) {
      commentsExpandBtn.setAttribute('aria-expanded', 'false');
      commentsExpandBtn.title = 'Comments';
    }
    if (commentsRailBadge) {
      commentsRailBadge.hidden = true;
      commentsRailBadge.textContent = '';
    }
    return;
  }

  commentsPane.hidden = false;
  commentsPane.classList.toggle('collapsed', commentsCollapsed);

  if (commentsExpandBtn) {
    commentsExpandBtn.setAttribute('aria-expanded', commentsCollapsed ? 'false' : 'true');
    commentsExpandBtn.title = commentsCollapsed
      ? `Expand comments (${n})`
      : 'Collapse comments to sidebar';
  }
  if (commentsRailBadge) {
    // Badge only meaningful on the collapsed strip
    commentsRailBadge.hidden = !commentsCollapsed;
    commentsRailBadge.textContent = String(n);
  }
}

function renderComments(): void {
  if (!commentsList || !commentsCount) return;
  if (comments.length === 0) {
    commentsList.innerHTML = '';
    commentsCount.textContent = '';
    commentsCollapsed = false;
    syncCommentsChrome();
    return;
  }
  commentsCount.textContent = String(comments.length);
  commentsList.innerHTML = '';
  // Newest first for review UX
  const sorted = [...comments].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
  );
  for (const c of sorted) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'comment-card';
    btn.dataset.commentId = c.id;

    const meta = document.createElement('div');
    meta.className = 'comment-meta';
    const who = document.createElement('span');
    who.textContent = c.author === 'agent' ? 'Agent' : 'You';
    const when = document.createElement('span');
    try {
      when.textContent = new Date(c.createdAt).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      when.textContent = c.createdAt;
    }
    meta.appendChild(who);
    meta.appendChild(when);
    btn.appendChild(meta);

    if (c.quote) {
      const q = document.createElement('div');
      q.className = 'comment-quote';
      q.textContent = c.quote.length > 160 ? `${c.quote.slice(0, 159)}…` : c.quote;
      btn.appendChild(q);
    }

    const body = document.createElement('div');
    body.className = 'comment-body';
    body.textContent = c.body;
    btn.appendChild(body);

    btn.addEventListener('click', () => focusCommentAnchor(c));
    commentsList.appendChild(btn);
  }
  syncCommentsChrome();
  refreshCommentHighlights();
}

/** Collapse whitespace and strip common markdown chrome for anchor matching. */
function normalizeAnchorText(s: string): string {
  return s
    .replace(/\r\n/g, '\n')
    .replace(/[#>*_`~\-\[\]\(\)!]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Map a range in concatenated plain text back to PM positions.
 * Returns null if the plain range cannot be resolved.
 */
function findTextRangeInDoc(
  doc: PmNode,
  needleRaw: string,
): { from: number; to: number } | null {
  if (!needleRaw.trim()) return null;

  type MapEntry = { plainFrom: number; plainTo: number; pmFrom: number; text: string };
  const parts: MapEntry[] = [];
  let plainLen = 0;
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const t = node.text;
    parts.push({
      plainFrom: plainLen,
      plainTo: plainLen + t.length,
      pmFrom: pos,
      text: t,
    });
    plainLen += t.length;
  });

  const plainTight = parts.map((p) => p.text).join('');
  const candidates = [
    needleRaw.trim(),
    needleRaw.split('\n')[0]?.trim() ?? '',
    normalizeAnchorText(needleRaw),
  ].filter((s, i, arr) => s && arr.indexOf(s) === i);

  function searchInPlain(
    plain: string,
    needle: string,
    caseInsensitive: boolean,
  ): { start: number; end: number } | null {
    if (!needle) return null;
    if (caseInsensitive) {
      const i = plain.toLowerCase().indexOf(needle.toLowerCase());
      if (i < 0) return null;
      return { start: i, end: i + needle.length };
    }
    const i = plain.indexOf(needle);
    if (i < 0) return null;
    return { start: i, end: i + needle.length };
  }

  function plainOffsetToPm(offset: number): number | null {
    for (const p of parts) {
      if (offset >= p.plainFrom && offset < p.plainTo) {
        return p.pmFrom + (offset - p.plainFrom);
      }
      if (offset === p.plainTo) {
        return p.pmFrom + p.text.length;
      }
    }
    if (offset === plainLen && parts.length) {
      const last = parts[parts.length - 1]!;
      return last.pmFrom + last.text.length;
    }
    return null;
  }

  for (const cand of candidates) {
    const hit = searchInPlain(plainTight, cand, false);
    if (hit) {
      const from = plainOffsetToPm(hit.start);
      const to = plainOffsetToPm(hit.end);
      if (from != null && to != null && to > from) {
        return { from, to };
      }
    }

    let found: { from: number; to: number } | null = null;
    doc.descendants((node, pos) => {
      if (found || !node.isText || !node.text) return;
      let idx = node.text.indexOf(cand);
      if (idx < 0) idx = node.text.toLowerCase().indexOf(cand.toLowerCase());
      if (idx < 0) {
        const nt = normalizeAnchorText(node.text);
        const nc = normalizeAnchorText(cand);
        if (nc && nt.includes(nc)) {
          found = { from: pos, to: pos + node.text.length };
          return;
        }
        return;
      }
      found = { from: pos + idx, to: pos + idx + cand.length };
    });
    if (found) return found;
  }
  return null;
}

function findTextRangeInEditor(needleRaw: string): { from: number; to: number } | null {
  if (!editor) return null;
  return findTextRangeInDoc(editor.state.doc, needleRaw);
}

const commentHighlightKey = new PluginKey('commentHighlight');

function buildCommentDecorations(doc: PmNode, list: DocComment[]): DecorationSet {
  const decos: Decoration[] = [];
  const seen = new Set<string>();
  for (const c of list) {
    if (!c.quote?.trim()) continue;
    const range = findTextRangeInDoc(doc, c.quote);
    if (!range) continue;
    // One decoration per unique range key (multiple comments can share an anchor)
    const key = `${range.from}:${range.to}`;
    if (seen.has(key)) {
      // Still mark with data for the latest comment id
      decos.push(
        Decoration.inline(range.from, range.to, {
          class: 'comment-anchor',
          'data-comment-id': c.id,
        }),
      );
      continue;
    }
    seen.add(key);
    decos.push(
      Decoration.inline(range.from, range.to, {
        class: 'comment-anchor',
        'data-comment-id': c.id,
        title: c.body.length > 120 ? `${c.body.slice(0, 119)}…` : c.body,
      }),
    );
  }
  return DecorationSet.create(doc, decos);
}

/** TipTap extension: highlight / underline text that has comment anchors. */
const CommentHighlight = Extension.create({
  name: 'commentHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: commentHighlightKey,
        state: {
          init: (_cfg, state) => buildCommentDecorations(state.doc, comments),
          apply(tr, old, _oldState, newState) {
            const meta = tr.getMeta(commentHighlightKey) as
              | { comments?: DocComment[] }
              | undefined;
            if (meta?.comments !== undefined) {
              return buildCommentDecorations(newState.doc, meta.comments);
            }
            if (tr.docChanged) {
              // Re-resolve anchors after user edits the body
              return buildCommentDecorations(newState.doc, comments);
            }
            return old.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return commentHighlightKey.getState(state);
          },
        },
      }),
    ];
  },
});

function refreshCommentHighlights(): void {
  if (!editor || editor.isDestroyed) return;
  const tr = editor.state.tr.setMeta(commentHighlightKey, { comments });
  editor.view.dispatch(tr);
}

function focusCommentAnchor(c: DocComment): void {
  if (!editor || !c.quote) {
    setStatus(`comment · ${c.author}`);
    return;
  }
  const found = findTextRangeInEditor(c.quote);
  if (!found) {
    setStatus('comment anchor not found in current text');
    return;
  }
  editor.chain().focus().setTextSelection(found).scrollIntoView().run();
  setStatus(`comment on selection · rev ${revision}`);
}

/** Expand comments rail (if needed) and scroll/highlight the matching card. */
function focusCommentInRail(commentId: string): void {
  const c = comments.find((x) => x.id === commentId);
  if (!c) {
    setStatus('comment not found');
    return;
  }
  if (comments.length === 0) return;
  // Ensure expanded so the card is visible
  if (commentsCollapsed) {
    commentsCollapsed = false;
    syncCommentsChrome();
  }
  if (!commentsList) return;
  const card = commentsList.querySelector(
    `[data-comment-id="${CSS.escape(commentId)}"]`,
  ) as HTMLElement | null;
  if (!card) {
    setStatus(`comment · ${c.author}`);
    return;
  }
  commentsList.querySelectorAll('.comment-card.is-active').forEach((el) => {
    el.classList.remove('is-active');
  });
  card.classList.add('is-active');
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  setStatus(`comment · ${c.author}`);
  window.setTimeout(() => {
    card.classList.remove('is-active');
  }, 2000);
}

function toggleCommentsExpanded(): void {
  if (comments.length === 0) return;
  commentsCollapsed = !commentsCollapsed;
  syncCommentsChrome();
}

function syncSubmitChrome(): void {
  if (!submitBtn) return;
  // Submit only in edit mode when allowed by props.
  const show = mode === 'edit' && allowSubmit;
  submitBtn.hidden = !show;
  submitBtn.textContent = submitLabel;
  submitBtn.disabled = pendingSubmit || exporting;
}

function saveState(opts?: { submitAfter?: boolean }): void {
  if (!instanceId || !editor) return;
  if (mode === 'view') {
    setError('Document is view-only');
    return;
  }
  if (opts?.submitAfter && !allowSubmit) {
    setError('Submit is disabled for this document');
    return;
  }
  const markdown = currentMarkdown();
  const err = validateMarkdown(markdown);
  if (err) {
    setError(err);
    post({
      channel: CHANNEL,
      type: 'error',
      instanceId,
      message: err,
    });
    return;
  }
  setError(null);
  pendingSubmit = opts?.submitAfter === true;
  syncSubmitChrome();
  setStatus(pendingSubmit ? 'saving for submit…' : 'saving…');
  // Preserve comments layer — Save must not wipe agent annotations.
  const data: Record<string, unknown> = { format: FORMAT, markdown };
  if (comments.length > 0) data.comments = comments;
  post({
    channel: CHANNEL,
    type: 'state_save',
    instanceId,
    expectedRevision: revision,
    data,
  });
}

function submitDocument(): void {
  saveState({ submitAfter: true });
}

function finishSubmitAfterSave(rev: number): void {
  if (!instanceId || !pendingSubmit) return;
  pendingSubmit = false;
  syncSubmitChrome();
  setStatus(`submitting · rev ${rev}`);
  post({
    channel: CHANNEL,
    type: 'document_submit',
    instanceId,
    kind: 'rich-document',
    title: documentTitle,
    revision: rev,
  });
}

function applyTheme(theme: Theme | undefined): void {
  const scheme = theme?.colorScheme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', scheme);
}

function applyMode(m: 'edit' | 'view'): void {
  mode = m;
  // Format toolbar is edit-only; export stays available in view mode.
  if (toolbarEl) toolbarEl.hidden = m === 'view';
  if (editor) {
    editor.setEditable(m === 'edit');
  }
  if (editorEl) {
    if (m === 'view') editorEl.classList.add('readonly');
    else editorEl.classList.remove('readonly');
  }
  if (saveBtn) saveBtn.hidden = m === 'view';
  syncSubmitChrome();
}

function applySubmitProps(props: Record<string, unknown>): void {
  if (props.allowSubmit === false) allowSubmit = false;
  else if (props.allowSubmit === true) allowSubmit = true;
  // omit → keep current (default true on first open)
  if (typeof props.submitLabel === 'string' && props.submitLabel.trim()) {
    submitLabel = props.submitLabel.trim();
  }
  syncSubmitChrome();
}

function requestExport(format: 'docx' | 'pdf'): void {
  if (!instanceId || !editor) return;
  if (exporting) return;
  const markdown = currentMarkdown();
  const err = validateMarkdown(markdown);
  if (err) {
    setError(err);
    return;
  }
  exporting = true;
  if (exportDocxBtn) exportDocxBtn.disabled = true;
  if (exportPdfBtn) exportPdfBtn.disabled = true;
  setError(null);
  setStatus(`exporting ${format.toUpperCase()}…`);
  post({
    channel: CHANNEL,
    type: 'export',
    instanceId,
    format,
    markdown,
    title: documentTitle,
  });
}

function hideQuoteToolbar(): void {
  pendingQuoteText = null;
  if (quoteToolbar) quoteToolbar.hidden = true;
}

function selectionInsideEditor(sel: Selection | null): boolean {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !editorEl) return false;
  const range = sel.getRangeAt(0);
  const start = range.startContainer;
  const end = range.endContainer;
  const startEl = start.nodeType === Node.ELEMENT_NODE ? (start as Element) : start.parentElement;
  const endEl = end.nodeType === Node.ELEMENT_NODE ? (end as Element) : end.parentElement;
  if (!startEl || !endEl) return false;
  return editorEl.contains(startEl) && editorEl.contains(endEl);
}

function refreshQuoteToolbar(): void {
  // Coarse pointer (touch): skip floating toolbar (mirrors ThreadView).
  if (typeof window !== 'undefined' && window.matchMedia) {
    if (window.matchMedia('(pointer: coarse)').matches) {
      hideQuoteToolbar();
      return;
    }
  }
  const sel = window.getSelection();
  if (!selectionInsideEditor(sel) || !sel || !quoteToolbar) {
    hideQuoteToolbar();
    return;
  }
  const text = sel.toString().trim();
  if (!text) {
    hideQuoteToolbar();
    return;
  }
  pendingQuoteText = text;
  const range = sel.getRangeAt(0);
  const rects = range.getClientRects();
  const rect =
    rects.length > 0 ? rects[0]! : range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) {
    hideQuoteToolbar();
    return;
  }
  quoteToolbar.hidden = false;
  quoteToolbar.style.top = `${Math.max(8, rect.top)}px`;
  quoteToolbar.style.left = `${rect.left + rect.width / 2}px`;
}

function submitQuote(): void {
  if (!instanceId) return;
  const text = (pendingQuoteText ?? '').trim();
  hideQuoteToolbar();
  window.getSelection()?.removeAllRanges();
  if (!text) {
    setError('Selection is empty.');
    return;
  }
  if (text.length > QUOTE_TEXT_MAX) {
    setError(`Selection is too long (max ${QUOTE_TEXT_MAX} characters). Select a shorter span.`);
    return;
  }
  setError(null);
  post({
    channel: CHANNEL,
    type: 'quote',
    instanceId,
    kind: 'rich-document',
    title: documentTitle,
    text,
  });
  setStatus(`quoted into chat · rev ${revision}`);
}

function requestOpenExternal(url: string): void {
  if (!instanceId) return;
  post({ channel: CHANNEL, type: 'open_external', instanceId, url });
}

function createEditor(initialMarkdown: string, placeholder: string): Editor {
  if (!editorEl) {
    throw new Error('editor mount element missing');
  }
  const html = markdownToHtml(initialMarkdown || '');
  const ed = new Editor({
    element: editorEl,
    extensions: [
      StarterKit.configure({
        // Keep schema tight: no raw HTML extension
        heading: { levels: [1, 2, 3, 4, 5, 6] },
      }),
      // No manual link UI — URLs are auto-linked on type/paste (autolink + linkOnPaste).
      // Clicks go through host open_external (sandbox has no navigation).
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        HTMLAttributes: {
          rel: 'noopener noreferrer',
          target: null,
        },
        protocols: ['http', 'https'],
        validate: (href) => {
          try {
            const u = new URL(href);
            return (
              (u.protocol === 'http:' || u.protocol === 'https:') &&
              !u.username &&
              !u.password
            );
          } catch {
            return false;
          }
        },
      }),
      Placeholder.configure({
        placeholder: placeholder || 'Start writing…',
      }),
      CommentHighlight,
    ],
    content: html,
    editable: mode === 'edit',
    editorProps: {
      attributes: {
        class: 'prose',
        spellcheck: 'true',
      },
      handleClick(_view, _pos, event) {
        const t = event.target as HTMLElement | null;
        // Highlighted comment span → jump to the matching card in the rail
        const anchor = t?.closest?.('.comment-anchor') as HTMLElement | null;
        if (anchor) {
          const id = anchor.getAttribute('data-comment-id');
          if (id) {
            event.preventDefault();
            focusCommentInRail(id);
            return true;
          }
        }
        const a = t?.closest?.('a') as HTMLAnchorElement | null;
        if (a && a.href) {
          event.preventDefault();
          requestOpenExternal(a.href);
          return true;
        }
        return false;
      },
      handlePaste(_view, event) {
        // Prefer plain text when pasting to avoid retaining raw HTML nodes
        const text = event.clipboardData?.getData('text/plain');
        if (text != null && text !== '' && editor) {
          // Let TipTap handle; schema has no HTML nodes so HTML paste is constrained
        }
        return false;
      },
    },
    onUpdate: () => {
      setDirty(true);
      setStatus(`editing · rev ${revision}`);
    },
  });
  return ed;
}

function wireToolbar(): void {
  if (!toolbarEl) return;
  toolbarEl.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('button[data-cmd]') as HTMLButtonElement | null;
    if (!btn || !editor) return;
    const cmd = btn.getAttribute('data-cmd');
    if (!cmd) return;
    if (cmd === 'bold') editor.chain().focus().toggleBold().run();
    else if (cmd === 'italic') editor.chain().focus().toggleItalic().run();
    else if (cmd === 'h1') editor.chain().focus().toggleHeading({ level: 1 }).run();
    else if (cmd === 'h2') editor.chain().focus().toggleHeading({ level: 2 }).run();
    else if (cmd === 'bullet') editor.chain().focus().toggleBulletList().run();
    else if (cmd === 'ordered') editor.chain().focus().toggleOrderedList().run();
    else if (cmd === 'code') editor.chain().focus().toggleCodeBlock().run();
    else if (cmd === 'quote') editor.chain().focus().toggleBlockquote().run();
    else if (cmd === 'hr') editor.chain().focus().setHorizontalRule().run();
  });
  if (saveBtn) {
    saveBtn.addEventListener('click', () => saveState());
  }
  if (submitBtn) {
    submitBtn.addEventListener('click', () => submitDocument());
  }
  if (exportDocxBtn) {
    exportDocxBtn.addEventListener('click', () => requestExport('docx'));
  }
  if (exportPdfBtn) {
    exportPdfBtn.addEventListener('click', () => requestExport('pdf'));
  }
  if (commentsExpandBtn) {
    commentsExpandBtn.addEventListener('click', () => toggleCommentsExpanded());
  }
  if (quoteBtn) {
    quoteBtn.addEventListener('pointerdown', (ev) => {
      // preventDefault keeps the frozen selection text in pendingQuoteText
      // (mouseup/selectionchange would otherwise collapse before click).
      ev.preventDefault();
      ev.stopPropagation();
      submitQuote();
    });
  }
  document.addEventListener('selectionchange', () => refreshQuoteToolbar());
  document.addEventListener('mouseup', () => refreshQuoteToolbar());
  window.addEventListener('resize', () => hideQuoteToolbar());
  document.addEventListener('scroll', () => hideQuoteToolbar(), true);
}

function onInit(msg: {
  instanceId: string;
  kind: string;
  title?: string;
  props: Record<string, unknown>;
  theme?: Theme;
  state: { revision: number; data: Record<string, unknown> } | null;
}): void {
  if (msg.kind !== 'rich-document') {
    post({
      channel: CHANNEL,
      type: 'error',
      instanceId: msg.instanceId,
      message: `rich-document guest received unexpected kind '${msg.kind}'`,
    });
    return;
  }
  instanceId = msg.instanceId;
  applyTheme(msg.theme);

  const props = msg.props ?? {};
  allowSubmit = true;
  submitLabel = 'Submit';
  applySubmitProps(props);
  if (props.mode === 'view' || props.mode === 'edit') {
    applyMode(props.mode);
  } else {
    applyMode('edit');
  }
  const placeholder =
    typeof props.placeholder === 'string' ? props.placeholder : 'Start writing…';

  if (!msg.state || typeof msg.state.data !== 'object' || msg.state.data === null) {
    post({
      channel: CHANNEL,
      type: 'error',
      instanceId,
      message: 'rich-document init requires state',
    });
    return;
  }
  const data = msg.state.data as Record<string, unknown>;
  if (data.format !== FORMAT || typeof data.markdown !== 'string') {
    post({
      channel: CHANNEL,
      type: 'error',
      instanceId,
      message: `rich-document state must be { format: '${FORMAT}', markdown: string }`,
    });
    return;
  }
  revision = msg.state.revision;
  if (typeof msg.title === 'string' && msg.title.trim()) {
    documentTitle = msg.title.trim();
  }
  comments = parseComments(data.comments);
  // New document open: expand comments rail if any (user can collapse to strip).
  commentsCollapsed = false;
  try {
    if (editor) {
      editor.destroy();
      editor = null;
    }
    editor = createEditor(data.markdown, placeholder);
    setDirty(false);
    if (exportBar) exportBar.hidden = false;
    renderComments();
    sendReady();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    post({ channel: CHANNEL, type: 'error', instanceId, message });
    setError(message);
  }
}

function onUpdate(msg: {
  props: Record<string, unknown>;
  state?: { revision: number; data: Record<string, unknown> };
}): void {
  if (msg.props && typeof msg.props === 'object') {
    applySubmitProps(msg.props);
  }
  if (msg.props?.mode === 'view' || msg.props?.mode === 'edit') {
    applyMode(msg.props.mode);
  }
  if (msg.state && editor) {
    const data = msg.state.data as Record<string, unknown>;
    if (data.format === FORMAT && typeof data.markdown === 'string') {
      revision = msg.state.revision;
      const prevMarkdown = currentMarkdown();
      const nextMarkdown = data.markdown;
      const prevCount = comments.length;
      comments = parseComments(data.comments);
      // New comments arrived while collapsed → expand so the user sees them.
      if (comments.length > prevCount) {
        commentsCollapsed = false;
      }
      // Only rewrite editor when body changed — comment-only updates keep caret.
      if (nextMarkdown !== prevMarkdown) {
        const html = markdownToHtml(nextMarkdown);
        editor.commands.setContent(html, false);
      }
      setDirty(false);
      renderComments();
      const n = comments.length;
      setStatus(
        n > 0
          ? `updated · rev ${revision} · ${n} comment${n === 1 ? '' : 's'}`
          : `updated · rev ${revision}`,
      );
    }
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  const o = data as Record<string, unknown>;
  if (o.channel !== CHANNEL) return;
  if (typeof o.type !== 'string') return;

  if (o.type === 'init') {
    onInit(o as Parameters<typeof onInit>[0]);
    return;
  }
  if (o.type === 'update') {
    if (instanceId && o.instanceId === instanceId) {
      onUpdate(o as Parameters<typeof onUpdate>[0]);
    }
    return;
  }
  if (o.type === 'state_saved') {
    if (instanceId && o.instanceId === instanceId && typeof o.revision === 'number') {
      revision = o.revision;
      setDirty(false);
      setError(null);
      if (pendingSubmit) {
        finishSubmitAfterSave(revision);
      } else {
        setStatus(`saved · rev ${revision}`);
      }
    }
    return;
  }
  if (o.type === 'state_error') {
    if (instanceId && o.instanceId === instanceId) {
      pendingSubmit = false;
      syncSubmitChrome();
      const message = typeof o.message === 'string' ? o.message : 'save failed';
      setError(message);
      setStatus(`error · rev ${revision}`);
    }
    return;
  }
  if (o.type === 'document_submit_result') {
    if (instanceId && o.instanceId === instanceId) {
      pendingSubmit = false;
      syncSubmitChrome();
      if (o.ok === true) {
        setError(null);
        setStatus(`submitted · rev ${revision}`);
      } else {
        const message = typeof o.error === 'string' ? o.error : 'submit failed';
        setError(message);
        setStatus(`submit error · rev ${revision}`);
      }
    }
    return;
  }
  if (o.type === 'open_external_result') {
    // Silent on success/dismiss; show error only for hard fails
    if (
      instanceId &&
      o.instanceId === instanceId &&
      o.ok === false &&
      typeof o.error === 'string' &&
      o.error !== 'user dismissed'
    ) {
      setError(o.error);
    }
    return;
  }
  if (o.type === 'export_result') {
    if (instanceId && o.instanceId === instanceId) {
      exporting = false;
      if (exportDocxBtn) exportDocxBtn.disabled = false;
      if (exportPdfBtn) exportPdfBtn.disabled = false;
      if (o.ok === true) {
        const name = typeof o.filename === 'string' ? o.filename : 'file';
        setError(null);
        setStatus(`exported ${name} · rev ${revision}`);
      } else {
        const message = typeof o.error === 'string' ? o.error : 'export failed';
        setError(message);
        setStatus(`export error · rev ${revision}`);
      }
    }
  }
});

document.addEventListener('keydown', (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') {
    ev.preventDefault();
    saveState();
  }
});

wireToolbar();
setStatus('Waiting for host…');
