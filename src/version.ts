/**
 * Framework package version (from package.json).
 * Used by WebUI, health, and API metadata.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  version: string;
};

if (typeof pkg.version !== 'string' || !pkg.version) {
  throw new Error('utarus package.json missing version');
}

export const UTARUS_VERSION: string = pkg.version;
