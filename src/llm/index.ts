import { getModel, type Model } from '@earendil-works/pi-ai';
import { config } from '../config.js';

/**
 * LLM factory — resolves the agent's model based on `config.llm.provider`.
 *
 * Originally locked to DeepSeek. v0.9.0 adds a config-driven dispatch so a
 * host can swap to another OpenAI-compatible provider (Kimi K3 today, more
 * later) by setting env vars — no fork required.
 *
 * Read at process start; restart to pick up env changes. The model is cached
 * after first resolution.
 *
 * Fail-fast: if the selected provider's required env vars are missing, throw
 * with a clear message naming the missing var. No silent defaulting.
 */

let cachedModel: Model<'openai-completions'> | null = null;

export function getAgentModel(): Model<'openai-completions'> {
  if (cachedModel) return cachedModel;

  const provider = config.llm.provider;

  if (provider === 'deepseek') {
    if (!config.deepseek.apiKey) {
      throw new Error(
        'DEEPSEEK_API_KEY is required when UTARUS_LLM_PROVIDER=deepseek (or unset).',
      );
    }
    cachedModel = getModel('deepseek', 'deepseek-v4-pro');
    return cachedModel;
  }

  if (provider === 'kimi') {
    // pi-ai's env-api-keys maps `kimi-coding` → KIMI_API_KEY. The key is
    // resolved at call time by streamSimple; we check here to fail at boot
    // rather than at the first user message.
    if (!process.env.KIMI_API_KEY) {
      throw new Error('KIMI_API_KEY is required when UTARUS_LLM_PROVIDER=kimi.');
    }
    cachedModel = buildKimiModel(config.llm.model ?? 'k3', config.llm.baseUrl);
    return cachedModel;
  }

  throw new Error(
    `Unknown UTARUS_LLM_PROVIDER="${provider}". Supported: "deepseek" (default), "kimi".`,
  );
}

/**
 * Legacy alias. The function used to be DeepSeek-only, hence the original
 * name; internal callers in this repo were updated to `getAgentModel`, but
 * the alias is kept so any external consumers (and existing forked domains)
 * keep working.
 */
export const getDeepSeekModel = getAgentModel;

/**
 * Construct a Kimi model descriptor. Kimi K3 exposes an OpenAI-compatible
 * endpoint at https://api.kimi.com/coding/v1 and supports three thinking
 * strengths (low / high / max). pi-ai's thinking-level ladder maps onto
 * those three; `minimal` and `medium` are not supported by Kimi and get
 * clamped to the nearest available level by `clampThinkingLevel`.
 *
 * Cost fields are zero — Kimi's per-token pricing is tier-dependent and not
 * surfaced to the SDK; usage tracking still records token counts.
 */
function buildKimiModel(
  modelId: string,
  baseUrlOverride?: string,
): Model<'openai-completions'> {
  return {
    id: modelId,
    name: `Kimi ${modelId}`,
    api: 'openai-completions',
    provider: 'kimi-coding',
    baseUrl: baseUrlOverride ?? 'https://api.kimi.com/coding/v1',
    compat: {},
    reasoning: true,
    thinkingLevelMap: {
      minimal: null,
      low: 'low',
      medium: null,
      high: 'high',
      xhigh: 'max',
    },
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 256_000,
    maxTokens: 8_192,
  } as unknown as Model<'openai-completions'>;
}
