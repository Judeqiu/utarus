/**
 * WidgetStateStore — deep seam for durable widget instance state.
 */

export interface WidgetStateRef {
  backend: 'bindrive';
  ownerSlug: string;
  instanceId: string;
}

export interface WidgetStateDocument {
  instanceId: string;
  kind: string;
  revision: number;
  updatedAt: string;
  data: Record<string, unknown>;
}

export type WidgetStateLoadResult =
  | { ok: true; doc: WidgetStateDocument }
  | {
      ok: false;
      error: string;
      code: 'not_found' | 'invalid' | 'unauthorized' | 'backend';
    };

export type WidgetStateSaveResult =
  | { ok: true; doc: WidgetStateDocument }
  | {
      ok: false;
      error: string;
      code: 'conflict' | 'not_found' | 'invalid' | 'unauthorized' | 'too_large' | 'backend';
      currentRevision?: number;
    };

export interface WidgetStateStore {
  load(ref: WidgetStateRef): Promise<WidgetStateLoadResult>;
  save(
    ref: WidgetStateRef,
    input: {
      kind: string;
      data: Record<string, unknown>;
      expectedRevision: number;
    },
  ): Promise<WidgetStateSaveResult>;
}
