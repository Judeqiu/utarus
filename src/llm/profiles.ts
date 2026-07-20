/**
 * Named LLM profile resolution + boot validation.
 * Legacy mode (no UTARUS_LLM_PROFILES) synthesizes a single "default" profile
 * from UTARUS_LLM_PROVIDER / MODEL / BASE_URL (today's getAgentLLM semantics).
 */

import { type Model } from '@earendil-works/pi-ai';
import { config } from '../config.js';
import { assertLlmRetryConfig } from './retry.js';
import type {
  LlmCapabilities,
  LlmProfileConfig,
  LlmProviderKind,
  LlmRoutingConfig,
  ResolvedLLM,
} from './types.js';

export interface ProviderDefaults {
  label: string;
  apiKeyEnv: string;
  defaultModel?: string;
  defaultBaseUrl?: string;
  piAiProvider: string;
  thinkingFormat?: 'deepseek';
  thinkingLevelMap?: Record<string, string | null>;
  capabilities: LlmCapabilities;
  modelCapabilities?: Record<string, Partial<LlmCapabilities>>;
  contextWindow: number;
  maxTokens: number;
}

export const PROVIDER_DEFAULTS: Record<string, ProviderDefaults> = {
  deepseek: {
    label: 'DeepSeek',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-v4-pro',
    defaultBaseUrl: 'https://api.deepseek.com',
    piAiProvider: 'deepseek',
    thinkingFormat: 'deepseek',
    capabilities: { imageInput: false },
    contextWindow: 1_000_000,
    maxTokens: 384_000,
  },
  kimi: {
    label: 'Kimi',
    apiKeyEnv: 'KIMI_API_KEY',
    defaultModel: 'k3',
    defaultBaseUrl: 'https://api.kimi.com/coding/v1',
    piAiProvider: 'moonshotai',
    thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high', xhigh: 'max' },
    capabilities: { imageInput: true },
    contextWindow: 256_000,
    maxTokens: 8_192,
  },
  generic: {
    label: 'Generic',
    apiKeyEnv: 'UTARUS_LLM_API_KEY',
    piAiProvider: 'openai',
    capabilities: { imageInput: false },
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
};

const PROFILE_NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Resolve capabilities: provider default → per-model delta → optional override.
 * imageInputOverride: 'true' | 'false' string (legacy env) or boolean (profile field).
 */
export function resolveCapabilities(
  defaults: Pick<ProviderDefaults, 'capabilities' | 'modelCapabilities'>,
  modelId: string,
  imageInputOverride?: string | boolean,
): LlmCapabilities {
  const resolved: LlmCapabilities = {
    ...defaults.capabilities,
    ...(defaults.modelCapabilities?.[modelId] ?? {}),
  };
  if (imageInputOverride === true || imageInputOverride === 'true') {
    resolved.imageInput = true;
  } else if (imageInputOverride === false || imageInputOverride === 'false') {
    resolved.imageInput = false;
  }
  return resolved;
}

function isProviderKind(v: unknown): v is LlmProviderKind {
  return v === 'deepseek' || v === 'kimi' || v === 'generic';
}

function buildModel(
  defaults: ProviderDefaults,
  modelId: string,
  baseUrl: string,
  capabilities: LlmCapabilities,
): Model<'openai-completions'> {
  return {
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
}

function resolveOneProfile(
  profileName: string,
  cfg: LlmProfileConfig,
  opts: { applyGlobalImageEnv: boolean },
): ResolvedLLM {
  if (!isProviderKind(cfg.provider)) {
    throw new Error(
      `LLM profile "${profileName}": unknown provider "${String(cfg.provider)}". ` +
        `Supported: ${Object.keys(PROVIDER_DEFAULTS).join(', ')}.`,
    );
  }
  const defaults = PROVIDER_DEFAULTS[cfg.provider];
  if (!defaults) {
    throw new Error(`LLM profile "${profileName}": missing PROVIDER_DEFAULTS for ${cfg.provider}`);
  }

  const apiKeyEnv = cfg.apiKeyEnv ?? defaults.apiKeyEnv;
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    throw new Error(
      `LLM profile "${profileName}": ${apiKeyEnv} is required (provider=${cfg.provider}).`,
    );
  }

  const modelId = cfg.model ?? defaults.defaultModel;
  if (!modelId) {
    // Legacy single-provider: name UTARUS_LLM_MODEL (matches prior getAgentLLM errors).
    if (profileName === 'default' && !isLlmRoutingEnvSet()) {
      throw new Error(
        `UTARUS_LLM_MODEL is required when UTARUS_LLM_PROVIDER=${cfg.provider} ` +
          `(no default model registered for this provider).`,
      );
    }
    throw new Error(
      `LLM profile "${profileName}": model is required when provider=${cfg.provider} ` +
        `(no default model registered).`,
    );
  }

  const baseUrl = cfg.baseUrl ?? defaults.defaultBaseUrl;
  if (!baseUrl) {
    if (profileName === 'default' && !isLlmRoutingEnvSet()) {
      throw new Error(
        `UTARUS_LLM_BASE_URL is required when UTARUS_LLM_PROVIDER=${cfg.provider} ` +
          `(no default base URL registered for this provider).`,
      );
    }
    throw new Error(
      `LLM profile "${profileName}": baseUrl is required when provider=${cfg.provider} ` +
        `(no default base URL registered).`,
    );
  }

  let imageOverride: string | boolean | undefined = cfg.imageInput;
  if (imageOverride === undefined && opts.applyGlobalImageEnv) {
    imageOverride = process.env.UTARUS_LLM_IMAGE_INPUT;
  }

  const capabilities = resolveCapabilities(defaults, modelId, imageOverride);
  const model = buildModel(defaults, modelId, baseUrl, capabilities);

  return { model, apiKey, capabilities, profileName };
}

function parseProfilesJson(raw: string): Record<string, LlmProfileConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `UTARUS_LLM_PROFILES is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('UTARUS_LLM_PROFILES must be a JSON object of profile name → config.');
  }
  const obj = parsed as Record<string, unknown>;
  const names = Object.keys(obj);
  if (names.length === 0) {
    throw new Error('UTARUS_LLM_PROFILES must declare at least one profile (got {}).');
  }
  const out: Record<string, LlmProfileConfig> = {};
  for (const name of names) {
    if (!PROFILE_NAME_RE.test(name)) {
      throw new Error(
        `Invalid LLM profile name "${name}". Must match /^[a-z][a-z0-9_]*$/.`,
      );
    }
    const entry = obj[name];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`LLM profile "${name}" must be a JSON object.`);
    }
    const e = entry as Record<string, unknown>;
    if (!isProviderKind(e.provider)) {
      throw new Error(
        `LLM profile "${name}": provider must be deepseek|kimi|generic (got ${JSON.stringify(e.provider)}).`,
      );
    }
    const cfg: LlmProfileConfig = { provider: e.provider };
    if (e.model !== undefined) {
      if (typeof e.model !== 'string' || !e.model) {
        throw new Error(`LLM profile "${name}": model must be a non-empty string when set.`);
      }
      cfg.model = e.model;
    }
    if (e.baseUrl !== undefined) {
      if (typeof e.baseUrl !== 'string' || !e.baseUrl) {
        throw new Error(`LLM profile "${name}": baseUrl must be a non-empty string when set.`);
      }
      cfg.baseUrl = e.baseUrl;
    }
    if (e.apiKeyEnv !== undefined) {
      if (typeof e.apiKeyEnv !== 'string' || !e.apiKeyEnv) {
        throw new Error(`LLM profile "${name}": apiKeyEnv must be a non-empty string when set.`);
      }
      cfg.apiKeyEnv = e.apiKeyEnv;
    }
    if (e.imageInput !== undefined) {
      if (typeof e.imageInput !== 'boolean') {
        throw new Error(`LLM profile "${name}": imageInput must be true or false when set.`);
      }
      cfg.imageInput = e.imageInput;
    }
    out[name] = cfg;
  }
  return out;
}

function parseRoutingJson(raw: string): LlmRoutingConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `UTARUS_LLM_ROUTING is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('UTARUS_LLM_ROUTING must be a JSON object.');
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o.default !== 'string' || !o.default) {
    throw new Error('UTARUS_LLM_ROUTING.default is required (non-empty profile name string).');
  }
  const routing: LlmRoutingConfig = { default: o.default };
  for (const key of ['has_images', 'utility', 'heavy'] as const) {
    if (o[key] !== undefined) {
      if (typeof o[key] !== 'string' || !(o[key] as string)) {
        throw new Error(`UTARUS_LLM_ROUTING.${key} must be a non-empty profile name when set.`);
      }
      routing[key] = o[key] as string;
    }
  }
  return routing;
}

