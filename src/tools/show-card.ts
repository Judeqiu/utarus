/**
 * Framework built-in: show_card — emit a validated card fence + plain summary.
 * Domain agents do not own this tool; it is registered for every Utarus runtime.
 */

import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import {
  toFence,
  toPlainSummary,
  validateCardDeckSpec,
  type InfoCardDeckSpec,
} from '../cards/card-spec.js';

function ok(text: string, details: Record<string, unknown>): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: 'text' as const, text }], details };
}

function fail(text: string): AgentToolResult<null> {
  return { content: [{ type: 'text' as const, text }], details: null };
}

const cardItemSchema = Type.Object({
  title: Type.String({ description: 'Card title (required)' }),
  subtitle: Type.Optional(Type.String()),
  body: Type.Optional(Type.String({ description: 'Markdown subset body (bold/italic/code/links only)' })),
  fields: Type.Optional(
    Type.Array(
      Type.Object({
        label: Type.String(),
        value: Type.String(),
      }),
    ),
  ),
  badges: Type.Optional(
    Type.Array(
      Type.Object({
        label: Type.String(),
        tone: Type.Optional(
          Type.Union([
            Type.Literal('neutral'),
            Type.Literal('success'),
            Type.Literal('warning'),
            Type.Literal('danger'),
            Type.Literal('info'),
          ]),
        ),
      }),
    ),
  ),
  footer: Type.Optional(Type.String()),
  accent: Type.Optional(Type.String({ description: 'Hex accent #RGB or #RRGGBB' })),
  icon: Type.Optional(Type.String({ description: 'Allowlisted Lucide icon name' })),
});

const SINGLE_CARD_KEYS = [
  'title',
  'subtitle',
  'body',
  'fields',
  'badges',
  'footer',
  'accent',
  'icon',
] as const;

export function createShowCardTool(): AgentTool {
  return {
    name: 'show_card',
    label: 'Show Card',
    description:
      'Show one or more designed information cards inline in WebUI chat (profile, comparison, status, short options). ' +
      'Pass either `cards` (1–8 items) OR single-card convenience fields (`title` + optional fields) — not both. ' +
      'On WebUI, paste the WEB ONLY fence once into your final answer so cards render. ' +
      'On Telegram/Slack, use only the summary lines — do not paste the fence (it renders as an ugly code block). ' +
      'Never invent ```card fences yourself — always call this tool. Prefer at most one deck fence per final answer. ' +
      'Not for large documents (use rich-document / reports) or interactive 3D (use widgets).',
    parameters: Type.Object({
      cards: Type.Optional(
        Type.Array(cardItemSchema, {
          description: '1–8 cards. Mutually exclusive with single-card convenience fields.',
        }),
      ),
      title: Type.Optional(Type.String({ description: 'Single-card title (when not using cards[])' })),
      subtitle: Type.Optional(Type.String()),
      body: Type.Optional(Type.String()),
      fields: Type.Optional(
        Type.Array(
          Type.Object({
            label: Type.String(),
            value: Type.String(),
          }),
        ),
      ),
      badges: Type.Optional(
        Type.Array(
          Type.Object({
            label: Type.String(),
            tone: Type.Optional(
              Type.Union([
                Type.Literal('neutral'),
                Type.Literal('success'),
                Type.Literal('warning'),
                Type.Literal('danger'),
                Type.Literal('info'),
              ]),
            ),
          }),
        ),
      ),
      footer: Type.Optional(Type.String()),
      accent: Type.Optional(Type.String()),
      icon: Type.Optional(Type.String()),
    }),
    async execute(_id, raw) {
      try {
        const p = raw as Record<string, unknown>;
        const hasCards = p.cards !== undefined;
        const hasConvenience = SINGLE_CARD_KEYS.some((k) => p[k] !== undefined);

        if (hasCards && hasConvenience) {
          return fail('pass either cards[] or single-card fields, not both');
        }

        let loose: unknown;
        if (hasCards) {
          loose = { version: 1, layout: 'stack', cards: p.cards };
        } else if (p.title !== undefined) {
          const card: Record<string, unknown> = { title: p.title };
          for (const k of SINGLE_CARD_KEYS) {
            if (k === 'title') continue;
            if (p[k] !== undefined) card[k] = p[k];
          }
          loose = { version: 1, layout: 'stack', cards: [card] };
        } else {
          return fail('cards or title is required');
        }

        const result = validateCardDeckSpec(loose);
        if (!result.ok) {
          return fail(`Invalid card: ${result.error}`);
        }
        const spec: InfoCardDeckSpec = result.spec;
        const fence = toFence(spec);
        const summary = toPlainSummary(spec);
        const text = [
          '[Cards — use on all channels]',
          summary,
          '',
          '---',
          'WEB ONLY — paste this fence once in your final answer (do not invent fences):',
          '',
          '```card',
          fence,
          '```',
        ].join('\n');
        return ok(text, { fence, cardCount: spec.cards.length });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  };
}
