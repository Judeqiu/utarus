/**
 * MapEmbed — Google Maps Embed iframe from validated map props.
 * Key from GET /api/maps/config; never from message text.
 */

import { useEffect, useState } from 'react';
import {
  buildGoogleEmbedUrl,
  isAllowedMapEmbedUrl,
  toOpenUrl,
  validateMapSpec,
  type MapMode,
  type MapSpec,
} from '../../maps/map-spec.js';
import { MapError } from './MapError.js';
import { ExternalLink } from 'lucide-react';

export interface MapEmbedProps {
  mode: MapMode;
  query?: string;
  lat?: number;
  lng?: number;
  zoom?: number;
  label?: string;
}

type ConfigState =
  | { status: 'loading' }
  | { status: 'disabled' }
  | { status: 'error'; message: string }
  | { status: 'ok'; embedApiKey: string };

let configPromise: Promise<ConfigState> | null = null;

async function loadMapsConfig(): Promise<ConfigState> {
  if (!configPromise) {
    configPromise = (async () => {
      try {
        const res = await fetch('/api/maps/config', { credentials: 'include' });
        if (res.status === 401) {
          return { status: 'error', message: 'Maps configuration error: not authenticated' };
        }
        if (res.status === 500) {
          let message = 'Maps configuration error';
          try {
            const body = (await res.json()) as { message?: string };
            if (typeof body.message === 'string' && body.message) message = body.message;
          } catch {
            /* keep default */
          }
          return { status: 'error', message: `Maps configuration error: ${message}` };
        }
        if (!res.ok) {
          return {
            status: 'error',
            message: `Maps configuration error: HTTP ${res.status}`,
          };
        }
        const body = (await res.json()) as {
          enabled?: boolean;
          embedApiKey?: string;
        };
        if (body.enabled === false) {
          return { status: 'disabled' };
        }
        if (body.enabled !== true) {
          return {
            status: 'error',
            message: 'Maps configuration error: invalid response',
          };
        }
        if (typeof body.embedApiKey !== 'string' || !body.embedApiKey.trim()) {
          return {
            status: 'error',
            message: 'Maps configuration error: missing embedApiKey',
          };
        }
        return { status: 'ok', embedApiKey: body.embedApiKey.trim() };
      } catch (e) {
        return {
          status: 'error',
          message: `Maps configuration error: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    })();
  }
  return configPromise;
}

/** Test helper — reset in-flight config fetch. */
export function resetMapsConfigCacheForTests(): void {
  configPromise = null;
}

export function MapEmbed(props: MapEmbedProps) {
  const [config, setConfig] = useState<ConfigState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void loadMapsConfig().then((c) => {
      if (!cancelled) setConfig(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const validated = validateMapSpec({
    mode: props.mode,
    query: props.query,
    lat: props.lat,
    lng: props.lng,
    zoom: props.zoom,
    label: props.label,
  });
  if (!validated.ok) {
    return <MapError message={validated.error} />;
  }
  const spec: MapSpec = validated.spec;

  if (config.status === 'loading') {
    return (
      <div className="my-3 w-full max-w-2xl rounded-lg border border-stone-200 bg-stone-50 px-3 py-8 text-center text-sm text-stone-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400">
        Loading map…
      </div>
    );
  }
  if (config.status === 'disabled') {
    return (
      <div
        className="my-3 w-full max-w-2xl rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100"
        role="status"
      >
        Maps are not enabled on this server
      </div>
    );
  }
  if (config.status === 'error') {
    return (
      <div
        className="my-3 w-full max-w-2xl rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100"
        role="alert"
      >
        {config.message}
      </div>
    );
  }

  let src: string;
  try {
    src = buildGoogleEmbedUrl(spec, config.embedApiKey);
  } catch (e) {
    return (
      <MapError message={e instanceof Error ? e.message : String(e)} />
    );
  }
  if (!isAllowedMapEmbedUrl(src)) {
    return <MapError message="Map embed URL failed allowlist check" />;
  }

  let openUrl: string;
  try {
    openUrl = toOpenUrl(spec);
  } catch (e) {
    return <MapError message={e instanceof Error ? e.message : String(e)} />;
  }

  const title = spec.label ?? spec.query ?? 'Map';

  return (
    <div className="my-3 w-full max-w-2xl overflow-hidden rounded-lg border border-stone-200 bg-white dark:border-stone-700 dark:bg-stone-900">
      <div className="flex items-center justify-between gap-2 border-b border-stone-200 px-3 py-2 dark:border-stone-700">
        <span className="truncate text-sm font-medium text-stone-800 dark:text-stone-100">
          {title}
        </span>
        <a
          href={openUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-1 text-xs text-sky-700 hover:underline dark:text-sky-400"
        >
          Open in Google Maps
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
      <iframe
        title={title}
        src={src}
        loading="lazy"
        referrerPolicy="strict-origin-when-cross-origin"
        allowFullScreen
        className="h-[320px] min-h-[280px] w-full border-0"
      />
    </div>
  );
}
