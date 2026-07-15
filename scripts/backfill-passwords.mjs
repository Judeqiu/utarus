#!/usr/bin/env node
/**
 * One-shot backfill: add a preset password_hash to every existing user YAML
 * that doesn't already have one. Plaintext is printed to stdout (one TSV
 * line per user: <slug>\t<contact_email>\t<preset>) so the operator can
 * pipe to a file, distribute out-of-band, then shred the file.
 *
 * Usage:
 *   node scripts/backfill-passwords.mjs /opt/invage/data
 *
 * Idempotent: users with a non-empty password_hash are skipped (the line
 * "SKIPPED <slug>" goes to stderr). Only missing hashes get generated.
 *
 * Per project rules: no fallback. If a user file cannot be parsed, the
 * script aborts with the error. Operators must fix the file and re-run.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse, stringify } from 'yaml';
import bcrypt from 'bcrypt';

const BCRYPT_COST = 10;

// Tiny memorable wordlist (kept local — the runtime wordlist lives in
// src/auth/password.ts but importing compiled TS from a CLI script is more
// ceremony than this 30-word list merits for a one-shot operation).
const WORDS = [
  'river', 'stone', 'cloud', 'forest', 'mountain', 'ocean', 'meadow', 'valley',
  'island', 'desert', 'canyon', 'harbor', 'beach', 'cliff', 'summit', 'cave',
  'lake', 'creek', 'spring', 'willow', 'cedar', 'maple', 'birch', 'pine',
  'wolf', 'bear', 'fox', 'hare', 'deer', 'moose', 'lynx', 'owl',
];

function pick3() {
  const a = WORDS[Math.floor(Math.random() * WORDS.length)];
  const b = WORDS[Math.floor(Math.random() * WORDS.length)];
  const c = WORDS[Math.floor(Math.random() * WORDS.length)];
  return `${a}-${b}-${c}`;
}

function main() {
  const dataRoot = process.argv[2];
  if (!dataRoot) {
    console.error('Usage: node scripts/backfill-passwords.mjs <data-root>');
    process.exit(2);
  }
  const usersDir = join(dataRoot, 'users');
  if (!existsSync(usersDir)) {
    console.error(`No users/ directory at ${usersDir}`);
    process.exit(2);
  }

  const files = readdirSync(usersDir).filter(f => f.endsWith('.yaml') && !f.startsWith('.'));
  if (files.length === 0) {
    console.error(`No user YAMLs at ${usersDir}`);
    process.exit(0);
  }

  let generated = 0;
  let skipped = 0;
  for (const fname of files) {
    const path = join(usersDir, fname);
    const raw = readFileSync(path, 'utf-8');
    let doc;
    try {
      doc = parse(raw);
    } catch (e) {
      console.error(`FAIL parse ${path}: ${(e instanceof Error ? e.message : String(e))}`);
      process.exit(1);
    }
    if (!doc || typeof doc !== 'object' || !doc.user) {
      console.error(`FAIL shape ${path}: missing top-level user key`);
      process.exit(1);
    }
    if (doc.user.password_hash && doc.user.password_hash.length > 0) {
      console.error(`SKIPPED ${doc.user.slug ?? fname}`);
      skipped++;
      continue;
    }
    const preset = pick3();
    doc.user.password_hash = bcrypt.hashSync(preset, BCRYPT_COST);
    writeFileSync(path, stringify(doc), 'utf-8');
    const slug = doc.user.slug ?? fname.replace(/\.yaml$/, '');
    const email = doc.profile?.contact_email ?? '';
    process.stdout.write(`${slug}\t${email}\t${preset}\n`);
    generated++;
  }
  console.error(`\nDone. Generated: ${generated}. Skipped (already had hash): ${skipped}.`);
  if (generated > 0) {
    console.error('Plaintext passwords are on stdout. Pipe to a file, distribute, then shred.');
  }
}

main();
