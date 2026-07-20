import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveCapabilities } from '../src/llm/index.js';

/**
 * LLM provider factory tests (src/llm/index.ts).
 *
 * Both config.ts and llm/index.ts read process.env at import time and cache
 * the resolution, so every test wipes the relevant env vars, then loads a
 * fresh module graph via vi.resetModules() + dynamic import.
 */

const ENV_KEYS = [
  'UTARUS_LOADED_BY_HOST',
  'DEEPSEEK_API_KEY',
  'KIMI_API_KEY',
  'UTARUS_LLM_PROVIDER',
  'UTARUS_LLM_MODEL',
  'UTARUS_LLM_BASE_URL',
  'UTARUS_LLM_API_KEY',
  'UTARUS_LLM_API_KEY_ENV',
  'UTARUS_LLM_IMAGE_INPUT',
  'UTARUS_LLM_PROFILES',
  'UTARUS_LLM_ROUTING',
  'UTARUS_LLM_ROUTE_HEAVY_MIN_CHARS',
  'UTARUS_LLM_ROUTE_HEAVY_KEYWORDS',
  'UTARUS_LLM_CAP_WEIGHTS',
  'UTARUS_LLM_MAX_RETRIES',
  'UTARUS_LLM_MAX_RETRY_DELAY_MS',
  'MY_CUSTOM_LLM_KEY',
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  // Prevent config.ts from auto-loading a repo-level .env during tests.
  process.env.UTARUS_LOADED_BY_HOST = '1';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function freshLLM() {
  vi.resetModules();
  return import('../src/llm/index.js');
}

describe('getAgentLLM — deepseek (default)', () => {
  it('resolves DeepSeek defaults when UTARUS_LLM_PROVIDER is unset', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-ds-test';
    const { getAgentLLM } = await freshLLM();
    const { model, apiKey } = getAgentLLM();
    expect(apiKey).toBe('sk-ds-test');
    expect(model.id).toBe('deepseek-v4-pro');
    expect(model.provider).toBe('deepseek');
    expect(model.baseUrl).toBe('https://api.deepseek.com');
    expect(model.api).toBe('openai-completions');
    expect(model.input).toEqual(['text']);
  });

  it('throws naming DEEPSEEK_API_KEY when the key is missing', async () => {
    const { getAgentLLM } = await freshLLM();
    expect(() => getAgentLLM()).toThrow(/DEEPSEEK_API_KEY is required/);
  });
});

describe('getAgentLLM — kimi', () => {
  beforeEach(() => {
    process.env.UTARUS_LLM_PROVIDER = 'kimi';
  });

  it('resolves Kimi K3 defaults with the moonshotai wire-compat provider', async () => {
    process.env.KIMI_API_KEY = 'sk-kimi-test';
    const { getAgentLLM } = await freshLLM();
    const { model, apiKey } = getAgentLLM();
    expect(apiKey).toBe('sk-kimi-test');
    expect(model.id).toBe('k3');
    expect(model.baseUrl).toBe('https://api.kimi.com/coding/v1');
    // pi-ai's `moonshotai` compat strips the OpenAI-standard params
    // (max_completion_tokens, store, developer role) that the Kimi endpoint
    // rejects with "400 Invalid request: tokenization failed". Regression guard.
    expect(model.provider).toBe('moonshotai');
    expect(model.reasoning).toBe(true);
    // k3 is vision-capable — required for chat photo attachments; without
    // 'image' here pi-ai silently replaces uploads with placeholder text.
    expect(model.input).toContain('image');
  });

  it('honours UTARUS_LLM_MODEL / UTARUS_LLM_BASE_URL overrides', async () => {
    process.env.KIMI_API_KEY = 'sk-kimi-test';
    process.env.UTARUS_LLM_MODEL = 'kimi-for-coding';
    process.env.UTARUS_LLM_BASE_URL = 'https://proxy.example.com/v1';
    const { getAgentLLM } = await freshLLM();
    const { model } = getAgentLLM();
    expect(model.id).toBe('kimi-for-coding');
    expect(model.baseUrl).toBe('https://proxy.example.com/v1');
  });

  it('throws naming KIMI_API_KEY when the key is missing', async () => {
    const { getAgentLLM } = await freshLLM();
    expect(() => getAgentLLM()).toThrow(/KIMI_API_KEY is required/);
  });
});

