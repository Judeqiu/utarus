/**
 * Shared helper: resolve domain vote → select profile → apply to agent → ALS wrapper.
 * All interactive channels (web / telegram / slack / cli / task) must use this.
 */

import type { Agent } from '@earendil-works/pi-agent-core';
import type { DomainExtension } from '../extension.js';
import { runWithLlmRoute as alsRun } from './run-context.js';
import { selectLlmProfileForTurn, resolveUtilityLlm } from './routing.js';
import type { LlmRouteDecision, LlmTurnContext } from './types.js';

export { resolveUtilityLlm };

export interface ApplyLlmTurnParams {
  agent: Agent;
  extension: DomainExtension;
  userSlug: string;
  isAdmin: boolean;
  channel: Exclude<LlmTurnContext['channel'], 'title'>;
  conversationId?: string;
  hasImages: boolean;
  /** Heuristic / domain text — no channel or Active-model prefixes. */
  text: string;
}

export interface ApplyLlmTurnResult {
  decision: LlmRouteDecision;
  activeModelPrefix: string;
  /**
   * Run async work inside ALS for the full agent promise lifetime.
   * WebUI fire-and-forget must wrap runAgent here, not only sync setup.
   */
  runWithLlmRoute: <T>(fn: () => T | Promise<T>) => Promise<T>;
}

function formatActiveModelPrefix(decision: LlmRouteDecision): string {
  const m = decision.resolved.model;
  const label = m.name || m.id;
  return (
    `[Active model: ${label} | profile=${decision.profileName} | reason=${decision.reason}]\n\n`
  );
}

/**
 * 1. If !hasImages && extension.resolveLlmProfile → await hook (K15: skip on images)
 * 2. selectLlmProfileForTurn
 * 3. agent.state.model = decision.resolved.model
 * 4. return decision + prefix + runWithLlmRoute
 */
export async function resolveAndApplyLlmForTurn(
  params: ApplyLlmTurnParams,
): Promise<ApplyLlmTurnResult> {
  const {
    agent,
    extension,
    userSlug,
    isAdmin,
    channel,
    conversationId,
    hasImages,
    text,
  } = params;

  let domainProfile: string | null | undefined;

  if (!hasImages && extension.resolveLlmProfile) {
    const vote = await extension.resolveLlmProfile({
      text,
      hasImages: false,
      userSlug,
      isAdmin,
      channel,
      conversationId,
    });
    if (vote !== undefined && vote !== null) {
      if (typeof vote !== 'string' || vote.trim() === '') {
        throw new Error(
          'DomainExtension.resolveLlmProfile must return a non-empty profile name, null, or undefined.',
        );
      }
      domainProfile = vote.trim();
    }
  }

  const decision = selectLlmProfileForTurn({
    hasImages,
    text,
    userSlug,
    isAdmin,
    channel,
    conversationId,
    domainProfile,
  });

  agent.state.model = decision.resolved.model;

  console.log(
    `[llm/route] channel=${channel} user=${userSlug} profile=${decision.profileName} ` +
      `reason=${decision.reason} model=${decision.resolved.model.id} ` +
      `provider=${decision.resolved.model.provider} hasImages=${hasImages}`,
  );

  return {
    decision,
    activeModelPrefix: formatActiveModelPrefix(decision),
    runWithLlmRoute: <T>(fn: () => T | Promise<T>) => alsRun(decision, fn),
  };
}
