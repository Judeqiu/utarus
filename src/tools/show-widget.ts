/**
 * Framework built-ins: show_widget, update_widget, read_widget_state.
 */

import { randomUUID } from 'crypto';
import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { WidgetRegistry } from '../widgets/registry.js';
import type { WidgetStateStore } from '../widgets/state-store.js';
import {
  isAllowedWidgetEntryUrl,
  toFence,
  validateStateData,
  validateWidgetSpec,
  WIDGET_INSTANCE_ID_RE,
  WIDGET_PROPS_MAX_BYTES,
  type WidgetSpec,
} from '../widgets/widget-spec.js';

function ok(text: string, details: Record<string, unknown>): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: 'text' as const, text }], details };
}

function fail(text: string): AgentToolResult<null> {
  return { content: [{ type: 'text' as const, text }], details: null };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function propsBytes(props: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(props), 'utf8');
}

function enforcePropsSize(
  props: Record<string, unknown>,
  kindId: string,
  kindMax?: number,
): string | null {
  const n = propsBytes(props);
  if (n > WIDGET_PROPS_MAX_BYTES) {
    return `props exceed WIDGET_PROPS_MAX_BYTES=${WIDGET_PROPS_MAX_BYTES}`;
  }
  if (kindMax !== undefined && n > kindMax) {
    return `Props exceed propsMaxBytes=${kindMax} for kind '${kindId}'`;
  }
  return null;
}

function fenceBlock(spec: WidgetSpec): string {
  return ['```widget', toFence(spec), '```'].join('\n');
}

function successText(opts: {
  instanceId: string;
  revision: number | null;
  title: string;
  kind: string;
  summary?: string;
  fence: string;
}): string {
  const lines = [
    '[Widget — all channels]',
    `instanceId: ${opts.instanceId}`,
    `revision: ${opts.revision ?? 'n/a'}`,
    `title: ${opts.title}`,
    `kind: ${opts.kind}`,
  ];
  if (opts.summary) lines.push(opts.summary);
  lines.push(
    '',
    '---',
    'WEB ONLY — paste this fence once in your final answer (do not invent fences):',
    '',
    opts.fence,
  );
  return lines.join('\n');
}

