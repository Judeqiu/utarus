/**
 * DiagramEmbed — inline Mermaid render + expand overlay (pan/zoom scroll).
 * Source is free ```mermaid fence body.
 * htmlLabels + securityLevel antiscript so agent labels like <b>Title</b> render;
 * diagram-spec strips script/iframe/handlers first.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { Maximize2, X, ZoomIn, ZoomOut } from 'lucide-react';
import { CHAT_EMBED_PROPS } from '../../embeds/chat-embed.js';
import { validateMermaidSource } from '../../diagrams/diagram-spec.js';
import { DiagramError } from './DiagramError.js';

export interface DiagramEmbedProps {
  /** Mermaid source (fence body). */
  source: string;
}

type RenderState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; svg: string };

let mermaidInitPromise: Promise<typeof import('mermaid').default> | null = null;
let renderSeq = 0;

function prefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

function mermaidConfig() {
  return {
    startOnLoad: false as const,
    // antiscript: allow formatting HTML in labels (<b>, <br/>, …) but not <script>.
    // strict + htmlLabels:false showed raw "<b>…" text (agent-emitted labels).
    securityLevel: 'antiscript' as const,
    htmlLabels: true,
    theme: prefersDark() ? ('dark' as const) : ('default' as const),
    fontFamily: 'ui-sans-serif, system-ui, sans-serif',
  };
}

async function getMermaid(): Promise<typeof import('mermaid').default> {
  if (!mermaidInitPromise) {
    mermaidInitPromise = (async () => {
      const mermaid = (await import('mermaid')).default;
      mermaid.initialize(mermaidConfig());
      return mermaid;
    })();
  }
  return mermaidInitPromise;
}

/** Test helper — reset mermaid init (theme/config). */
export function resetMermaidInitForTests(): void {
  mermaidInitPromise = null;
}

function DiagramSvg({
  svg,
  className,
}: {
  svg: string;
  className?: string;
}) {
  return (
    <div
      className={className}
      // Mermaid SVG (antiscript + prepared source).
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function ExpandOverlay({
  svg,
  onClose,
}: {
  svg: string;
  onClose: () => void;
}) {
  const [scale, setScale] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const zoomIn = () =>
    setScale((s) => Math.min(3, Math.round((s + 0.25) * 100) / 100));
  const zoomOut = () =>
    setScale((s) => Math.max(0.5, Math.round((s - 0.25) * 100) / 100));

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/60 p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Expanded diagram"
      onClick={onClose}
    >
      <div
        className="mx-auto flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-stone-200 bg-white shadow-xl dark:border-stone-700 dark:bg-stone-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-stone-200 px-3 py-2 dark:border-stone-700">
          <span className="text-sm font-medium text-stone-800 dark:text-stone-100">
            Diagram
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={zoomOut}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800"
              aria-label="Zoom out"
            >
              <ZoomOut className="h-4 w-4" />
            </button>
            <span className="min-w-[3rem] text-center text-xs tabular-nums text-stone-500">
              {Math.round(scale * 100)}%
            </span>
            <button
              type="button"
              onClick={zoomIn}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800"
              aria-label="Zoom in"
            >
              <ZoomIn className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="ml-1 inline-flex h-8 w-8 items-center justify-center rounded-md text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-auto bg-stone-50 p-4 dark:bg-stone-950"
        >
          <div
            className="inline-block origin-top-left transition-transform duration-100 [&_svg]:max-w-none"
            style={{ transform: `scale(${scale})` }}
          >
            <DiagramSvg svg={svg} />
          </div>
        </div>
      </div>
    </div>
  );
}

export function DiagramEmbed({ source }: DiagramEmbedProps) {
  const reactId = useId().replace(/:/g, '');
  const [state, setState] = useState<RenderState>({ status: 'loading' });
  const [expanded, setExpanded] = useState(false);
  const validated = validateMermaidSource(source);
  const safeSource = validated.ok ? validated.source : null;
  const validationError = validated.ok ? null : validated.error;

  useEffect(() => {
    if (safeSource === null) {
      return;
    }
    let cancelled = false;
    void (async () => {
      setState({ status: 'loading' });
      const id = `mermaid-${reactId}-${++renderSeq}`;
      try {
        const mermaid = await getMermaid();
        mermaid.initialize(mermaidConfig());
        const { svg } = await mermaid.render(id, safeSource);
        if (!cancelled) setState({ status: 'ok', svg });
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        setState({
          status: 'error',
          message: message.trim() || 'Mermaid render failed',
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reactId, safeSource]);

  if (validationError !== null) {
    return <DiagramError message={validationError} />;
  }

  if (state.status === 'loading') {
    return (
      <div
        {...CHAT_EMBED_PROPS}
        data-diagram-embed
        className="my-3 w-full max-w-2xl rounded-lg border border-stone-200 bg-stone-50 px-3 py-8 text-center text-sm text-stone-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400"
      >
        Rendering diagram…
      </div>
    );
  }

  if (state.status === 'error') {
    return <DiagramError message={state.message} />;
  }

  // Single root + CHAT_EMBED_PROPS: see web/src/embeds/chat-embed.ts
  // (no Fragment — Fragment left the dark .prose-chat pre shell / black card).
  return (
    <div
      {...CHAT_EMBED_PROPS}
      data-diagram-embed
      className="my-3 w-full max-w-3xl overflow-hidden rounded-lg border border-stone-200 bg-white dark:border-stone-700 dark:bg-stone-900"
    >
      <div className="flex items-center justify-between gap-2 border-b border-stone-200 px-3 py-2 dark:border-stone-700">
        <span className="truncate text-sm font-medium text-stone-800 dark:text-stone-100">
          Diagram
        </span>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="inline-flex shrink-0 items-center gap-1 text-xs text-sky-700 hover:underline dark:text-sky-400"
        >
          Expand
          <Maximize2 className="h-3 w-3" />
        </button>
      </div>
      <div className="overflow-x-auto p-3 [&_svg]:mx-auto [&_svg]:max-h-[420px] [&_svg]:w-auto [&_svg]:max-w-full">
        <DiagramSvg svg={state.svg} />
      </div>
      {expanded ? (
        <ExpandOverlay svg={state.svg} onClose={() => setExpanded(false)} />
      ) : null}
    </div>
  );
}

DiagramEmbed.displayName = 'DiagramEmbed';
