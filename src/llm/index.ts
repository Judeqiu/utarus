/**
 * LLM public API — multi-profile routing + legacy single-provider path.
 *
 * See docs/multi-llm-routing-design.md.
 */

export type {
  LlmCapabilities,
  LlmProfileConfig,
  LlmProviderKind,
  LlmRoutingConfig,
  ResolvedLLM,
  LlmTurnContext,
  LlmRouteDecision,
  LlmRouteReason,
  ResolveLlmProfileContext,
} from './types.js';

export {
  PROVIDER_DEFAULTS,
  resolveCapabilities,
  assertLlmConfig,
  resetLlmStackForTests,
  isLlmRoutingEnabled,
  isLlmRoutingEnvSet,
  getLlmProfile,
  listLlmProfiles,
  getLlmRouting,
  getApiKeyForPiProvider,
  getCapWeight,
  getDefaultResolvedLLM,
  getLlmStack,
} from './profiles.js';

export {
  selectLlmProfileForTurn,
  resolveUtilityLlm,
  getUiLlmCapabilities,
  parseHeavyKeywords,
} from './routing.js';

export {
  resolveAndApplyLlmForTurn,
  type ApplyLlmTurnParams,
  type ApplyLlmTurnResult,
} from './apply-route.js';

export {
  runWithLlmRoute,
  getActiveLlmRoute,
  requireActiveLlmRoute,
} from './run-context.js';

import type { Model } from '@earendil-works/pi-ai';
import { getDefaultResolvedLLM, getLlmProfile, getLlmStack } from './profiles.js';
import { getUiLlmCapabilities } from './routing.js';
import type { LlmCapabilities, ResolvedLLM } from './types.js';
import { getActiveLlmRoute } from './run-context.js';
import { getApiKeyForPiProvider } from './profiles.js';

/**
 * Default / primary resolved LLM (routing.default in multi-profile mode;
 * synthetic "default" in legacy mode). Cached via profile stack.
 */
export function getAgentLLM(): ResolvedLLM {
  return getDefaultResolvedLLM();
}

export function getAgentModel(): Model<'openai-completions'> {
  return getAgentLLM().model;
}

export function getAgentApiKey(): string {
  return getAgentLLM().apiKey;
}

/**
 * Capabilities of the **default** profile (legacy single-model semantics).
 * For WebUI photo gates use getUiLlmCapabilities() instead.
 */
export function getAgentLlmCapabilities(): LlmCapabilities {
  return getAgentLLM().capabilities;
}

/**
 * Agent getApiKey callback: never throws; prefers active ALS route key,
 * else registry by pi-ai provider.
 */
export function agentGetApiKey(provider: string): string | undefined {
  const active = getActiveLlmRoute();
  if (active && active.resolved.model.provider === provider) {
    return active.resolved.apiKey;
  }
  return getApiKeyForPiProvider(provider);
}

/** @deprecated Use getAgentModel — kept for external consumers. */
export const getDeepSeekModel = getAgentModel;

/** Re-export UI caps under a stable name for chat router. */
export { getUiLlmCapabilities as getChatUiLlmCapabilities };

/** Debug: routing summary for GET /api/chat/agent (optional). */
export function getLlmRoutingDebug(): {
  routingMode: boolean;
  defaultProfile: string;
  hasImagesProfile?: string;
  profiles: string[];
} {
  const s = getLlmStack();
  return {
    routingMode: s.routingMode,
    defaultProfile: s.routing.default,
    hasImagesProfile: s.routing.has_images,
    profiles: [...s.profiles.keys()],
  };
}

/** Ensure default profile exists (side-effect free accessors still lazy-load). */
export function ensureDefaultProfileLoaded(): ResolvedLLM {
  return getLlmProfile(getLlmStack().routing.default);
}
