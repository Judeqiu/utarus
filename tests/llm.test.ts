import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
