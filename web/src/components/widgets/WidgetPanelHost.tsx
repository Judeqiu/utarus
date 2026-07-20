/**
 * Side-panel host for iframe-bundle widgets + host-mediated state.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useWidgetRegistry } from '../../widgets/registry-context.js';
import {
  isWidgetGuestMessage,
  themeColorScheme,
  WIDGET_CHANNEL,
  type WidgetHostToGuest,
} from '../../widgets/bridge.js';
import { validateRichDocumentProps, validateExternalOpenUrl } from '../../widgets/kinds/rich-document-state.js';
import { exportRichDocument } from '../../widgets/export/export-document.js';
import {
  isAllowedWidgetEntryUrl,
  isPlatformWidgetKindId,
  WIDGET_BRIDGE_READY_TIMEOUT_MS,
  WIDGET_STATE_DATA_MAX_BYTES,
  type WidgetSpec,
} from '../../widgets/widget-spec.js';
import type { ChatQuoteRef } from '../../types.js';
import { QUOTE_TEXT_MAX } from '../../types.js';

export interface WidgetArtifactMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  created_at?: string;
  stopReason?: string;
}

interface WidgetPanelHostProps {
  spec: WidgetSpec;
  conversationId: string | null;
  /**
   * When this changes for the same instanceId, re-fetch durable state and
   * postMessage `update` to the guest (agent update_widget path).
   */
  contentEpoch?: number;
  onClose: () => void;
  /** Append assistant card message after user state_save (K38). */
  onArtifactMessage?: (message: WidgetArtifactMessage) => void;
  /** Quote selected widget text into the composer (rich-document). */
  onQuote?: (quote: ChatQuoteRef) => void;
  onQuoteError?: (message: string) => void;
  /**
   * Document Submit: guest already saved; host should post a chat turn so the
   * agent can process the submission (answer, assignment, etc.).
   */
  onDocumentSubmit?: (payload: {
    instanceId: string;
    kind: string;
    title: string;
    revision: number;
  }) => void | Promise<void>;
}

interface StateDoc {
  revision: number;
  data: Record<string, unknown>;
  kind: string;
}

function resolveWidgetEntryUrl(
  spec: WidgetSpec,
  reg: { entryHtml?: string },
  agentKey: string | null,
): { ok: true; url: string } | { ok: false; error: string } {
  if (spec.kind === 'html-bundle') {
    if (!spec.entry) return { ok: false, error: 'html-bundle requires entry' };
    return { ok: true, url: spec.entry };
  }
  if (isPlatformWidgetKindId(spec.kind)) {
    if (!reg.entryHtml) {
      return { ok: false, error: `platform kind '${spec.kind}' missing entryHtml` };
    }
    return { ok: true, url: `/platform-assets/widgets/${reg.entryHtml}` };
  }
  if (!agentKey || !reg.entryHtml) {
    return { ok: false, error: 'Domain widget missing agentKey or entryHtml' };
  }
  return { ok: true, url: `/domain-assets/${agentKey}/${reg.entryHtml}` };
}

