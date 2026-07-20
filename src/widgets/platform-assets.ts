/**
 * Locate built platform widget static root (`dist/platform-widgets`).
 */

import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Candidates (first existing directory wins):
 *  1. production / published: dist/widgets/platform-assets.ts → ../platform-widgets
 *     (from dist/widgets → dist/platform-widgets)
 *  2. tsx from src/widgets: src/widgets → ../../dist/platform-widgets
 *  3. from dist/webapp (server): dist/webapp → ../platform-widgets
 *  4. from src/webapp: src/webapp → ../../dist/platform-widgets
 *
 * Callers under widgets/ use candidates relative to this module.
 * Server re-exports / may call with its own __dirname via resolvePlatformWidgetsDistDirFrom.
 */
export function resolvePlatformWidgetsDistDir(): string | null {
  return resolvePlatformWidgetsDistDirFrom(__dirname);
}

/** Testable: resolve relative to an arbitrary module directory. */
export function resolvePlatformWidgetsDistDirFrom(moduleDir: string): string | null {
  const candidates = [
    resolve(moduleDir, '../platform-widgets'),
    resolve(moduleDir, '../../dist/platform-widgets'),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return null;
}
