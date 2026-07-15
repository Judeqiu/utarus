/**
 * Password primitives — bcrypt hash/verify + memorable-password generator.
 *
 * Used by:
 *   - ensureChannelUser (preset password at profile creation)
 *   - authenticateUser (web login with username + password)
 *   - scripts/backfill-passwords.mjs (one-time preset for legacy users)
 *
 * Cost 10 is the bcrypt precedent from lexserver/tests/utils/testAuth.js.
 * ~100ms per verify on modern hardware — intentional online-attack throttle.
 *
 * Per project rules: no fallback, no silent defaults. hashPassword rejects
 * too-short plaintext rather than padding or coercing.
 */

import { randomInt } from 'crypto';
import bcrypt from 'bcrypt';

const BCRYPT_COST = 10;
const MIN_PASSWORD_LEN = 6;

export async function hashPassword(plain: string): Promise<string> {
  if (!plain || plain.length < MIN_PASSWORD_LEN) {
    throw new Error(
      `password must be at least ${MIN_PASSWORD_LEN} chars (got ${plain ? plain.length : 0})`,
    );
  }
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (!plain || !hash) return false;
  return bcrypt.compare(plain, hash);
}

/**
 * Wordlist for memorable passwords. ~200 unique lowercase nouns, each ≤8
 * letters, no homophones, no apostrophes/hyphens. Three random picks → ~23
 * bits of entropy (comparable to a 4-digit PIN but human-memorable). Online-
 * attack resistance relies on bcrypt cost, not password entropy.
 */
const WORDLIST: readonly string[] = [
  // landforms
  'river', 'stone', 'cloud', 'forest', 'mountain', 'ocean', 'meadow', 'valley',
  'island', 'desert', 'canyon', 'harbor', 'beach', 'cliff', 'summit', 'cave',
  'lake', 'creek', 'spring', 'glacier', 'plateau', 'delta', 'reef', 'dune',
  // plants
  'willow', 'cedar', 'maple', 'birch', 'pine', 'oak', 'ash', 'fern',
  'moss', 'reed', 'lily', 'rose', 'iris', 'lotus', 'daisy', 'poppy',
  'ivy', 'bamboo', 'palm', 'shrub', 'thorn', 'root', 'branch', 'leaf',
  // animals
  'wolf', 'bear', 'fox', 'hare', 'deer', 'moose', 'lynx', 'owl',
  'hawk', 'finch', 'raven', 'swan', 'heron', 'crane', 'robin', 'wren',
  'sparrow', 'dove', 'colt', 'lamb', 'ewe', 'ram', 'bison', 'camel',
  'falcon', 'magpie', 'lark', 'stork', 'stallion', 'mare', 'otter', 'badger',
  // minerals / materials
  'silver', 'golden', 'copper', 'iron', 'jade', 'pearl', 'coral', 'amber',
  'ruby', 'opal', 'glass', 'marble', 'granite', 'basalt', 'flint', 'sand',
  'clay', 'chalk', 'pumice', 'quartz', 'bronze', 'tin', 'zinc', 'obsidian',
  // colors
  'scarlet', 'crimson', 'azure', 'teal', 'ivory', 'ebony', 'indigo', 'violet',
  'yellow', 'orange', 'purple', 'green', 'olive', 'cyan', 'mint', 'rose',
  // time / sky
  'summer', 'winter', 'autumn', 'morning', 'evening', 'midnight', 'dawn', 'dusk',
  'noon', 'twilight', 'sunrise', 'sunset', 'harvest', 'solstice', 'equinox', 'aurora',
  // directions / cosmos
  'polar', 'solar', 'lunar', 'stellar', 'comet', 'meteor', 'nebula', 'quasar',
  'orbit', 'horizon', 'zenith', 'galaxy', 'cosmos', 'eclipse', 'planet', 'crater',
  // everyday objects
  'paper', 'pencil', 'candle', 'lantern', 'mirror', 'button', 'thread', 'needle',
  'hammer', 'anvil', 'chisel', 'plane', 'lathe', 'loom', 'spindle', 'wheel',
  'bridge', 'tower', 'castle', 'manor', 'cottage', 'barn', 'stable', 'garden',
  'orchard', 'vineyard', 'grove', 'fountain', 'gate', 'clock', 'bell', 'drum',
  'harp', 'flute', 'violin', 'cello', 'piano', 'book', 'scroll', 'map',
  // geometry / architecture
  'circle', 'square', 'spiral', 'arch', 'column', 'pillar', 'window', 'door',
  'stair', 'roof', 'floor', 'hearth', 'oven', 'kettle', 'anchor', 'sail',
  'mast', 'rudder', 'oar', 'buoy', 'wagon', 'saddle', 'reins', 'cart',
  'crown', 'scepter', 'shield', 'banner', 'medal', 'crest', 'emblem', 'pyramid',
];

export function generateMemorablePassword(): string {
  if (WORDLIST.length < 2) throw new Error('WORDLIST must contain multiple entries');
  const picks: string[] = [];
  for (let i = 0; i < 3; i++) {
    picks.push(WORDLIST[randomInt(WORDLIST.length)]);
  }
  return picks.join('-');
}