describe('getAgentLLM — generic', () => {
  beforeEach(() => {
    process.env.UTARUS_LLM_PROVIDER = 'generic';
  });

  it('requires model, base URL and api key — no defaults', async () => {
    process.env.UTARUS_LLM_MODEL = 'llama-3.3-70b-instruct';
    process.env.UTARUS_LLM_BASE_URL = 'http://localhost:11434/v1';
    process.env.UTARUS_LLM_API_KEY = 'sk-generic-test';
    const { getAgentLLM } = await freshLLM();
    const { model, apiKey } = getAgentLLM();
    expect(apiKey).toBe('sk-generic-test');
    expect(model.id).toBe('llama-3.3-70b-instruct');
    expect(model.baseUrl).toBe('http://localhost:11434/v1');
    expect(model.provider).toBe('openai');
  });

  it('throws naming UTARUS_LLM_MODEL when absent', async () => {
    process.env.UTARUS_LLM_BASE_URL = 'http://localhost:11434/v1';
    process.env.UTARUS_LLM_API_KEY = 'sk-generic-test';
    const { getAgentLLM } = await freshLLM();
    expect(() => getAgentLLM()).toThrow(/UTARUS_LLM_MODEL is required/);
  });

  it('throws naming UTARUS_LLM_BASE_URL when absent', async () => {
    process.env.UTARUS_LLM_MODEL = 'llama-3.3-70b-instruct';
    process.env.UTARUS_LLM_API_KEY = 'sk-generic-test';
    const { getAgentLLM } = await freshLLM();
    expect(() => getAgentLLM()).toThrow(/UTARUS_LLM_BASE_URL is required/);
  });

  it('reads the api key from UTARUS_LLM_API_KEY_ENV when set', async () => {
    process.env.UTARUS_LLM_MODEL = 'llama-3.3-70b-instruct';
    process.env.UTARUS_LLM_BASE_URL = 'http://localhost:11434/v1';
    process.env.UTARUS_LLM_API_KEY_ENV = 'MY_CUSTOM_LLM_KEY';
    process.env.MY_CUSTOM_LLM_KEY = 'sk-custom-test';
    const { getAgentLLM } = await freshLLM();
    expect(getAgentLLM().apiKey).toBe('sk-custom-test');
  });

  it('throws naming the custom env var when that key is missing', async () => {
    process.env.UTARUS_LLM_MODEL = 'llama-3.3-70b-instruct';
    process.env.UTARUS_LLM_BASE_URL = 'http://localhost:11434/v1';
    process.env.UTARUS_LLM_API_KEY_ENV = 'MY_CUSTOM_LLM_KEY';
    const { getAgentLLM } = await freshLLM();
    expect(() => getAgentLLM()).toThrow(/MY_CUSTOM_LLM_KEY is required/);
  });
});

describe('getAgentLLM — misc', () => {
  it('throws on an unknown provider naming the supported set', async () => {
    process.env.UTARUS_LLM_PROVIDER = 'bogus';
    const { getAgentLLM } = await freshLLM();
    expect(() => getAgentLLM()).toThrow(/Unknown UTARUS_LLM_PROVIDER="bogus"/);
    expect(() => getAgentLLM()).toThrow(/deepseek, kimi, generic/);
  });

  it('caches the resolution across calls', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-ds-test';
    const { getAgentLLM } = await freshLLM();
    expect(getAgentLLM()).toBe(getAgentLLM());
  });

  it('keeps the legacy getDeepSeekModel alias working', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-ds-test';
    const { getAgentModel, getDeepSeekModel, getAgentApiKey } = await freshLLM();
    expect(getDeepSeekModel).toBe(getAgentModel);
    expect(getDeepSeekModel().id).toBe('deepseek-v4-pro');
    expect(getAgentApiKey()).toBe('sk-ds-test');
  });
});

