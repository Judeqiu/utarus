#!/usr/bin/env node
/**
 * Mark user YAML files as beta (user.beta: true).
 *
 * Beta users: unlimited caps, no intro expiry (billing on).
 *
 * Usage:
 *   UTARUS_DATA_ROOT=/path/to/data node scripts/grandfather-beta-users.mjs --all
 *   UTARUS_DATA_ROOT=/path/to/data node scripts/grandfather-beta-users.mjs --slugs alice,bob
 *
 * Idempotent: already-beta users are skipped.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parse, stringify } from 'yaml';

const dataRoot = process.env.UTARUS_DATA_ROOT || './data';
const usersDir = join(dataRoot, 'users');

function parseArgs(argv) {
  let all = false;
  let slugs = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') all = true;
    else if (a === '--slugs' && argv[i + 1]) {
      slugs = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--help' || a === '-h') {
      console.log(`Usage:
  UTARUS_DATA_ROOT=./data node scripts/grandfather-beta-users.mjs --all
  UTARUS_DATA_ROOT=./data node scripts/grandfather-beta-users.mjs --slugs slug1,slug2`);
      process.exit(0);
    }
  }
  return { all, slugs };
}

function listSlugs() {
  if (!existsSync(usersDir)) {
    throw new Error(`Users dir not found: ${usersDir}`);
  }
  return readdirSync(usersDir)
    .filter((n) => n.endsWith('.yaml'))
    .map((n) => n.replace(/\.yaml$/, ''));
}

function markBeta(slug) {
  const path = join(usersDir, `${slug}.yaml`);
  if (!existsSync(path)) {
    throw new Error(`Missing user file: ${path}`);
  }
  const raw = parse(readFileSync(path, 'utf-8'));
  if (!raw?.user?.slug) {
    throw new Error(`Invalid user file (no user.slug): ${path}`);
  }
  if (raw.user.beta === true) {
    return { slug, changed: false };
  }
  raw.user.beta = true;
  if (!Array.isArray(raw.log)) raw.log = [];
  const today = new Date().toISOString().slice(0, 10);
  raw.log.push({ ts: today, action: 'grandfathered_beta' });
  writeFileSync(path, stringify(raw, { sortMapEntries: false }), 'utf-8');
  return { slug, changed: true };
}

const { all, slugs } = parseArgs(process.argv);
if (!all && slugs.length === 0) {
  console.error('Provide --all or --slugs a,b,c');
  process.exit(1);
}
const targets = all ? listSlugs() : slugs;
if (targets.length === 0) {
  console.error('No users to process');
  process.exit(1);
}

let changed = 0;
let skipped = 0;
for (const slug of targets) {
  const r = markBeta(slug);
  if (r.changed) {
    console.log(`beta: ${slug}`);
    changed += 1;
  } else {
    console.log(`skip (already beta): ${slug}`);
    skipped += 1;
  }
}
console.log(`Done. changed=${changed} skipped=${skipped} dataRoot=${dataRoot}`);
