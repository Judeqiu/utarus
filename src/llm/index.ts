import { type Model } from '@earendil-works/pi-ai';
import { config } from '../config.js';

/**
 * LLM factory — resolves the agent's model + API key based on
 * `config.llm.provider`. Config-driven so any host can swap the LLM
 * without forking the framework.
 *
 * Three provider kinds today:
 *
 *   - `deepseek` (default): DeepSeek V4 Pro, key from `DEEPSEEK_API_KEY`.
 *   - `kimi`: Kimi K3 (or other Kimi models) via OpenAI-compatible endpoint,
 *     key from `KIMI_API_KEY`.
 *   - `generic`: any OpenAI-compatible endpoint. The host supplies model id,
 *     base URL, and api key via `UTARUS_LLM_MODEL` / `UTARUS_LLM_BASE_URL` /
 *     `UTARUS_LLM_API_KEY` (or override the env-var name with
 *     `UTARUS_LLM_API_KEY_ENV`).
 *
 * Adding a new well-known provider = add an entry to `PROVIDER_DEFAULTS`.
 * Read at process start; restart to pick up env changes. Resolved once, cached.
 *
 * Fail-fast: if the selected provider's required env vars are missing, throw
 * with a clear message naming the missing var. No silent defaulting.
 */

interface ProviderDefaults {
  /** Display label for logs and model.name. */
  label: string;
  /** Default env var holding the API key. Overridable via UTARUS_LLM_API_KEY_ENV. */
  apiKeyEnv: string;
  /** Default model id; if absent, UTARUS_LLM_MODEL is required. */
  defaultModel?: string;
  /** Default OpenAI-compatible base URL; if absent, UTARUS_LLM_BASE_URL is required. */
  defaultBaseUrl?: string;
  /**
   * The `provider` field pi-ai's stream layer sees. Used for compat detection
   * inside openai-completions (e.g. thinkingFormat). When utarus passes the
   * apiKey explicitly via Agent.getApiKey, pi-ai's per-provider env lookup is
   * bypassed — so this field is informational for the generic case.
   */
  piAiProvider: string;
  /** Optional deepseek-style thinking format compat flag. */
  thinkingFormat?: 'deepseek';
  /** Optional reasoning-effort map. Presence implies `reasoning: true`. */
  thinkingLevelMap?: Record<string, string | null>;
  contextWindow: number;
  maxTokens: number;
}

const PROVIDER_DEFAULTS: Record<string, ProviderDefaults> = {
  deepseek: {
    label: 'DeepSeek',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-v4-pro',
    defaultBaseUrl: 'https://api.deepseek.com',
    piAiProvider: 'deepseek',
    thinkingFormat: 'deepseek',
    contextWindow: 1_000_000,
    maxTokens: 384_000,
  },
  kimi: {
    label: 'Kimi',
    apiKeyEnv: 'KIMI_API_KEY',
    defaultModel: 'k3',
    defaultBaseUrl: 'https://api.kimi.com/coding/v1',
    // Maps to pi-ai's `kimi-coding` entry so DEEPSEEK-style env lookup also works.
    piAiProvider: 'kimi-coding',
    thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high', xhigh: 'max' },
    contextWindow: 256_000,
    maxTokens: 8_192,
  },
  generic: {
    label: 'Generic',
    apiKeyEnv: 'UTARUS_LLM_API_KEY',
    // No defaults — host must supply UTARUS_LLM_MODEL + UTARUS_LLM_BASE_URL.
    piAiProvider: 'openai',
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
};

export interface ResolvedLLM {
  model: Model<'openai-completions'>;
  apiKey: string;
}

let cached: ResolvedLLM | null = null;

export function getAgentLLM(): ResolvedLLM {
  if (cached) return cached;

  const providerKey = config.llm.provider;
  const defaults = PROVIDER_DEFAULTS[providerKey];
  if (!defaults) {
    throw new Error(
      `Unknown UTARUS_LLM_PROVIDER="${providerKey}". ` +
        `Supported: ${Object.keys(PROVIDER_DEFAULTS).join(', ')}.`,
    );
  }

  const apiKeyEnv = process.env.UTARUS_LLM_API_KEY_ENV ?? defaults.apiKeyEnv;
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    throw new Error(
      `${apiKeyEnv} is required when UTARUS_LLM_PROVIDER=${providerKey}.`,
    );
  }

  const modelId = config.llm.model ?? defaults.defaultModel;
  if (!modelId) {
    throw new Error(
      `UTARUS_LLM_MODEL is required when UTARUS_LLM_PROVIDER=${providerKey} ` +
        `(no default model registered for this provider).`,
    );
  }

  const baseUrl = config.llm.baseUrl ?? defaults.defaultBaseUrl;
  if (!baseUrl) {
    throw new Error(
      `UTARUS_LLM_BASE_URL is required when UTARUS_LLM_PROVIDER=${providerKey} ` +
        `(no default base URL registered for this provider).`,
    );
  }

  const model: Model<'openai-completions'> = {
    id: modelId,
    name: `${defaults.label} ${modelId}`,
    api: 'openai-completions',
    provider: defaults.piAiProvider,
    baseUrl,
    compat: defaults.thinkingFormat ? { thinkingFormat: defaults.thinkingFormat } : {},
    reasoning: !!(defaults.thinkingLevelMap ?? defaults.thinkingFormat),
    thinkingLevelMap: defaults.thinkingLevelMap,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: defaults.contextWindow,
    maxTokens: defaults.maxTokens,
  } as unknown as Model<'openai-completions'>;

  cached = { model, apiKey };
  return cached;
}

/** Convenience accessor for callers that only need the model descriptor. */
export function getAgentModel(): Model<'openai-completions'> {
  return getAgentLLM().model;
}

/** Convenience accessor for callers that only need the resolved API key. */
export function getAgentApiKey(): string {
  return getAgentLLM().apiKey;
}

/**
 * Legacy alias. The function used to be DeepSeek-only, hence the name; the
 * internal call sites in this repo were updated to `getAgentModel`, but the
 * alias is kept so any external consumers keep working.
 */
export const getDeepSeekModel = getAgentModel;