/** Parse cap weights: optional UTARUS_LLM_CAP_WEIGHTS JSON { profile: number }. */
export function parseCapWeights(
  raw: string | undefined,
  profileNames: string[],
): Map<string, number> | null {
  if (raw === undefined || raw.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `UTARUS_LLM_CAP_WEIGHTS is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('UTARUS_LLM_CAP_WEIGHTS must be a JSON object of profile → positive number.');
  }
  const obj = parsed as Record<string, unknown>;
  const map = new Map<string, number>();
  for (const name of profileNames) {
    const v = obj[name];
    if (typeof v !== 'number' || !(v > 0) || !Number.isFinite(v)) {
      throw new Error(
        `UTARUS_LLM_CAP_WEIGHTS: every declared profile must have an explicit positive weight. ` +
          `Missing or invalid weight for profile "${name}".`,
      );
    }
    map.set(name, v);
  }
  // Extra keys in weights that are not profiles: fail-fast (typos)
  for (const key of Object.keys(obj)) {
    if (!profileNames.includes(key)) {
      throw new Error(
        `UTARUS_LLM_CAP_WEIGHTS has unknown profile "${key}" (not in UTARUS_LLM_PROFILES / legacy default).`,
      );
    }
  }
  return map;
}

export interface LlmStack {
  routingMode: boolean;
  profiles: Map<string, ResolvedLLM>;
  routing: LlmRoutingConfig;
  /** pi-ai provider wire name → apiKey (K17 uniqueness enforced at build). */
  apiKeyByPiProvider: Map<string, string>;
  /** null = all weights 1; else every profile has explicit weight. */
  capWeights: Map<string, number> | null;
}

let stack: LlmStack | null = null;

function registerApiKey(
  map: Map<string, string>,
  piProvider: string,
  apiKey: string,
  profileName: string,
  previousOwner: Map<string, string>,
): void {
  const existing = map.get(piProvider);
  if (existing === undefined) {
    map.set(piProvider, apiKey);
    previousOwner.set(piProvider, profileName);
    return;
  }
  if (existing === apiKey) return;
  const other = previousOwner.get(piProvider) ?? '?';
  throw new Error(
    `Conflicting API keys for pi-ai provider "${piProvider}": profiles "${other}" and "${profileName}" ` +
      `register different secrets. One secret per pi-ai provider wire name is required.`,
  );
}

function buildLegacyStack(): LlmStack {
  const providerKey = config.llm.provider as string;
  const defaults = PROVIDER_DEFAULTS[providerKey];
  if (!defaults) {
    throw new Error(
      `Unknown UTARUS_LLM_PROVIDER="${providerKey}". ` +
        `Supported: ${Object.keys(PROVIDER_DEFAULTS).join(', ')}.`,
    );
  }

  const cfg: LlmProfileConfig = {
    provider: providerKey as LlmProviderKind,
    model: config.llm.model,
    baseUrl: config.llm.baseUrl,
    apiKeyEnv: process.env.UTARUS_LLM_API_KEY_ENV ?? defaults.apiKeyEnv,
  };
  // Legacy: UTARUS_LLM_API_KEY_ENV applies to the single profile.
  const resolved = resolveOneProfile('default', cfg, { applyGlobalImageEnv: true });

  const apiKeyByPiProvider = new Map<string, string>();
  const owners = new Map<string, string>();
  registerApiKey(
    apiKeyByPiProvider,
    resolved.model.provider,
    resolved.apiKey,
    'default',
    owners,
  );

  const capWeights = parseCapWeights(process.env.UTARUS_LLM_CAP_WEIGHTS, ['default']);

  return {
    routingMode: false,
    profiles: new Map([['default', resolved]]),
    routing: { default: 'default' },
    apiKeyByPiProvider,
    capWeights,
  };
}

function buildRoutingStack(): LlmStack {
  const profilesRaw = process.env.UTARUS_LLM_PROFILES;
  if (!profilesRaw || !profilesRaw.trim()) {
    throw new Error('buildRoutingStack called without UTARUS_LLM_PROFILES');
  }
  const routingRaw = process.env.UTARUS_LLM_ROUTING;
  if (routingRaw === undefined || routingRaw.trim() === '') {
    throw new Error(
      'UTARUS_LLM_ROUTING is required when UTARUS_LLM_PROFILES is set ' +
        '(no profiles-only / implicit default-only routing).',
    );
  }

  const profileCfgs = parseProfilesJson(profilesRaw);
  const routing = parseRoutingJson(routingRaw);

  const profiles = new Map<string, ResolvedLLM>();
  const apiKeyByPiProvider = new Map<string, string>();
  const owners = new Map<string, string>();

  for (const [name, cfg] of Object.entries(profileCfgs)) {
    const resolved = resolveOneProfile(name, cfg, { applyGlobalImageEnv: false });
    profiles.set(name, resolved);
    registerApiKey(
      apiKeyByPiProvider,
      resolved.model.provider,
      resolved.apiKey,
      name,
      owners,
    );
  }

  // Every routing target must exist
  const targets: Array<[string, string | undefined]> = [
    ['default', routing.default],
    ['has_images', routing.has_images],
    ['utility', routing.utility],
    ['heavy', routing.heavy],
  ];
  for (const [key, name] of targets) {
    if (name === undefined) continue;
    if (!profiles.has(name)) {
      throw new Error(
        `UTARUS_LLM_ROUTING.${key}="${name}" is not a declared profile in UTARUS_LLM_PROFILES ` +
          `(have: ${[...profiles.keys()].join(', ')}).`,
      );
    }
  }

  if (routing.has_images) {
    const vision = profiles.get(routing.has_images)!;
    if (!vision.capabilities.imageInput) {
      throw new Error(
        `UTARUS_LLM_ROUTING.has_images="${routing.has_images}" profile does not accept image input ` +
          `(imageInput=false). Use a vision-capable provider (e.g. kimi) or set profile imageInput: true.`,
      );
    }
  }

  const capWeights = parseCapWeights(process.env.UTARUS_LLM_CAP_WEIGHTS, [...profiles.keys()]);

  return {
    routingMode: true,
    profiles,
    routing,
    apiKeyByPiProvider,
    capWeights,
  };
}

/** Whether multi-profile routing env is set (non-empty UTARUS_LLM_PROFILES). */
export function isLlmRoutingEnvSet(): boolean {
  const raw = process.env.UTARUS_LLM_PROFILES;
  return typeof raw === 'string' && raw.trim() !== '';
}

/**
 * Resolve and cache the full LLM stack. Fail-fast on misconfig.
 * Call at boot via assertLlmConfig(); also used lazily by accessors.
 */
export function getLlmStack(): LlmStack {
  if (stack) return stack;
  stack = isLlmRoutingEnvSet() ? buildRoutingStack() : buildLegacyStack();
  return stack;
}

/** Boot / createFramework entry — always fully resolve + validate. */
export function assertLlmConfig(): void {
  stack = null; // re-read env
  const s = getLlmStack();
  // Touch every profile so failures are loud at boot
  for (const [name, r] of s.profiles) {
    if (!r.apiKey || !r.model.id) {
      throw new Error(`LLM profile "${name}" failed resolution (empty key or model id).`);
    }
  }
  assertLlmRetryConfig();
}

/** Test helper — drop cache between env mutations. */
export function resetLlmStackForTests(): void {
  stack = null;
}

export function isLlmRoutingEnabled(): boolean {
  return getLlmStack().routingMode;
}

export function getLlmProfile(name: string): ResolvedLLM {
  const s = getLlmStack();
  const r = s.profiles.get(name);
  if (!r) {
    throw new Error(
      `Unknown LLM profile "${name}". Configured: ${[...s.profiles.keys()].join(', ')}.`,
    );
  }
  return r;
}

export function listLlmProfiles(): string[] {
  return [...getLlmStack().profiles.keys()];
}

export function getLlmRouting(): LlmRoutingConfig {
  return getLlmStack().routing;
}

/**
 * Look up API key by pi-ai provider wire name.
 * Returns undefined when unknown — must not throw (Agent getApiKey contract).
 */
export function getApiKeyForPiProvider(provider: string): string | undefined {
  try {
    return getLlmStack().apiKeyByPiProvider.get(provider);
  } catch {
    return undefined;
  }
}

/**
 * Cap weight for a profile. If no weight map configured, returns 1.
 * If map is configured, profile must be present (fail-fast).
 */
export function getCapWeight(profileName: string): number {
  const s = getLlmStack();
  if (!s.capWeights) return 1;
  const w = s.capWeights.get(profileName);
  if (w === undefined) {
    throw new Error(
      `No cap weight for LLM profile "${profileName}" (UTARUS_LLM_CAP_WEIGHTS is set).`,
    );
  }
  return w;
}

/** Default / primary profile for legacy-compatible accessors. */
export function getDefaultResolvedLLM(): ResolvedLLM {
  const s = getLlmStack();
  return getLlmProfile(s.routing.default);
}
