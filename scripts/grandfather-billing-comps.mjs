#!/usr/bin/env node
/**
 * Grandfather selected users as admin-comped when turning billing on.
 *
 * Usage:
 *   UTARUS_DATA_ROOT=./data node scripts/grandfather-billing-comps.mjs \
 *     --plan pro --by ops --slugs alice,bob
 *
 * Or pass a file of slugs (one per line):
 *   node scripts/grandfather-billing-comps.mjs --plan pro --by ops --file slugs.txt
 *
 * Requires UTARUS_BILLING_ENABLED=true and a valid plans catalog
 * (DomainExtension is not available here — uses data/config/plans.yaml).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { parse, stringify } from 'yaml';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  return process.argv[i + 1];
}

function hasFlag(name) {
  return process.argv.includes(name);
}

const dataRoot = resolve(process.env.UTARUS_DATA_ROOT || './data');
const planId = arg('--plan');
const by = arg('--by', 'grandfather-script');
const slugsArg = arg('--slugs', '');
const fileArg = arg('--file');
const dryRun = hasFlag('--dry-run');

if (!planId) {
  console.error('Usage: grandfather-billing-comps.mjs --plan <plan_id> --slugs a,b | --file slugs.txt [--by name] [--dry-run]');
  process.exit(1);
}

if (process.env.UTARUS_BILLING_ENABLED !== 'true') {
  console.error('Set UTARUS_BILLING_ENABLED=true before grandfathering.');
  process.exit(1);
}

const plansPath = join(dataRoot, 'config', 'plans.yaml');
if (!existsSync(plansPath)) {
  console.error(`Plans catalog not found: ${plansPath}`);
  process.exit(1);
}
const catalog = parse(readFileSync(plansPath, 'utf-8'));
if (!catalog?.plans?.[planId]) {
  console.error(`Plan "${planId}" not in ${plansPath}`);
  process.exit(1);
}

let slugs = slugsArg
  ? slugsArg.split(',').map((s) => s.trim()).filter(Boolean)
  : [];
if (fileArg) {
  const lines = readFileSync(fileArg, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  slugs = [...slugs, ...lines];
}
slugs = [...new Set(slugs)];
if (slugs.length === 0) {
  console.error('No slugs provided.');
  process.exit(1);
}

const billingDir = join(dataRoot, 'billing');
mkdirSync(billingDir, { recursive: true });

for (const slug of slugs) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    console.error(`Invalid slug: ${slug}`);
    process.exit(1);
  }
  const path = join(billingDir, `${slug}.yaml`);
  let existing = {};
  if (existsSync(path)) {
    existing = parse(readFileSync(path, 'utf-8')) || {};
  }
  const next = {
    ...existing,
    version: 1,
    user_slug: slug,
    plan_id: planId,
    status: 'comped',
    comped_plan_id: planId,
    comped_by: by,
    updated_at: new Date().toISOString(),
  };
  console.log(`${dryRun ? '[dry-run] ' : ''}comp ${slug} → ${planId}`);
  if (!dryRun) {
    writeFileSync(path, stringify(next, { sortMapEntries: false }), 'utf-8');
  }
}

console.log(`Done. ${slugs.length} slug(s).`);
