/**
 * Per-model pricing for usage cost calculation. Prices live in
 * <DATA_ROOT>/config/pricing.yaml so they can be updated without code changes:
 *
 *   video_models:
 *     <model-name>:
 *       cny_per_million_tokens: <number>
 *
 * - Ark bills video generation in CNY per output token. We store and report
 *   the original currency — no FX conversion.
 * - Real prices for Seedance models are NOT in Ark's public pricing doc
 *   (only doubao-seaweed and wan2.1-14b are publicly listed). The operator
 *   must populate entries from the Volcengine console billing page.
 * - Missing file or model entry → getVideoModelPriceCnyPerMillionTokens
 *   returns undefined. Callers MUST log a loud error and record cost=0
 *   rather than silently defaulting.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import { config } from '../config.js';

const PRICING_FILE = join(config.dataRoot, 'config', 'pricing.yaml');

interface PricingConfig {
  video_models?: Record<string, { cny_per_million_tokens?: number }>;
}

function loadPricing(): PricingConfig {
  if (!existsSync(PRICING_FILE)) return {};
  const raw = readFileSync(PRICING_FILE, 'utf-8');
  const parsed = parse(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Pricing file is not a mapping: ${PRICING_FILE}`);
  }
  return parsed as PricingConfig;
}

/**
 * Returns CNY per 1 million tokens for the given Ark video model.
 * Undefined if the model is not listed in pricing.yaml.
 */
export function getVideoModelPriceCnyPerMillionTokens(model: string): number | undefined {
  const entry = loadPricing().video_models?.[model];
  if (!entry || typeof entry.cny_per_million_tokens !== 'number') return undefined;
  return entry.cny_per_million_tokens;
}

export function pricingFilePath(): string {
  return PRICING_FILE;
}
