/**
 * Per-user usage caps. Caps are defined in <DATA_ROOT>/config/caps.yaml:
 *
 *   default:
 *     llm_total_tokens: 500000
 *     llm_cost_usd: 5.0
 *     tools:
 *       seedance_generate: 10
 *       firecrawl: 50
 *   overrides:
 *     some-user-slug:
 *       llm_total_tokens: 1000000
 *       tools:
 *         seedance_generate: 50
 *
 * - Missing file or section = no cap (unlimited).
 * - Admins always bypass caps (handled by callers, not here).
 * - Per-slug override merges over default — override does NOT replace.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import { config } from '../config.js';

const CAPS_FILE = join(config.dataRoot, 'config', 'caps.yaml');

export type CapKind = 'llm_total_tokens' | 'llm_cost_usd' | `tools.${string}`;

interface CapsConfig {
  default?: Record<string, unknown>;
  overrides?: Record<string, Record<string, unknown>>;
}

let cachedRaw: string | null = null;
let cachedConfig: CapsConfig = {};

function reload(): void {
  if (!existsSync(CAPS_FILE)) {
    cachedConfig = {};
    cachedRaw = '';
    return;
  }
  const raw = readFileSync(CAPS_FILE, 'utf-8');
  if (raw === cachedRaw) return;
  cachedRaw = raw;
  const parsed = parse(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Caps file is not a mapping: ${CAPS_FILE}`);
  }
  cachedConfig = parsed as CapsConfig;
}

/**
 * Read a cap value for a user. Returns undefined if no cap is set (unlimited).
 * Merge order: override.<slug>.<key> → default.<key>.
 */
export function getCap(slug: string, kind: CapKind): number | undefined {
  reload();
  const lookup = (section: Record<string, unknown> | undefined): number | undefined => {
    if (!section) return undefined;
    if (kind.startsWith('tools.')) {
      const toolName = kind.slice('tools.'.length);
      const tools = section.tools as Record<string, number> | undefined;
      const v = tools?.[toolName];
      return typeof v === 'number' ? v : undefined;
    }
    const v = section[kind];
    return typeof v === 'number' ? v : undefined;
  };
  const overrideVal = lookup(cachedConfig.overrides?.[slug]);
  if (overrideVal !== undefined) return overrideVal;
  return lookup(cachedConfig.default);
}

/**
 * Returns the path to the caps file (for error messages / surfacing to user).
 */
export function capsFilePath(): string {
  return CAPS_FILE;
}
