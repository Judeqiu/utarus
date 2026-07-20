/**
 * BinDrive-backed WidgetStateStore.
 * Path: {driveRoot}/{ownerSlug}/_utarus/widgets/{instanceId}/state.json
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from 'fs';
import { dirname, join } from 'path';
import { WIDGET_INSTANCE_ID_RE, validateStateData } from './widget-spec.js';
import type {
  WidgetStateDocument,
  WidgetStateLoadResult,
  WidgetStateRef,
  WidgetStateSaveResult,
  WidgetStateStore,
} from './state-store.js';

const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function assertRef(ref: WidgetStateRef): string | null {
  if (ref.backend !== 'bindrive') return 'backend must be bindrive';
  if (!ref.ownerSlug || !SLUG_RE.test(ref.ownerSlug)) return 'invalid ownerSlug';
  if (!ref.instanceId || !WIDGET_INSTANCE_ID_RE.test(ref.instanceId)) {
    return 'invalid instanceId';
  }
  if (ref.ownerSlug.includes('..') || ref.instanceId.includes('..')) {
    return 'path traversal rejected';
  }
  return null;
}

function statePath(driveRoot: string, ref: WidgetStateRef): string {
  return join(
    driveRoot,
    ref.ownerSlug,
    '_utarus',
    'widgets',
    ref.instanceId,
    'state.json',
  );
}

function parseDoc(raw: string, instanceId: string): WidgetStateLoadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      error: `invalid state JSON: ${e instanceof Error ? e.message : String(e)}`,
      code: 'invalid',
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'state document must be an object', code: 'invalid' };
  }
  const o = parsed as Record<string, unknown>;
  if (o.instanceId !== instanceId) {
    return { ok: false, error: 'instanceId mismatch in document', code: 'invalid' };
  }
  if (typeof o.kind !== 'string' || !o.kind) {
    return { ok: false, error: 'kind missing in document', code: 'invalid' };
  }
  if (typeof o.revision !== 'number' || !Number.isInteger(o.revision) || o.revision < 1) {
    return { ok: false, error: 'revision invalid in document', code: 'invalid' };
  }
  if (typeof o.updatedAt !== 'string') {
    return { ok: false, error: 'updatedAt missing', code: 'invalid' };
  }
  if (o.data === null || typeof o.data !== 'object' || Array.isArray(o.data)) {
    return { ok: false, error: 'data must be a plain object', code: 'invalid' };
  }
  return {
    ok: true,
    doc: {
      instanceId: o.instanceId as string,
      kind: o.kind,
      revision: o.revision,
      updatedAt: o.updatedAt,
      data: o.data as Record<string, unknown>,
    },
  };
}

export function createBinDriveWidgetStateStore(deps: {
  driveRoot: string;
}): WidgetStateStore {
  const { driveRoot } = deps;
  if (!driveRoot || typeof driveRoot !== 'string') {
    throw new Error('createBinDriveWidgetStateStore requires driveRoot');
  }

  return {
    async load(ref: WidgetStateRef): Promise<WidgetStateLoadResult> {
      const err = assertRef(ref);
      if (err) return { ok: false, error: err, code: 'invalid' };
      const path = statePath(driveRoot, ref);
      if (!existsSync(path)) {
        return { ok: false, error: 'Widget state not found', code: 'not_found' };
      }
      try {
        const raw = readFileSync(path, 'utf8');
        return parseDoc(raw, ref.instanceId);
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          code: 'backend',
        };
      }
    },

    async save(
      ref: WidgetStateRef,
      input: {
        kind: string;
        data: Record<string, unknown>;
        expectedRevision: number;
      },
    ): Promise<WidgetStateSaveResult> {
      const err = assertRef(ref);
      if (err) return { ok: false, error: err, code: 'invalid' };
      if (typeof input.kind !== 'string' || !input.kind.trim()) {
        return { ok: false, error: 'kind is required', code: 'invalid' };
      }
      if (
        typeof input.expectedRevision !== 'number' ||
        !Number.isInteger(input.expectedRevision) ||
        input.expectedRevision < 0
      ) {
        return { ok: false, error: 'expectedRevision must be integer >= 0', code: 'invalid' };
      }
      const sizeCheck = validateStateData(input.data);
      if (!sizeCheck.ok) {
        return { ok: false, error: sizeCheck.error, code: 'too_large' };
      }

      const path = statePath(driveRoot, ref);
      let current: WidgetStateDocument | null = null;
      if (existsSync(path)) {
        try {
          const loaded = parseDoc(readFileSync(path, 'utf8'), ref.instanceId);
          if (!loaded.ok) {
            return { ok: false, error: loaded.error, code: 'invalid' };
          }
          current = loaded.doc;
        } catch (e) {
          return {
            ok: false,
            error: e instanceof Error ? e.message : String(e),
            code: 'backend',
          };
        }
      }

      if (input.expectedRevision === 0) {
        if (current) {
          return {
            ok: false,
            error: `state already exists (revision ${current.revision})`,
            code: 'conflict',
            currentRevision: current.revision,
          };
        }
      } else {
        if (!current) {
          return { ok: false, error: 'Widget state not found', code: 'not_found' };
        }
        if (current.revision !== input.expectedRevision) {
          return {
            ok: false,
            error: `revision conflict: expected ${input.expectedRevision}, current ${current.revision}`,
            code: 'conflict',
            currentRevision: current.revision,
          };
        }
        if (current.kind !== input.kind) {
          return {
            ok: false,
            error: `kind mismatch: stored '${current.kind}', save '${input.kind}'`,
            code: 'invalid',
          };
        }
      }

      const nextRevision =
        input.expectedRevision === 0 ? 1 : input.expectedRevision + 1;
      const doc: WidgetStateDocument = {
        instanceId: ref.instanceId,
        kind: input.kind,
        revision: nextRevision,
        updatedAt: new Date().toISOString(),
        data: input.data,
      };

      try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.tmp.${process.pid}`;
        writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
        renameSync(tmp, path);
        return { ok: true, doc };
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          code: 'backend',
        };
      }
    },
  };
}

/** In-memory store for tests. */
export function createMemoryWidgetStateStore(): WidgetStateStore {
  const docs = new Map<string, WidgetStateDocument>();
  const key = (ref: WidgetStateRef) => `${ref.ownerSlug}/${ref.instanceId}`;

  return {
    async load(ref) {
      const err = assertRef(ref);
      if (err) return { ok: false, error: err, code: 'invalid' };
      const doc = docs.get(key(ref));
      if (!doc) return { ok: false, error: 'Widget state not found', code: 'not_found' };
      return { ok: true, doc: { ...doc, data: { ...doc.data } } };
    },
    async save(ref, input) {
      const err = assertRef(ref);
      if (err) return { ok: false, error: err, code: 'invalid' };
      const sizeCheck = validateStateData(input.data);
      if (!sizeCheck.ok) {
        return { ok: false, error: sizeCheck.error, code: 'too_large' };
      }
      const k = key(ref);
      const current = docs.get(k) ?? null;
      if (input.expectedRevision === 0) {
        if (current) {
          return {
            ok: false,
            error: 'exists',
            code: 'conflict',
            currentRevision: current.revision,
          };
        }
      } else {
        if (!current) return { ok: false, error: 'not found', code: 'not_found' };
        if (current.revision !== input.expectedRevision) {
          return {
            ok: false,
            error: 'conflict',
            code: 'conflict',
            currentRevision: current.revision,
          };
        }
      }
      const doc: WidgetStateDocument = {
        instanceId: ref.instanceId,
        kind: input.kind,
        revision: input.expectedRevision === 0 ? 1 : input.expectedRevision + 1,
        updatedAt: new Date().toISOString(),
        data: { ...input.data },
      };
      docs.set(k, doc);
      return { ok: true, doc: { ...doc, data: { ...doc.data } } };
    },
  };
}
