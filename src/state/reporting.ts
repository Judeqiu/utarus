/**
 * Global user-reporting store.
 *
 * Append-only YAML at <DATA_ROOT>/reporting.yaml. Any user can submit a
 * report; admins list them. No defaults / silent recovery — malformed files
 * fail fast.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { parse, stringify } from 'yaml';
import { resolveDataRoot } from '../config.js';
import type { UserReport } from './types.js';

function reportingFilePath(): string {
  return join(resolveDataRoot(), 'reporting.yaml');
}

function loadReports(): UserReport[] {
  const path = reportingFilePath();
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  const parsed = parse(raw);
  if (parsed == null) return [];
  if (!Array.isArray(parsed)) {
    throw new Error(`reporting.yaml must be a YAML array: ${path}`);
  }
  return parsed as UserReport[];
}

function saveReports(reports: UserReport[]): void {
  const path = reportingFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringify(reports, { sortMapEntries: false }), 'utf-8');
}

export function appendReport(params: {
  reporterSlug: string;
  text: string;
  category?: string;
}): UserReport {
  const slug = (params.reporterSlug ?? '').trim();
  if (!slug) {
    throw new Error('reporterSlug is required');
  }
  const text = (params.text ?? '').trim();
  if (!text) {
    throw new Error('report text is required and must be non-empty');
  }

  const entry: UserReport = {
    id: randomUUID(),
    created_at: new Date().toISOString(),
    reporter_slug: slug,
    text,
  };
  const category = params.category?.trim();
  if (category) entry.category = category;

  const reports = loadReports();
  reports.push(entry);
  saveReports(reports);
  return entry;
}

export function listReports(filter?: {
  reporterSlug?: string;
  limit?: number;
}): UserReport[] {
  const loaded = loadReports();
  // Newest first for admin review. Tie-break by append order (later index wins).
  let reports = loaded
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      if (a.r.created_at !== b.r.created_at) {
        return a.r.created_at < b.r.created_at ? 1 : -1;
      }
      return b.i - a.i;
    })
    .map(x => x.r);
  if (filter?.reporterSlug) {
    const slug = filter.reporterSlug.trim();
    reports = reports.filter(r => r.reporter_slug === slug);
  }
  if (filter?.limit != null) {
    if (!Number.isFinite(filter.limit) || filter.limit < 1) {
      throw new Error(`limit must be a positive number, got: ${filter.limit}`);
    }
    reports = reports.slice(0, Math.floor(filter.limit));
  }
  return reports;
}

/** Absolute path of the reporting file (for diagnostics / tool messages). */
export function reportingPath(): string {
  return reportingFilePath();
}