describe('getAgentLLM — image input (UTARUS_LLM_IMAGE_INPUT)', () => {
  it('generic provider stays text-only by default', async () => {
    process.env.UTARUS_LLM_PROVIDER = 'generic';
    process.env.UTARUS_LLM_MODEL = 'llama-3.3-70b-instruct';
    process.env.UTARUS_LLM_BASE_URL = 'http://localhost:11434/v1';
    process.env.UTARUS_LLM_API_KEY = 'sk-generic-test';
    const { getAgentLLM } = await freshLLM();
    expect(getAgentLLM().model.input).toEqual(['text']);
  });

  it('env override enables image input for a text-only provider', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-ds-test';
    process.env.UTARUS_LLM_IMAGE_INPUT = 'true';
    const { getAgentLLM } = await freshLLM();
    expect(getAgentLLM().model.input).toEqual(['text', 'image']);
  });

  it('env override disables image input for a vision provider', async () => {
    process.env.UTARUS_LLM_PROVIDER = 'kimi';
    process.env.KIMI_API_KEY = 'sk-kimi-test';
    process.env.UTARUS_LLM_IMAGE_INPUT = 'false';
    const { getAgentLLM } = await freshLLM();
    expect(getAgentLLM().model.input).toEqual(['text']);
  });

  it('unrecognised override values fall back to the provider default', async () => {
    process.env.UTARUS_LLM_PROVIDER = 'kimi';
    process.env.KIMI_API_KEY = 'sk-kimi-test';
    process.env.UTARUS_LLM_IMAGE_INPUT = 'yes';
    const { getAgentLLM } = await freshLLM();
    expect(getAgentLLM().model.input).toEqual(['text', 'image']);
  });
});

describe('resolveCapabilities — provider → model → env resolution', () => {
  it('applies the provider family default', () => {
    expect(resolveCapabilities({ capabilities: { imageInput: true } }, 'k3')).toEqual({
      imageInput: true,
    });
    expect(resolveCapabilities({ capabilities: { imageInput: false } }, 'deepseek-v4-pro')).toEqual(
      { imageInput: false },
    );
  });

  it('applies a per-model delta over the provider default', () => {
    const defaults = {
      capabilities: { imageInput: true },
      modelCapabilities: { 'text-only-variant': { imageInput: false } },
    };
    expect(resolveCapabilities(defaults, 'text-only-variant')).toEqual({ imageInput: false });
    expect(resolveCapabilities(defaults, 'vision-variant')).toEqual({ imageInput: true });
  });

  it('env override beats both provider default and per-model delta', () => {
    const defaults = {
      capabilities: { imageInput: true },
      modelCapabilities: { m: { imageInput: false } },
    };
    expect(resolveCapabilities(defaults, 'm', 'true')).toEqual({ imageInput: true });
    expect(resolveCapabilities({ capabilities: { imageInput: true } }, 'k3', 'false')).toEqual({
      imageInput: false,
    });
  });

  it('ignores unrecognised env values rather than flipping the gate', () => {
    expect(resolveCapabilities({ capabilities: { imageInput: false } }, 'm', 'yes')).toEqual({
      imageInput: false,
    });
  });
});

describe('getAgentLlmCapabilities', () => {
  it('exposes resolved capabilities bound to the model, and model.input agrees', async () => {
    process.env.UTARUS_LLM_PROVIDER = 'kimi';
    process.env.KIMI_API_KEY = 'sk-kimi-test';
    const { getAgentLLM, getAgentLlmCapabilities } = await freshLLM();
    expect(getAgentLlmCapabilities()).toEqual({ imageInput: true });
    expect(getAgentLLM().capabilities).toEqual({ imageInput: true });
    expect(getAgentLLM().model.input).toContain('image');
  });

  it('text-only default (deepseek) reports imageInput false', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-ds-test';
    const { getAgentLlmCapabilities } = await freshLLM();
    expect(getAgentLlmCapabilities()).toEqual({ imageInput: false });
  });
});

