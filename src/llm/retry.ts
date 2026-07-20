/**
 * Client-side LLM HTTP retries for transient provider errors (429 overloaded, 5xx).
 *
 * pi-ai's OpenAI-compatible path sets `maxRetries: options?.maxRetries ?? 0`, so
 * without an explicit value every 429 ends the agent run immediately. The OpenAI
 * SDK itself retries 429/5xx when maxRetries > 0.
 *
 * Env:
 * - UTARUS_LLM_MAX_RETRIES — non-negative integer; unset → {@link DEFAULT_LLM_MAX_RETRIES}
 * - UTARUS_LLM_MAX_RETRY_DELAY_MS — optional cap on provider-requested wait (ms);
 *   unset → leave unset (provider/SDK default); 0 disables the cap where supported
 */

/** Default when `UTARUS_LLM_MAX_RETRIES` is unset — enough for brief provider overload. */
export const DEFAULT_LLM_MAX_RETRIES = 4;

export interface LlmStreamRetryOptions {
  maxRetries: number;
  maxRetryDelayMs?: number;
}

/**
 * Max client-side HTTP retries per LLM request.
 * Unset → {@link DEFAULT_LLM_MAX_RETRIES}. Invalid → throw (fail-fast).
 */
export function getLlmMaxRetries(): number {
  const raw = process.env.UTARUS_LLM_MAX_RETRIES?.trim();
  if (raw === undefined || raw === '') return DEFAULT_LLM_MAX_RETRIES;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `UTARUS_LLM_MAX_RETRIES must be a non-negative integer (got ${JSON.stringify(raw)}).`,
    );
  }
  return n;
}

/**
 * Optional cap on provider-requested retry delays (ms).
 * Unset → `undefined` (do not override SDK/provider default). Invalid → throw.
 */
export function getLlmMaxRetryDelayMs(): number | undefined {
  const raw = process.env.UTARUS_LLM_MAX_RETRY_DELAY_MS?.trim();
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `UTARUS_LLM_MAX_RETRY_DELAY_MS must be a non-negative integer (ms); 0 disables the cap. Got ${JSON.stringify(raw)}.`,
    );
  }
  return n;
}

/** Options to spread into `streamSimple` / `completeSimple`. */
export function getLlmStreamRetryOptions(): LlmStreamRetryOptions {
  const maxRetries = getLlmMaxRetries();
  const maxRetryDelayMs = getLlmMaxRetryDelayMs();
  if (maxRetryDelayMs === undefined) {
    return { maxRetries };
  }
  return { maxRetries, maxRetryDelayMs };
}

/**
 * Fail-fast boot validation for retry env vars.
 * Call from {@link assertLlmConfig} so bad config never reaches the first chat turn.
 */
export function assertLlmRetryConfig(): void {
  getLlmMaxRetries();
  getLlmMaxRetryDelayMs();
}