export function createShowWidgetTools(
  registry: WidgetRegistry,
  ctx: { viewerSlug: string; store: WidgetStateStore },
): AgentTool[] {
  const show_widget: AgentTool = {
    name: 'show_widget',
    label: 'Show Widget',
    description:
      'Open a side-panel widget for the user. For persistent kinds, pass initial state (durable document). ' +
      'On WebUI, paste the WEB ONLY fence once into your final answer. Never invent ```widget fences. ' +
      'Prefer show_widget for first open; use update_widget / read_widget_state afterwards with the same instanceId.',
    parameters: Type.Object({
      kind: Type.String({ description: 'Registered widget kind id' }),
      title: Type.String({ description: 'Panel chrome title' }),
      props: Type.Object({}, { additionalProperties: true, description: 'Bootstrap / overlay props (plain object)' }),
      state: Type.Optional(
        Type.Object({}, {
          additionalProperties: true,
          description: 'Initial durable state.data (required when kind supportsPersistence)',
        }),
      ),
      instanceId: Type.Optional(Type.String({ description: 'Optional UUID; generated if omitted' })),
      summary: Type.Optional(Type.String({ description: 'Optional one-line summary' })),
      entry: Type.Optional(
        Type.String({ description: 'Only for html-bundle: same-origin entry path' }),
      ),
    }),
    async execute(_id, raw) {
      try {
        const p = raw as {
          kind?: string;
          title?: string;
          props?: unknown;
          state?: unknown;
          instanceId?: string;
          summary?: string;
          entry?: string;
        };
        if (typeof p.kind !== 'string' || !p.kind) return fail('kind is required');
        if (typeof p.title !== 'string') return fail('title is required');
        if (!isPlainObject(p.props)) return fail('props must be a plain object');

        const reg = registry.byId.get(p.kind);
        if (!reg) return fail(`Unknown widget kind: ${p.kind}`);

        if (p.kind === 'html-bundle') {
          if (p.state !== undefined) return fail('state is not valid for html-bundle');
          if (typeof p.entry !== 'string' || !p.entry.trim()) {
            return fail('entry is required for html-bundle');
          }
          if (!ctx.viewerSlug && p.entry.includes('/api/files')) {
            return fail('Cannot validate widget entry: no authenticated user slug');
          }
          if (
            !isAllowedWidgetEntryUrl(p.entry.trim(), {
              viewerSlug: ctx.viewerSlug,
              agentKey: registry.agentKey,
            })
          ) {
            return fail(`Invalid widget entry URL: ${p.entry}`);
          }
        } else if (p.entry !== undefined) {
          return fail('entry is only valid for html-bundle');
        }

        const sizeErr = enforcePropsSize(p.props, p.kind, reg.propsMaxBytes);
        if (sizeErr) return fail(sizeErr);

        let instanceId = p.instanceId;
        if (instanceId !== undefined) {
          if (typeof instanceId !== 'string' || !WIDGET_INSTANCE_ID_RE.test(instanceId)) {
            return fail('instanceId must be a UUID when provided');
          }
        } else {
          instanceId = randomUUID();
        }

        let revision: number | null = null;
        if (reg.supportsPersistence) {
          if (!ctx.viewerSlug) {
            return fail('Cannot persist widget state: no authenticated user slug');
          }
          if (p.state === undefined) {
            return fail(`Widget kind '${p.kind}' requires state (supportsPersistence)`);
          }
          if (!isPlainObject(p.state)) return fail('state must be a plain object');
          const sc = validateStateData(p.state);
          if (!sc.ok) return fail(sc.error);
          const saved = await ctx.store.save(
            { backend: 'bindrive', ownerSlug: ctx.viewerSlug, instanceId },
            { kind: p.kind, data: p.state, expectedRevision: 0 },
          );
          if (!saved.ok) {
            return fail(`state save failed (${saved.code}): ${saved.error}`);
          }
          revision = saved.doc.revision;
        } else if (p.state !== undefined) {
          return fail(`Widget kind '${p.kind}' does not support state`);
        }

        const specInput: Record<string, unknown> = {
          action: 'open',
          instanceId,
          kind: p.kind,
          title: p.title,
          props: p.props,
          persistence: reg.supportsPersistence ? 'bindrive' : 'none',
        };
        if (p.summary !== undefined) specInput.summary = p.summary;
        if (p.entry !== undefined) specInput.entry = p.entry.trim();

        const validated = validateWidgetSpec(specInput);
        if (!validated.ok) return fail(`Invalid widget: ${validated.error}`);

        const fence = fenceBlock(validated.spec);
        return ok(
          successText({
            instanceId: validated.spec.instanceId,
            revision,
            title: validated.spec.title,
            kind: validated.spec.kind,
            summary: validated.spec.summary,
            fence,
          }),
          {
            instanceId: validated.spec.instanceId,
            kind: validated.spec.kind,
            revision,
            fence: toFence(validated.spec),
          },
        );
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const update_widget: AgentTool = {
    name: 'update_widget',
    label: 'Update Widget',
    description:
      'Update an existing widget instance. Pass state to fully replace durable state.data (requires current revision match). ' +
      'Pass props for card overlay. Requires same kind as open. Never invent fences — paste the WEB ONLY fence.',
    parameters: Type.Object({
      instanceId: Type.String({ description: 'Instance UUID from show_widget' }),
      kind: Type.String({ description: 'Must match the open kind' }),
      title: Type.String({ description: 'Panel chrome title' }),
      props: Type.Optional(
        Type.Object({}, { additionalProperties: true, description: 'Overlay props; default {}' }),
      ),
      state: Type.Optional(
        Type.Object({}, {
          additionalProperties: true,
          description: 'Full replace of durable state.data',
        }),
      ),
      summary: Type.Optional(Type.String()),
    }),
    async execute(_id, raw) {
      try {
        const p = raw as {
          instanceId?: string;
          kind?: string;
          title?: string;
          props?: unknown;
          state?: unknown;
          summary?: string;
        };
        if (typeof p.instanceId !== 'string' || !WIDGET_INSTANCE_ID_RE.test(p.instanceId)) {
          return fail('instanceId must be a UUID');
        }
        if (typeof p.kind !== 'string' || !p.kind) return fail('kind is required');
        if (typeof p.title !== 'string') return fail('title is required');
        if (p.props === undefined && p.state === undefined) {
          return fail('update_widget requires props and/or state');
        }

        const reg = registry.byId.get(p.kind);
        if (!reg) return fail(`Unknown widget kind: ${p.kind}`);
        if (!reg.supportsUpdate) {
          return fail(`Widget kind '${p.kind}' does not support update_widget`);
        }

        const props = p.props === undefined ? {} : p.props;
        if (!isPlainObject(props)) return fail('props must be a plain object');
        const sizeErr = enforcePropsSize(props, p.kind, reg.propsMaxBytes);
        if (sizeErr) return fail(sizeErr);

        let revision: number | null = null;
        if (p.state !== undefined) {
          if (!reg.supportsPersistence) {
            return fail(`Widget kind '${p.kind}' does not support state`);
          }
          if (!ctx.viewerSlug) {
            return fail('Cannot persist widget state: no authenticated user slug');
          }
          if (!isPlainObject(p.state)) return fail('state must be a plain object');
          const sc = validateStateData(p.state);
          if (!sc.ok) return fail(sc.error);
          const loaded = await ctx.store.load({
            backend: 'bindrive',
            ownerSlug: ctx.viewerSlug,
            instanceId: p.instanceId,
          });
          if (!loaded.ok) {
            return fail(`state load failed (${loaded.code}): ${loaded.error}`);
          }
          if (loaded.doc.kind !== p.kind) {
            return fail(
              `kind mismatch for instanceId (stored '${loaded.doc.kind}', update '${p.kind}')`,
            );
          }
          const saved = await ctx.store.save(
            { backend: 'bindrive', ownerSlug: ctx.viewerSlug, instanceId: p.instanceId },
            {
              kind: p.kind,
              data: p.state,
              expectedRevision: loaded.doc.revision,
            },
          );
          if (!saved.ok) {
            const extra =
              saved.code === 'conflict' && saved.currentRevision !== undefined
                ? ` currentRevision=${saved.currentRevision}`
                : '';
            return fail(`state save failed (${saved.code}): ${saved.error}${extra}`);
          }
          revision = saved.doc.revision;
        }

        const specInput: Record<string, unknown> = {
          action: 'update',
          instanceId: p.instanceId,
          kind: p.kind,
          title: p.title,
          props,
          persistence: reg.supportsPersistence ? 'bindrive' : 'none',
        };
        if (p.summary !== undefined) specInput.summary = p.summary;

        const validated = validateWidgetSpec(specInput);
        if (!validated.ok) return fail(`Invalid widget: ${validated.error}`);

        const fence = fenceBlock(validated.spec);
        return ok(
          successText({
            instanceId: validated.spec.instanceId,
            revision,
            title: validated.spec.title,
            kind: validated.spec.kind,
            summary: validated.spec.summary,
            fence,
          }),
          {
            instanceId: validated.spec.instanceId,
            kind: validated.spec.kind,
            revision,
            fence: toFence(validated.spec),
          },
        );
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const read_widget_state: AgentTool = {
    name: 'read_widget_state',
    label: 'Read Widget State',
    description:
      'Read the durable WidgetStateDocument for an instance (user-owned BinDrive state). Use before update_widget when you need current user edits.',
    parameters: Type.Object({
      instanceId: Type.String({ description: 'Instance UUID' }),
    }),
    async execute(_id, raw) {
      try {
        const p = raw as { instanceId?: string };
        if (typeof p.instanceId !== 'string' || !WIDGET_INSTANCE_ID_RE.test(p.instanceId)) {
          return fail('instanceId must be a UUID');
        }
        if (!ctx.viewerSlug) {
          return fail('Cannot read widget state: no authenticated user slug');
        }
        const loaded = await ctx.store.load({
          backend: 'bindrive',
          ownerSlug: ctx.viewerSlug,
          instanceId: p.instanceId,
        });
        if (!loaded.ok) {
          return fail(`state load failed (${loaded.code}): ${loaded.error}`);
        }
        const d = loaded.doc;
        const text = [
          `instanceId: ${d.instanceId}`,
          `kind: ${d.kind}`,
          `revision: ${d.revision}`,
          `updatedAt: ${d.updatedAt}`,
          '',
          'data:',
          JSON.stringify(d.data),
        ].join('\n');
        return ok(text, {
          instanceId: d.instanceId,
          kind: d.kind,
          revision: d.revision,
          data: d.data,
        });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  };

  return [show_widget, update_widget, read_widget_state];
}
