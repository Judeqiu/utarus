/**
 * Widget postMessage bridge types + helpers.
 */

export const WIDGET_CHANNEL = 'utarus-widget' as const;

export type WidgetHostToGuest =
  | {
      channel: typeof WIDGET_CHANNEL;
      type: 'init';
      instanceId: string;
      kind: string;
      /** Panel chrome title — used for export filenames. */
      title: string;
      props: Record<string, unknown>;
      theme: { colorScheme: 'light' | 'dark' };
      state: { revision: number; data: Record<string, unknown> } | null;
    }
  | {
      channel: typeof WIDGET_CHANNEL;
      type: 'update';
      instanceId: string;
      props: Record<string, unknown>;
      state?: { revision: number; data: Record<string, unknown> };
    }
  | {
      channel: typeof WIDGET_CHANNEL;
      type: 'state_saved';
      instanceId: string;
      revision: number;
    }
  | {
      channel: typeof WIDGET_CHANNEL;
      type: 'state_error';
      instanceId: string;
      code: string;
      message: string;
      currentRevision?: number;
    }
  | {
      channel: typeof WIDGET_CHANNEL;
      type: 'open_external_result';
      instanceId: string;
      ok: boolean;
      error?: string;
    }
  | {
      channel: typeof WIDGET_CHANNEL;
      type: 'export_result';
      instanceId: string;
      ok: boolean;
      format?: 'docx' | 'pdf';
      filename?: string;
      error?: string;
    };

export type WidgetGuestToHost =
  | { channel: typeof WIDGET_CHANNEL; type: 'ready'; instanceId: string }
  | { channel: typeof WIDGET_CHANNEL; type: 'error'; instanceId: string; message: string }
  | { channel: typeof WIDGET_CHANNEL; type: 'resize'; instanceId: string; height: number }
  | {
      channel: typeof WIDGET_CHANNEL;
      type: 'state_save';
      instanceId: string;
      expectedRevision: number;
      data: Record<string, unknown>;
    }
  | {
      channel: typeof WIDGET_CHANNEL;
      type: 'open_external';
      instanceId: string;
      url: string;
    }
  | {
      channel: typeof WIDGET_CHANNEL;
      type: 'export';
      instanceId: string;
      format: 'docx' | 'pdf';
      markdown: string;
      title: string;
    }
  | {
      channel: typeof WIDGET_CHANNEL;
      type: 'quote';
      instanceId: string;
      kind: string;
      title: string;
      text: string;
    };

export function isWidgetGuestMessage(data: unknown): data is WidgetGuestToHost {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return false;
  const o = data as Record<string, unknown>;
  if (o.channel !== WIDGET_CHANNEL) return false;
  if (typeof o.type !== 'string') return false;
  if (typeof o.instanceId !== 'string') return false;
  return (
    o.type === 'ready' ||
    o.type === 'error' ||
    o.type === 'resize' ||
    o.type === 'state_save' ||
    o.type === 'open_external' ||
    o.type === 'export' ||
    o.type === 'quote'
  );
}

export function themeColorScheme(): 'light' | 'dark' {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
