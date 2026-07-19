/**
 * Multi-LLM routing types — profiles, routing config, turn context, decisions.
 */

import type { Model } from '@earendil-works/pi-ai';

/** Native capabilities of an LLM (model nature, not agent usage). */
export interface LlmCapabilities {
  /**
   * The model accepts image input (vision). Drives `model.input`.
   * Overridable via UTARUS_LLM_IMAGE_INPUT (legacy) or profile.imageInput.
   */
  imageInput: boolean;
}

export type LlmProviderKind = 'deepseek' | 'kimi' | 'generic';

/** Operator-facing profile config (one entry in UTARUS_LLM_PROFILES). */
export interface LlmProfileConfig {
  provider: LlmProviderKind;
  model?: string;
  baseUrl?: string;
  /** Env var name holding the API key. Defaults to provider default. */
  apiKeyEnv?: string;
  /**
   * Optional strict override for imageInput: true | false only.
   * When omitted, use provider/model defaults.
   */
  imageInput?: boolean;
}

export interface LlmRoutingConfig {
  /** Profile for ordinary turns. Required in routing mode. */
  default: string;
  /** Profile for turns with user image attachments. */
  has_images?: string;
  /** Profile for title generation; when omitted, uses default. */
  utility?: string;
  /** Profile for optional heavy/complex turns. */
  heavy?: string;
}

export interface ResolvedLLM {
  model: Model<'openai-completions'>;
  apiKey: string;
  capabilities: LlmCapabilities;
  /** Profile name; "default" in legacy mode. */
  profileName: string;
}

export interface LlmTurnContext {
  hasImages: boolean;
  /**
   * User-visible text (+ optional domain enrich). Never include WEB_CHANNEL_HINT
   * or [Active model: …] prefixes.
   */
  text: string;
  userSlug: string;
  isAdmin: boolean;
  channel: 'web' | 'telegram' | 'slack' | 'cli' | 'title' | 'task' | 'other';
  conversationId?: string;
  /** Domain vote already resolved; selectLlmProfileForTurn does not call the hook. */
  domainProfile?: string | null;
}

export type LlmRouteReason =
  | 'has_images'
  | 'domain'
  | 'heavy_chars'
  | 'heavy_keyword'
  | 'default'
  | 'utility'
  | 'legacy';

export interface LlmRouteDecision {
  profileName: string;
  reason: LlmRouteReason;
  resolved: ResolvedLLM;
}

export interface ResolveLlmProfileContext {
  text: string;
  /** Always false when the hook is invoked (framework skips hook on image turns). */
  hasImages: false;
  userSlug: string;
  isAdmin: boolean;
  channel: Exclude<LlmTurnContext['channel'], 'title'>;
  conversationId?: string;
}
