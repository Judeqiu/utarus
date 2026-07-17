/**
 * Per-user usage caps. Caps are defined in <DATA_ROOT>/config/caps.yaml:
 *
 *   default:
 *     llm_total_tokens: 500000
 *     llm_cost_usd: 5.0
 *     tools:
 *       firecrawl: 50
 *       post_html_report: 20
 *   overrides:
 *     some-user-slug:
 *       llm_total_tokens: 1000000
 *       tools:
 *         firecrawl: 200
 *
 * - Missing file or section = no cap (unlimited).
 * - Admins always bypass caps (handled by callers, not here).
 * - Per-slug override merges over default — override does NOT replace.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import { resolveDataRoot } from '../config.js';
import { loadUsage } from './usage-file.js';

export type CapKind = 'llm_total_tokens' | 'llm_cost_usd' | `tools.${string}`;

interface CapsConfig {
  default?: Record<string, unknown>;
  overrides?: Record<string, Record<string, unknown>>;
}

let cachedRaw: string | null = null;
let cachedConfig: CapsConfig = {};

/**
 * Returns the path to the caps file (for error messages / surfacing to user).
 */
export function capsFilePath(): string {
  return join(resolveDataRoot(), 'config', 'caps.yaml');
}

function reload(): void {
  const path = capsFilePath();
  if (!existsSync(path)) {
    cachedConfig = {};
    cachedRaw = '';
    return;
  }
  const raw = readFileSync(path, 'utf-8');
  if (raw === cachedRaw) return;
  cachedRaw = raw;
  const parsed = parse(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Caps file is not a mapping: ${path}`);
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
 * Pre-turn LLM cap check shared by all chat interfaces. Returns a user-facing
 * rejection message when the user is at/over their monthly token cap, or null
 * when the turn may proceed. Fails open (logs + null) so a broken usage file
 * never blocks chat.
 */
export function checkLlmCap(userSlug: string, isAdmin: boolean): string | null {
  try {
    if (!userSlug || isAdmin) return null;
    const cap = getCap(userSlug, 'llm_total_tokens');
    if (cap === undefined) return null;
    const current = loadUsage(userSlug).period_llm.total_tokens;
    if (current >= cap) {
      return `🚫 You've hit your monthly LLM token cap (${current.toLocaleString('en-US')}/${cap.toLocaleString('en-US')} tokens). Contact an admin to raise it.`;
    }
    return null;
  } catch (err) {
    console.warn(
      `[usage/caps] LLM cap check failed for slug=${userSlug}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