export function WidgetPanelHost({
  spec,
  contentEpoch,
  conversationId,
  onClose,
  onArtifactMessage,
  onQuote,
  onQuoteError,
  onDocumentSubmit,
}: WidgetPanelHostProps) {
  const registry = useWidgetRegistry();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [entryUrl, setEntryUrl] = useState<string | null>(null);
  const [stateDoc, setStateDoc] = useState<StateDoc | null>(null);
  const [pendingExternalUrl, setPendingExternalUrl] = useState<string | null>(null);
  const title = spec.title;
  /** Skip the first contentEpoch after boot — boot already loaded state. */
  const appliedEpochRef = useRef<number | undefined>(contentEpoch);
  const bootedInstanceRef = useRef<string | null>(null);

  const reg = registry.byId.get(spec.kind);

  const postToGuest = useCallback((msg: WidgetHostToGuest) => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage(msg, '*');
  }, []);

  // Full boot when widget identity changes (instance / kind / entry).
  // Do NOT depend on contentEpoch or props — those use soft-refresh below.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setReady(false);
    setEntryUrl(null);
    setStateDoc(null);
    setPendingExternalUrl(null);
    bootedInstanceRef.current = null;
    appliedEpochRef.current = contentEpoch;

    async function boot() {
      if (!registry.registryAvailable) {
        setError(registry.unavailableReason ?? 'Widget registry unavailable');
        return;
      }
      if (!reg) {
        setError(`Unknown widget kind: ${spec.kind}`);
        return;
      }

      // Platform kind props validation (D14) before any network/iframe work
      if (spec.kind === 'rich-document') {
        const pr = validateRichDocumentProps(spec.props);
        if (!pr.ok) {
          setError(pr.error);
          return;
        }
      }

      const resolved = resolveWidgetEntryUrl(spec, reg, registry.agentKey);
      if (!resolved.ok) {
        setError(resolved.error);
        return;
      }
      const url = resolved.url;

      // Single pure allowlist — hard error on failure (no soft bypass for platform)
      let viewerSlug = '';
      if (url.startsWith('/api/files/')) {
        try {
          viewerSlug = new URL(url, window.location.origin).searchParams.get('slug') ?? '';
        } catch {
          viewerSlug = '';
        }
      }
      if (
        !isAllowedWidgetEntryUrl(url, {
          viewerSlug,
          agentKey: registry.agentKey,
        })
      ) {
        setError(`Entry URL not allowed: ${url}`);
        return;
      }

      if (reg.supportsPersistence) {
        try {
          const res = await fetch(`/api/widgets/state/${spec.instanceId}`, {
            credentials: 'include',
          });
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as {
              error?: string;
            };
            setError(
              body.error ??
                `Widget state not found for instanceId ${spec.instanceId}`,
            );
            return;
          }
          const data = (await res.json()) as {
            doc: { revision: number; data: Record<string, unknown>; kind: string };
          };
          if (cancelled) return;
          setStateDoc({
            revision: data.doc.revision,
            data: data.doc.data,
            kind: data.doc.kind,
          });
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          return;
        }
      }

      if (cancelled) return;
      setEntryUrl(url);
      bootedInstanceRef.current = spec.instanceId;
    }

    void boot();
    return () => {
      cancelled = true;
    };
    // contentEpoch intentionally omitted — soft-refresh effect handles it
    // eslint-disable-next-line react-hooks/exhaustive-deps -- identity-only full boot
  }, [spec.instanceId, spec.kind, spec.entry, reg, registry]);

  const stateDocRef = useRef(stateDoc);
  stateDocRef.current = stateDoc;

  // Soft-refresh: same instance already open, agent wrote new durable state.
  useEffect(() => {
    if (contentEpoch === undefined) return;
    if (!ready || !entryUrl || !reg) return;
    if (bootedInstanceRef.current !== spec.instanceId) return;
    if (appliedEpochRef.current === contentEpoch) return;
    if (!reg.supportsUpdate) return;

    let cancelled = false;
    appliedEpochRef.current = contentEpoch;

    async function softRefresh() {
      try {
        if (spec.kind === 'rich-document') {
          const pr = validateRichDocumentProps(spec.props);
          if (!pr.ok) {
            setError(pr.error);
            return;
          }
        }
        let nextState: { revision: number; data: Record<string, unknown> } | undefined;
        if (reg!.supportsPersistence) {
          const res = await fetch(`/api/widgets/state/${spec.instanceId}`, {
            credentials: 'include',
          });
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as { error?: string };
            setError(
              body.error ??
                `Widget state not found for instanceId ${spec.instanceId}`,
            );
            return;
          }
          const data = (await res.json()) as {
            doc: { revision: number; data: Record<string, unknown>; kind: string };
          };
          if (cancelled) return;
          setStateDoc({
            revision: data.doc.revision,
            data: data.doc.data,
            kind: data.doc.kind,
          });
          nextState = { revision: data.doc.revision, data: data.doc.data };
        }
        if (cancelled) return;
        setError(null);
        const update: WidgetHostToGuest = {
          channel: WIDGET_CHANNEL,
          type: 'update',
          instanceId: spec.instanceId,
          props: spec.props,
          ...(nextState ? { state: nextState } : {}),
        };
        postToGuest(update);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    }

    void softRefresh();
    return () => {
      cancelled = true;
    };
  }, [
    contentEpoch,
    ready,
    entryUrl,
    reg,
    spec.instanceId,
    spec.kind,
    spec.props,
    postToGuest,
  ]);

  // Bridge: load → init / ready timeout; guest messages
  useEffect(() => {
    if (!entryUrl || !reg) return;
    // For persistent kinds wait until state is loaded
    if (reg.supportsPersistence && !stateDoc) return;

    const iframe = iframeRef.current;
    if (!iframe) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let inited = false;

    const onLoad = () => {
      if (!reg.supportsUpdate) {
        setReady(true);
        return;
      }
      if (inited) return;
      inited = true;
      const doc = stateDocRef.current;
      const init: WidgetHostToGuest = {
        channel: WIDGET_CHANNEL,
        type: 'init',
        instanceId: spec.instanceId,
        kind: spec.kind,
        title: spec.title,
        props: spec.props,
        theme: { colorScheme: themeColorScheme() },
        state:
          reg.supportsPersistence && doc
            ? { revision: doc.revision, data: doc.data }
            : null,
      };
      postToGuest(init);
      timer = setTimeout(() => {
        setError(
          `Widget failed to become ready within WIDGET_BRIDGE_READY_TIMEOUT_MS=${WIDGET_BRIDGE_READY_TIMEOUT_MS}`,
        );
      }, WIDGET_BRIDGE_READY_TIMEOUT_MS);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow) return;
      if (!isWidgetGuestMessage(event.data)) return;
      const msg = event.data;
      if (msg.instanceId !== spec.instanceId) return;

      if (msg.type === 'ready') {
        if (timer) clearTimeout(timer);
        setReady(true);
        setError(null);
        return;
      }
      if (msg.type === 'error') {
        if (timer) clearTimeout(timer);
        setError(msg.message);
        return;
      }
      if (msg.type === 'open_external') {
        const urlCheck = validateExternalOpenUrl(msg.url);
        if (!urlCheck.ok) {
          postToGuest({
            channel: WIDGET_CHANNEL,
            type: 'open_external_result',
            instanceId: spec.instanceId,
            ok: false,
            error: urlCheck.error,
          });
          return;
        }
        // Confirm strip — never window.open in the message handler (popup blocker)
        setPendingExternalUrl(urlCheck.value);
        return;
      }
      if (msg.type === 'quote') {
        if (spec.kind !== 'rich-document') return;
        if (!onQuote) return;
        const text = typeof msg.text === 'string' ? msg.text.trim() : '';
        if (!text) {
          onQuoteError?.('Selection is empty.');
          return;
        }
        if (text.length > QUOTE_TEXT_MAX) {
          onQuoteError?.(
            `Selection is too long (max ${QUOTE_TEXT_MAX} characters). Select a shorter span.`,
          );
          return;
        }
        onQuote({
          messageId: spec.instanceId,
          role: 'widget',
          source: 'widget',
          text,
          widgetKind: typeof msg.kind === 'string' && msg.kind ? msg.kind : spec.kind,
          widgetTitle:
            typeof msg.title === 'string' && msg.title.trim()
              ? msg.title.trim()
              : spec.title,
        });
        return;
      }
      if (msg.type === 'document_submit') {
        if (spec.kind !== 'rich-document') {
          postToGuest({
            channel: WIDGET_CHANNEL,
            type: 'document_submit_result',
            instanceId: spec.instanceId,
            ok: false,
            error: `document_submit not supported for kind '${spec.kind}'`,
          });
          return;
        }
        if (!onDocumentSubmit) {
          postToGuest({
            channel: WIDGET_CHANNEL,
            type: 'document_submit_result',
            instanceId: spec.instanceId,
            ok: false,
            error: 'document submit is not available in this view',
          });
          return;
        }
        if (typeof msg.revision !== 'number' || !Number.isInteger(msg.revision)) {
          postToGuest({
            channel: WIDGET_CHANNEL,
            type: 'document_submit_result',
            instanceId: spec.instanceId,
            ok: false,
            error: 'document_submit requires integer revision',
          });
          return;
        }
        void (async () => {
          try {
            await onDocumentSubmit({
              instanceId: spec.instanceId,
              kind:
                typeof msg.kind === 'string' && msg.kind.trim()
                  ? msg.kind.trim()
                  : spec.kind,
              title:
                typeof msg.title === 'string' && msg.title.trim()
                  ? msg.title.trim()
                  : spec.title,
              revision: msg.revision,
            });
            postToGuest({
              channel: WIDGET_CHANNEL,
              type: 'document_submit_result',
              instanceId: spec.instanceId,
              ok: true,
            });
          } catch (e) {
            postToGuest({
              channel: WIDGET_CHANNEL,
              type: 'document_submit_result',
              instanceId: spec.instanceId,
              ok: false,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        })();
        return;
      }
      if (msg.type === 'export') {
        if (spec.kind !== 'rich-document') {
          postToGuest({
            channel: WIDGET_CHANNEL,
            type: 'export_result',
            instanceId: spec.instanceId,
            ok: false,
            error: `export not supported for kind '${spec.kind}'`,
          });
          return;
        }
        void (async () => {
          try {
            if (msg.format !== 'docx' && msg.format !== 'pdf') {
              throw new Error(`unsupported export format: ${String(msg.format)}`);
            }
            if (typeof msg.markdown !== 'string') {
              throw new Error('export markdown must be a string');
            }
            const mdBytes = new TextEncoder().encode(msg.markdown).length;
            if (mdBytes > WIDGET_STATE_DATA_MAX_BYTES) {
              throw new Error(
                `export markdown exceeds WIDGET_STATE_DATA_MAX_BYTES=${WIDGET_STATE_DATA_MAX_BYTES}`,
              );
            }
            const title =
              typeof msg.title === 'string' && msg.title.trim()
                ? msg.title.trim()
                : spec.title;
            const { filename } = await exportRichDocument({
              format: msg.format,
              markdown: msg.markdown,
              title,
            });
            postToGuest({
              channel: WIDGET_CHANNEL,
              type: 'export_result',
              instanceId: spec.instanceId,
              ok: true,
              format: msg.format,
              filename,
            });
          } catch (e) {
            postToGuest({
              channel: WIDGET_CHANNEL,
              type: 'export_result',
              instanceId: spec.instanceId,
              ok: false,
              format: msg.format === 'docx' || msg.format === 'pdf' ? msg.format : undefined,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        })();
        return;
      }
      if (msg.type === 'state_save') {
        if (!reg.supportsPersistence) return;
        void (async () => {
          try {
            // rich-document: no chat card on Save (not versioned in history —
            // original open card reloads latest BinDrive state). Omit conversationId
            // so the host does not request an artifact message.
            const putBody: Record<string, unknown> = {
              kind: spec.kind,
              data: msg.data,
              expectedRevision: msg.expectedRevision,
              title: spec.title,
            };
            if (spec.kind !== 'rich-document') {
              putBody.conversationId = conversationId ?? undefined;
              putBody.summary = `Saved (revision pending)`;
            }
            const res = await fetch(`/api/widgets/state/${spec.instanceId}`, {
              method: 'PUT',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(putBody),
            });
            const body = (await res.json()) as {
              doc?: { revision: number; data: Record<string, unknown>; kind: string };
              error?: string;
              code?: string;
              currentRevision?: number;
              message?: WidgetArtifactMessage;
            };
            if (!res.ok || !body.doc) {
              postToGuest({
                channel: WIDGET_CHANNEL,
                type: 'state_error',
                instanceId: spec.instanceId,
                code: body.code ?? 'backend',
                message: body.error ?? `save failed ${res.status}`,
                currentRevision: body.currentRevision,
              });
              return;
            }
            setStateDoc({
              revision: body.doc.revision,
              data: body.doc.data,
              kind: body.doc.kind,
            });
            postToGuest({
              channel: WIDGET_CHANNEL,
              type: 'state_saved',
              instanceId: spec.instanceId,
              revision: body.doc.revision,
            });
            if (body.message && onArtifactMessage) {
              onArtifactMessage(body.message);
            }
          } catch (e) {
            postToGuest({
              channel: WIDGET_CHANNEL,
              type: 'state_error',
              instanceId: spec.instanceId,
              code: 'backend',
              message: e instanceof Error ? e.message : String(e),
            });
          }
        })();
      }
    };

    // If already complete (cached), fire once
    if (iframe.contentDocument?.readyState === 'complete') {
      onLoad();
    }
    iframe.addEventListener('load', onLoad);
    window.addEventListener('message', onMessage);
    return () => {
      iframe.removeEventListener('load', onLoad);
      window.removeEventListener('message', onMessage);
      if (timer) clearTimeout(timer);
    };
  }, [
    entryUrl,
    reg,
    stateDoc,
    spec.instanceId,
    spec.kind,
    spec.props,
    spec.title,
    conversationId,
    postToGuest,
    onArtifactMessage,
    onQuote,
    onQuoteError,
    onDocumentSubmit,
  ]);

  const openPendingExternal = () => {
    if (!pendingExternalUrl) return;
    const url = pendingExternalUrl;
    // Parent user activation — safe to open
    const w = window.open(url, '_blank', 'noopener,noreferrer');
    setPendingExternalUrl(null);
    if (w == null) {
      postToGuest({
        channel: WIDGET_CHANNEL,
        type: 'open_external_result',
        instanceId: spec.instanceId,
        ok: false,
        error: 'popup blocked or open failed',
      });
      return;
    }
    postToGuest({
      channel: WIDGET_CHANNEL,
      type: 'open_external_result',
      instanceId: spec.instanceId,
      ok: true,
    });
  };

  const dismissPendingExternal = () => {
    setPendingExternalUrl(null);
    postToGuest({
      channel: WIDGET_CHANNEL,
      type: 'open_external_result',
      instanceId: spec.instanceId,
      ok: false,
      error: 'user dismissed',
    });
  };

  return (
    <aside className="fixed inset-0 z-40 flex flex-col bg-white lg:static lg:z-auto lg:w-1/2 lg:shrink-0 lg:border-l lg:border-stone-200">
      <div className="flex shrink-0 items-center gap-3 border-b border-stone-200 px-3 py-2.5">
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-sm font-medium text-stone-900">{title}</div>
          <div className="text-[11px] uppercase tracking-wide text-stone-400">
            {reg?.label ?? spec.kind}
            {stateDoc ? ` · rev ${stateDoc.revision}` : ''}
            {ready ? '' : entryUrl && !error ? ' · loading…' : ''}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-2 text-stone-400 hover:bg-stone-100 hover:text-stone-700"
          title="Close panel"
          aria-label="Close panel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {pendingExternalUrl ? (
        <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-3 py-2 text-sm text-stone-800">
          <div className="font-medium">Open external link?</div>
          <div
            className="mt-0.5 truncate font-mono text-xs text-stone-600"
            title={pendingExternalUrl}
          >
            {pendingExternalUrl}
          </div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={openPendingExternal}
              className="rounded-md bg-stone-900 px-3 py-1 text-xs font-medium text-white hover:bg-stone-800"
            >
              Open
            </button>
            <button
              type="button"
              onClick={dismissPendingExternal}
              className="rounded-md border border-stone-300 bg-white px-3 py-1 text-xs text-stone-700 hover:bg-stone-50"
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 bg-stone-50">
        {error ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-red-700">
            {error}
          </div>
        ) : entryUrl ? (
          <iframe
            ref={iframeRef}
            src={entryUrl}
            sandbox="allow-scripts"
            title={title}
            className="h-full w-full border-0 bg-white"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-stone-500">
            Loading…
          </div>
        )}
      </div>
    </aside>
  );
}