describe('multi-profile routing', () => {
  function setDailyVision() {
    process.env.DEEPSEEK_API_KEY = 'sk-ds-test';
    process.env.KIMI_API_KEY = 'sk-kimi-test';
    process.env.UTARUS_LLM_PROFILES = JSON.stringify({
      daily: { provider: 'deepseek' },
      vision: { provider: 'kimi' },
    });
    process.env.UTARUS_LLM_ROUTING = JSON.stringify({
      default: 'daily',
      has_images: 'vision',
      utility: 'daily',
    });
  }

  it('requires UTARUS_LLM_ROUTING when profiles are set', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-ds-test';
    process.env.UTARUS_LLM_PROFILES = JSON.stringify({ daily: { provider: 'deepseek' } });
    const { assertLlmConfig } = await freshLLM();
    expect(() => assertLlmConfig()).toThrow(/UTARUS_LLM_ROUTING is required/);
  });

  it('resolves daily + vision profiles and UI vision from has_images', async () => {
    setDailyVision();
    const {
      assertLlmConfig,
      getAgentLLM,
      getUiLlmCapabilities,
      isLlmRoutingEnabled,
      selectLlmProfileForTurn,
      resolveUtilityLlm,
    } = await freshLLM();
    assertLlmConfig();
    expect(isLlmRoutingEnabled()).toBe(true);
    expect(getAgentLLM().profileName).toBe('daily');
    expect(getAgentLLM().model.id).toBe('deepseek-v4-pro');
    expect(getUiLlmCapabilities().imageInput).toBe(true);

    const textTurn = selectLlmProfileForTurn({
      hasImages: false,
      text: 'hello',
      userSlug: 'u',
      isAdmin: false,
      channel: 'web',
    });
    expect(textTurn.profileName).toBe('daily');
    expect(textTurn.reason).toBe('default');

    const imgTurn = selectLlmProfileForTurn({
      hasImages: true,
      text: 'see this',
      userSlug: 'u',
      isAdmin: false,
      channel: 'web',
    });
    expect(imgTurn.profileName).toBe('vision');
    expect(imgTurn.reason).toBe('has_images');
    expect(imgTurn.resolved.capabilities.imageInput).toBe(true);

    const util = resolveUtilityLlm();
    expect(util.profileName).toBe('daily');
    expect(util.reason).toBe('utility');
  });

  it('throws on conflicting API keys for the same pi-ai provider', async () => {
    process.env.UTARUS_LLM_API_KEY = 'sk-a';
    process.env.MY_CUSTOM_LLM_KEY = 'sk-b';
    process.env.UTARUS_LLM_PROFILES = JSON.stringify({
      a: {
        provider: 'generic',
        model: 'm1',
        baseUrl: 'http://localhost/a',
        apiKeyEnv: 'UTARUS_LLM_API_KEY',
      },
      b: {
        provider: 'generic',
        model: 'm2',
        baseUrl: 'http://localhost/b',
        apiKeyEnv: 'MY_CUSTOM_LLM_KEY',
      },
    });
    process.env.UTARUS_LLM_ROUTING = JSON.stringify({ default: 'a' });
    const { assertLlmConfig } = await freshLLM();
    expect(() => assertLlmConfig()).toThrow(/Conflicting API keys/);
  });

  it('routes heavy by keyword and min chars', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-ds-test';
    process.env.KIMI_API_KEY = 'sk-kimi-test';
    process.env.UTARUS_LLM_PROFILES = JSON.stringify({
      daily: { provider: 'deepseek' },
      heavy: { provider: 'kimi' },
    });
    process.env.UTARUS_LLM_ROUTING = JSON.stringify({
      default: 'daily',
      heavy: 'heavy',
    });
    process.env.UTARUS_LLM_ROUTE_HEAVY_KEYWORDS = 'Deep Dive,proof';
    process.env.UTARUS_LLM_ROUTE_HEAVY_MIN_CHARS = '50';
    const { assertLlmConfig, selectLlmProfileForTurn } = await freshLLM();
    assertLlmConfig();

    const byKw = selectLlmProfileForTurn({
      hasImages: false,
      text: 'Please do a Deep Dive on AAPL',
      userSlug: 'u',
      isAdmin: false,
      channel: 'web',
    });
    expect(byKw.reason).toBe('heavy_keyword');
    expect(byKw.profileName).toBe('heavy');

    const byChars = selectLlmProfileForTurn({
      hasImages: false,
      text: 'x'.repeat(50),
      userSlug: 'u',
      isAdmin: false,
      channel: 'cli',
    });
    expect(byChars.reason).toBe('heavy_chars');

    const domain = selectLlmProfileForTurn({
      hasImages: false,
      text: 'hi',
      userSlug: 'u',
      isAdmin: false,
      channel: 'task',
      domainProfile: 'heavy',
    });
    expect(domain.reason).toBe('domain');
    expect(domain.profileName).toBe('heavy');
  });

  it('does not apply process-global UTARUS_LLM_IMAGE_INPUT to every routing profile', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-ds-test';
    process.env.KIMI_API_KEY = 'sk-kimi-test';
    process.env.UTARUS_LLM_IMAGE_INPUT = 'true';
    process.env.UTARUS_LLM_PROFILES = JSON.stringify({
      daily: { provider: 'deepseek' },
      vision: { provider: 'kimi' },
    });
    process.env.UTARUS_LLM_ROUTING = JSON.stringify({
      default: 'daily',
      has_images: 'vision',
    });
    const { assertLlmConfig, getLlmProfile } = await freshLLM();
    assertLlmConfig();
    // daily stays text-only unless profile.imageInput is set
    expect(getLlmProfile('daily').capabilities.imageInput).toBe(false);
    expect(getLlmProfile('vision').capabilities.imageInput).toBe(true);
  });

  it('parseHeavyKeywords lowercases tokens', async () => {
    const { parseHeavyKeywords } = await freshLLM();
    expect(parseHeavyKeywords('Deep Dive,  PROOF ,')).toEqual(['deep dive', 'proof']);
  });
});

