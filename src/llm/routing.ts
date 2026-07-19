/**
 * Deterministic per-turn LLM profile selection.
 */

import {
  getLlmProfile,
  getLlmRouting,
  getLlmStack,
  isLlmRoutingEnabled,
} from './profiles.js';
import type { LlmRouteDecision, LlmTurnContext } from './types.js';

/** Lowercase, trim, drop empty tokens from comma-separated keyword list. */
export function parseHeavyKeywords(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  return raw
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(s => s.length > 0);
}

function heavyMinChars(): number | undefined {
  const raw = process.env.UTARUS_LLM_ROUTE_HEAVY_MIN_CHARS;
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `UTARUS_LLM_ROUTE_HEAVY_MIN_CHARS must be a positive integer (got ${JSON.stringify(raw)}).`,
    );
  }
  return n;
}

/**
 * Select profile for one turn. Does not call the domain hook (caller supplies domainProfile).
 * Title/utility: pass channel: 'title' (never has images).
 */
export function selectLlmProfileForTurn(ctx: LlmTurnContext): LlmRouteDecision {
  if (!isLlmRoutingEnabled()) {
    const resolved = getLlmProfile('default');
    return { profileName: 'default', reason: 'legacy', resolved };
  }

  const routing = getLlmRouting();
  const stack = getLlmStack();

  // Title / utility side path
  if (ctx.channel === 'title') {
    const name = routing.utility ?? routing.default;
    const resolved = getLlmProfile(name);
    return { profileName: name, reason: 'utility', resolved };
  }

  // 1. Images — hard
  if (ctx.hasImages) {
    if (!routing.has_images) {
      throw new Error(
        'This turn includes images but UTARUS_LLM_ROUTING.has_images is not set. ' +
          'Configure a vision-capable profile for image turns.',
      );
    }
    const resolved = getLlmProfile(routing.has_images);
    if (!resolved.capabilities.imageInput) {
      throw new Error(
        `Routing has_images profile "${routing.has_images}" does not accept image input.`,
      );
    }
    return { profileName: routing.has_images, reason: 'has_images', resolved };
  }

  // 2. Domain vote
  if (typeof ctx.domainProfile === 'string' && ctx.domainProfile.trim() !== '') {
    const name = ctx.domainProfile.trim();
    if (!stack.profiles.has(name)) {
      throw new Error(
        `Unknown LLM profile "${name}" from domain resolveLlmProfile. ` +
          `Configured: ${[...stack.profiles.keys()].join(', ')}.`,
      );
    }
    return { profileName: name, reason: 'domain', resolved: getLlmProfile(name) };
  }

  // 3. Heavy heuristics (only if heavy route configured)
  if (routing.heavy) {
    const text = ctx.text ?? '';
    const textLower = text.toLowerCase();
    const minChars = heavyMinChars();
    if (minChars !== undefined && text.length >= minChars) {
      return {
        profileName: routing.heavy,
        reason: 'heavy_chars',
        resolved: getLlmProfile(routing.heavy),
      };
    }
    const keywords = parseHeavyKeywords(process.env.UTARUS_LLM_ROUTE_HEAVY_KEYWORDS);
    for (const kw of keywords) {
      if (textLower.includes(kw)) {
        return {
          profileName: routing.heavy,
          reason: 'heavy_keyword',
          resolved: getLlmProfile(routing.heavy),
        };
      }
    }
  }

  // 4. Default
  return {
    profileName: routing.default,
    reason: 'default',
    resolved: getLlmProfile(routing.default),
  };
}

/** Titles / completeSimple — utility ?? default. */
export function resolveUtilityLlm(): LlmRouteDecision {
  return selectLlmProfileForTurn({
    hasImages: false,
    text: '',
    userSlug: '',
    isAdmin: false,
    channel: 'title',
  });
}

/**
 * UI capability aggregation: true only when a validated has_images route exists
 * and that profile accepts images. Legacy mode = default profile capabilities.
 */
export function getUiLlmCapabilities(): { imageInput: boolean } {
  const s = getLlmStack();
  if (!s.routingMode) {
    return { imageInput: getLlmProfile('default').capabilities.imageInput };
  }
  if (!s.routing.has_images) {
    return { imageInput: false };
  }
  return { imageInput: getLlmProfile(s.routing.has_images).capabilities.imageInput };
}
