/**
 * Tiny domain tool — free users have a low monthly cap (see plans.free.caps.tools.hello).
 * Also demonstrates hasFeature for a Pro-only greeting mode.
 */

import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { hasFeature, isBillingEnabled } from 'utarus';

export function createHelloTool(userSlug: string): AgentTool {
  return {
    name: 'hello',
    label: 'Hello',
    description:
      'Greet the user. Use when they say hi or ask for a demo tool call. ' +
      'Optional fancy=true requires Pro feature pro_tools when billing is on.',
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: 'Name to greet' })),
      fancy: Type.Optional(
        Type.Boolean({
          description: 'Pro-only fancy greeting (feature pro_tools)',
        }),
      ),
    }),
    execute: async (_id, params: unknown) => {
      const p = (params ?? {}) as { name?: string; fancy?: boolean };
      const who = (p.name || 'friend').trim() || 'friend';
      if (p.fancy === true) {
        if (isBillingEnabled() && !hasFeature(userSlug, 'pro_tools')) {
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  'Fancy hello is a Pro feature. Open Billing in the WebUI (or /upgrade on Telegram) to upgrade.',
              },
            ],
            details: { featureGate: 'pro_tools' },
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: `✨ Hello, ${who}! (Pro fancy mode)`,
            },
          ],
          details: { fancy: true },
        };
      }
      return {
        content: [{ type: 'text' as const, text: `Hello, ${who}!` }],
        details: { fancy: false },
      };
    },
  };
}