describe('LLM stream retries (UTARUS_LLM_MAX_RETRIES)', () => {
  it('defaults to DEFAULT_LLM_MAX_RETRIES when unset', async () => {
    const { getLlmMaxRetries, getLlmStreamRetryOptions, DEFAULT_LLM_MAX_RETRIES } =
      await freshLLM();
    expect(getLlmMaxRetries()).toBe(DEFAULT_LLM_MAX_RETRIES);
    expect(DEFAULT_LLM_MAX_RETRIES).toBe(4);
    expect(getLlmStreamRetryOptions()).toEqual({ maxRetries: 4 });
  });

  it('honours UTARUS_LLM_MAX_RETRIES including 0 (disable)', async () => {
    process.env.UTARUS_LLM_MAX_RETRIES = '0';
    const { getLlmMaxRetries, getLlmStreamRetryOptions } = await freshLLM();
    expect(getLlmMaxRetries()).toBe(0);
    expect(getLlmStreamRetryOptions()).toEqual({ maxRetries: 0 });
  });

  it('includes maxRetryDelayMs when set', async () => {
    process.env.UTARUS_LLM_MAX_RETRIES = '3';
    process.env.UTARUS_LLM_MAX_RETRY_DELAY_MS = '30000';
    const { getLlmStreamRetryOptions } = await freshLLM();
    expect(getLlmStreamRetryOptions()).toEqual({
      maxRetries: 3,
      maxRetryDelayMs: 30_000,
    });
  });

  it('throws on invalid maxRetries / maxRetryDelayMs', async () => {
    process.env.UTARUS_LLM_MAX_RETRIES = '-1';
    const { getLlmMaxRetries } = await freshLLM();
    expect(() => getLlmMaxRetries()).toThrow(/UTARUS_LLM_MAX_RETRIES/);

    delete process.env.UTARUS_LLM_MAX_RETRIES;
    process.env.UTARUS_LLM_MAX_RETRY_DELAY_MS = '1.5';
    const mod = await freshLLM();
    expect(() => mod.getLlmMaxRetryDelayMs()).toThrow(/UTARUS_LLM_MAX_RETRY_DELAY_MS/);
  });

  it('assertLlmConfig validates retry env', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-ds-test';
    process.env.UTARUS_LLM_MAX_RETRIES = 'not-a-number';
    const { assertLlmConfig } = await freshLLM();
    expect(() => assertLlmConfig()).toThrow(/UTARUS_LLM_MAX_RETRIES/);
  });
});

