/**
 * Per-turn active LLM route — AsyncLocalStorage, same pattern as Slack RunContext.
 * Tools (read_image) and usage tracking read the active route without an Agent ref.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { LlmRouteDecision } from './types.js';

const storage = new AsyncLocalStorage<LlmRouteDecision>();

/** Run `fn` with `decision` as the active LLM route (promise-safe ALS). */
export function runWithLlmRoute<T>(decision: LlmRouteDecision, fn: () => T | Promise<T>): Promise<T> {
  return Promise.resolve(storage.run(decision, fn));
}

export function getActiveLlmRoute(): LlmRouteDecision | undefined {
  return storage.getStore();
}

/** Fail-fast for tools that require an active turn. */
export function requireActiveLlmRoute(toolName: string): LlmRouteDecision {
  const d = getActiveLlmRoute();
  if (!d) {
    throw new Error(
      `${toolName}: no active LLM route in AsyncLocalStorage. ` +
        `Interactive agent runs must use resolveAndApplyLlmForTurn().runWithLlmRoute.`,
    );
  }
  return d;
}
