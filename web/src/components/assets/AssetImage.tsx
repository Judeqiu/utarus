/**
 * AssetImage — inline <img> with click-to-zoom lightbox and HTTP-error
 * fallback to a file card.
 *
 * Spec: docs/webui-chat-design.md §8.5.
 */

import { useEffect, useState } from 'react';
import type { ComponentPropsWithoutRef } from 'react';
import { AlertCircle, X } from 'lucide-react';

interface AssetImageProps extends ComponentPropsWithoutRef<'img'> {}

export function AssetImage(props: AssetImageProps) {
  const src = typeof props.src === 'string' ? props.src : '';
  const filename = getDataAttr(props, 'data-asset-filename') ?? props.alt ?? '';
  const [failed, setFailed] = useState(false);
  const [lightbox, setLightbox] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (!src) return null;

  if (failed) {
    return (
      <div className="my-3">
        <div className="inline-flex items-center gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <AlertCircle className="h-4 w-4" />
          <span>Failed to load <strong>{filename}</strong> — session may have expired. Reload the page.</span>
        </div>
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setLightbox(true)}
        className="my-3 block cursor-zoom-in"
      >
        <img
          {...props}
          src={src}
          loading="lazy"
          onError={() => setFailed(true)}
          className="max-h-[480px] rounded border border-slate-200 bg-white"
        />
      </button>
      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
          onClick={() => setLightbox(false)}
        >
          <button
            type="button"
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
          <img
            src={src}
            alt={props.alt ?? filename}
            className="max-h-full max-w-full rounded shadow-2xl"
          />
        </div>
      )}
    </>
  );
}

function getDataAttr(
  props: Record<string, unknown>,
  name: string,
): string | undefined {
  const v = props[name];
  return typeof v === 'string' ? v : undefined;
}
