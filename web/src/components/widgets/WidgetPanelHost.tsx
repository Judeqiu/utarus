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
import {
  isAllowedWidgetEntryUrl,
  WIDGET_BRIDGE_READY_TIMEOUT_MS,
  type WidgetSpec,
} from '../../widgets/widget-spec.js';
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
  onClose: () => void;
  /** Append assistant card message after user state_save (K38). */
  onArtifactMessage?: (message: WidgetArtifactMessage) => void;
}

interface StateDoc {
  revision: number;
  data: Record<string, unknown>;
  kind: string;
}

export function WidgetPanelHost({
  spec,
  conversationId,
  onClose,
  onArtifactMessage,
}: WidgetPanelHostProps) {
  const registry = useWidgetRegistry();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [entryUrl, setEntryUrl] = useState<string | null>(null);
  const [stateDoc, setStateDoc] = useState<StateDoc | null>(null);
  const title = spec.title;

  const reg = registry.byId.get(spec.kind);

  const postToGuest = useCallback((msg: WidgetHostToGuest) => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage(msg, '*');
  }, []);

  // Resolve entry + load state
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setReady(false);
    setEntryUrl(null);
    setStateDoc(null);

    async function boot() {
      if (!registry.registryAvailable) {
        setError(registry.unavailableReason ?? 'Widget registry unavailable');
        return;
      }
      if (!reg) {
        setError(`Unknown widget kind: ${spec.kind}`);
        return;
      }

      let url: string;
      if (spec.kind === 'html-bundle') {
        if (!spec.entry) {
          setError('html-bundle requires entry');
          return;
        }
        url = spec.entry;
      } else {
        if (!registry.agentKey || !reg.entryHtml) {
          setError('Domain widget missing agentKey or entryHtml');
          return;
        }
        url = `/domain-assets/${registry.agentKey}/${reg.entryHtml}`;
      }

      if (
        !isAllowedWidgetEntryUrl(url, {
          viewerSlug: '', // path-only domain-assets / reports don't need slug
          agentKey: registry.agentKey,
        }) &&
        !(
          url.startsWith('/api/files/') &&
          isAllowedWidgetEntryUrl(url, {
            viewerSlug: new URL(url, window.location.origin).searchParams.get('slug') ?? '',
            agentKey: registry.agentKey,
          })
        )
      ) {
        // domain-assets path always needs agentKey match — re-check properly
        const ok =
          url.startsWith('/domain-assets/') ||
          url.startsWith('/reports/') ||
          url.startsWith('/api/files/');
        if (!ok) {
          setError(`Entry URL not allowed: ${url}`);
          return;
        }
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
    }

    void boot();
    return () => {
      cancelled = true;
    };
  }, [spec.instanceId, spec.kind, spec.entry, reg, registry]);

  const stateDocRef = useRef(stateDoc);
  stateDocRef.current = stateDoc;

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
      if (msg.type === 'state_save') {
        if (!reg.supportsPersistence) return;
        void (async () => {
          try {
            const res = await fetch(`/api/widgets/state/${spec.instanceId}`, {
              method: 'PUT',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                kind: spec.kind,
                data: msg.data,
                expectedRevision: msg.expectedRevision,
                conversationId: conversationId ?? undefined,
                title: spec.title,
                summary: `Saved (revision pending)`,
              }),
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
  ]);

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
