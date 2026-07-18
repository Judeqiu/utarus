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

/**
 * Native capabilities of an LLM — what the *model itself* can do, independent
 * of how any agent uses it. Feature gates across the framework bind to these
 * (e.g. WebUI photo attachments are enabled only when `imageInput` is true).
 *
 * Resolution order in getAgentLLM():
 *   1. provider default (`ProviderDefaults.capabilities`)
 *   2. per-model delta (`ProviderDefaults.modelCapabilities[modelId]`) — for
 *      models that differ from the provider's family default
 *   3. env override (`UTARUS_LLM_IMAGE_INPUT=true|false`)
 *
 * When utarus gains support for a new provider or model, declare its nature
 * here — do not gate features on provider/model ids elsewhere.
 * Future modalities (audioInput, fileInput, …) extend this interface.
 */
export interface LlmCapabilities {
  /**
   * The model accepts image input (vision). Drives `model.input`; pi-ai
   * silently downgrades images to placeholder text when `input` lacks
   * 'image'. Overridable via UTARUS_LLM_IMAGE_INPUT=true|false.
   */
  imageInput: boolean;
}

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
  /** Capability default for this provider's model family. */
  capabilities: LlmCapabilities;
  /**
   * Per-model capability deltas, keyed by exact model id, for models whose
   * nature differs from the provider family default. Only declare entries
   * verified against the live endpoint.
   */
  modelCapabilities?: Record<string, Partial<LlmCapabilities>>;
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
    // deepseek-v4-pro on api.deepseek.com is text-only.
    capabilities: { imageInput: false },
    contextWindow: 1_000_000,
    maxTokens: 384_000,
  },
  kimi: {
    label: 'Kimi',
    apiKeyEnv: 'KIMI_API_KEY',
    defaultModel: 'k3',
    defaultBaseUrl: 'https://api.kimi.com/coding/v1',
    // Pi-ai recognises `moonshotai` and formats requests accordingly (drops
    // `max_completion_tokens` / `prompt_cache_key` etc. that the Kimi endpoint
    // rejects with "tokenization failed"). Same company, same wire format.
    // Auth is handled centrally via Agent.getApiKey, so pi-ai's per-provider
    // env-var lookup (which would expect MOONSHOT_API_KEY) is bypassed.
    piAiProvider: 'moonshotai',
    thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high', xhigh: 'max' },
    // Verified on the coding endpoint: k3, kimi-for-coding and
    // kimi-for-coding-highspeed all accept image_url data URLs.
    capabilities: { imageInput: true },
    contextWindow: 256_000,
    maxTokens: 8_192,
  },
  generic: {
    label: 'Generic',
    apiKeyEnv: 'UTARUS_LLM_API_KEY',
    // No defaults — host must supply UTARUS_LLM_MODEL + UTARUS_LLM_BASE_URL.
    piAiProvider: 'openai',
    // Unknown endpoint — assumed text-only unless opted in via
    // UTARUS_LLM_IMAGE_INPUT=true.
    capabilities: { imageInput: false },
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
};

/**
 * Resolve the effective capabilities for a model: provider family default,
 * refined by any per-model delta, finally overridden by the
 * UTARUS_LLM_IMAGE_INPUT env var (strict 'true'/'false'; anything else is
 * ignored so a typo can't silently flip a feature gate).
 * Exported for unit tests — callers should use getAgentLlmCapabilities().
 */
export function resolveCapabilities(
  defaults: Pick<ProviderDefaults, 'capabilities' | 'modelCapabilities'>,
  modelId: string,
  imageInputEnv?: string,
): LlmCapabilities {
  const resolved: LlmCapabilities = {
    ...defaults.capabilities,
    ...(defaults.modelCapabilities?.[modelId] ?? {}),
  };
  if (imageInputEnv === 'true') resolved.imageInput = true;
  else if (imageInputEnv === 'false') resolved.imageInput = false;
  return resolved;
}

export interface ResolvedLLM {
  model: Model<'openai-completions'>;
  apiKey: string;
  /** Effective capabilities of the resolved model — feature gates read this. */
  capabilities: LlmCapabilities;
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

  const capabilities = resolveCapabilities(defaults, modelId, process.env.UTARUS_LLM_IMAGE_INPUT);

  const model: Model<'openai-completions'> = {
    id: modelId,
    name: `${defaults.label} ${modelId}`,
    api: 'openai-completions',
    provider: defaults.piAiProvider,
    baseUrl,
    compat: defaults.thinkingFormat ? { thinkingFormat: defaults.thinkingFormat } : {},
    reasoning: !!(defaults.thinkingLevelMap ?? defaults.thinkingFormat),
    thinkingLevelMap: defaults.thinkingLevelMap,
    input: capabilities.imageInput ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: defaults.contextWindow,
    maxTokens: defaults.maxTokens,
  } as unknown as Model<'openai-completions'>;

  cached = { model, apiKey, capabilities };
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
 * Effective capabilities of the resolved model — the single source of truth
 * for capability-gated features (e.g. WebUI photo attachments bind to
 * `imageInput`). Never gate a feature on provider/model ids directly.
 */
export function getAgentLlmCapabilities(): LlmCapabilities {
  return getAgentLLM().capabilities;
}

/**
 * Legacy alias. The function used to be DeepSeek-only, hence the name; the
 * internal call sites in this repo were updated to `getAgentModel`, but the
 * alias is kept so any external consumers keep working.
 */
export const getDeepSeekModel = getAgentModel;
