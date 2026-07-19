/**
 * Framework built-in: show_map — emit a validated map fence + open URL.
 * Domain agents do not own this tool; it is registered for every Utarus runtime.
 */

import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { isMapsEnabled } from '../maps/config.js';
import {
  toFence,
  toOpenUrl,
  validateMapSpec,
  type MapSpec,
} from '../maps/map-spec.js';

function ok(text: string, details: Record<string, unknown>): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: 'text' as const, text }], details };
}

function fail(text: string): AgentToolResult<null> {
  return { content: [{ type: 'text' as const, text }], details: null };
}

export function createShowMapTool(): AgentTool {
  return {
    name: 'show_map',
    label: 'Show Map',
    description:
      'Show a place or coordinates as a map. On WebUI, paste the WEB ONLY fence once into your final answer so an interactive map renders. ' +
      'On Telegram/Slack, use only the map link line — do not paste the fence (it renders as an ugly code block). ' +
      'Never invent ```map fences yourself — always call this tool. Prefer at most one map per final answer. ' +
      'Use when a concrete place or lat/lng would help the user.',
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description: 'Place search text (address, venue, "City, Country"). Required for place mode.',
        }),
      ),
      lat: Type.Optional(Type.Number({ description: 'Latitude [-90, 90]. Required with lng for view mode.' })),
      lng: Type.Optional(Type.Number({ description: 'Longitude [-180, 180]. Required with lat for view mode.' })),
      zoom: Type.Optional(
        Type.Number({ description: 'Optional integer zoom 0–21. Omit to let Google choose.' }),
      ),
      label: Type.Optional(Type.String({ description: 'Optional short chrome title (max 80 chars).' })),
      mode: Type.Optional(
        Type.Union([Type.Literal('place'), Type.Literal('view')], {
          description: 'place (query) or view (lat/lng). Omit: place if query, view if coords only.',
        }),
      ),
    }),
    async execute(_id, raw) {
      try {
        if (!isMapsEnabled()) {
          return fail('Maps are not enabled on this server');
        }
        const p = raw as {
          query?: string;
          lat?: number;
          lng?: number;
          zoom?: number;
          label?: string;
          mode?: 'place' | 'view';
        };
        // Fail-fast: no coercion of string zoom/lat/lng
        const result = validateMapSpec(p);
        if (!result.ok) {
          return fail(`Invalid map: ${result.error}`);
        }
        const spec: MapSpec = result.spec;
        const fence = toFence(spec);
        const openUrl = toOpenUrl(spec);
        const title = spec.label ?? spec.query ?? `${spec.lat},${spec.lng}`;
        const text = [
          '[Map link — use on all channels]',
          `${title}: ${openUrl}`,
          '',
          '---',
          'WEB ONLY — paste this fence once in your final answer (do not invent fences):',
          '',
          '```map',
          fence,
          '```',
        ].join('\n');
        return ok(text, { openUrl, fence, mode: spec.mode });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  };
}
