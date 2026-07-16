import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parse } from 'yaml';

const dataRoot = mkdtempSync(join(tmpdir(), 'utarus-reporting-'));
process.env.UTARUS_LOADED_BY_HOST = '1';
process.env.UTARUS_DATA_ROOT = dataRoot;

const {
  appendReport,
  listReports,
  reportingPath,
} = await import('../src/state/reporting.js');
const { createReportingTools } = await import('../src/tools/reporting.js');

describe('global reporting store', () => {
  beforeEach(() => {
    const path = join(dataRoot, 'reporting.yaml');
    if (existsSync(path)) rmSync(path);
  });

  afterAll(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('appends reports to data/reporting.yaml', () => {
    const a = appendReport({
      reporterSlug: 'alice',
      text: 'The login button is broken',
      category: 'bug',
    });
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.reporter_slug).toBe('alice');
    expect(a.text).toBe('The login button is broken');
    expect(a.category).toBe('bug');
    expect(a.created_at).toBeTruthy();

    const path = reportingPath();
    expect(path).toBe(join(dataRoot, 'reporting.yaml'));
    expect(existsSync(path)).toBe(true);

    const onDisk = parse(readFileSync(path, 'utf-8')) as Array<{ id: string }>;
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]?.id).toBe(a.id);
  });

  it('lists newest first and filters by reporter', () => {
    appendReport({ reporterSlug: 'alice', text: 'first' });
    // Ensure distinct timestamps for sort stability
    const older = listReports()[0]!;
    appendReport({ reporterSlug: 'bob', text: 'second' });
    appendReport({ reporterSlug: 'alice', text: 'third' });

    const all = listReports();
    expect(all).toHaveLength(3);
    expect(all[0]?.text).toBe('third');
    expect(all.map(r => r.text)).toContain(older.text);

    const alice = listReports({ reporterSlug: 'alice' });
    expect(alice).toHaveLength(2);
    expect(alice.every(r => r.reporter_slug === 'alice')).toBe(true);

    const limited = listReports({ limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0]?.text).toBe('third');
  });

  it('fails fast on empty text or missing slug', () => {
    expect(() => appendReport({ reporterSlug: 'alice', text: '   ' }))
      .toThrow(/text is required/);
    expect(() => appendReport({ reporterSlug: '', text: 'hello' }))
      .toThrow(/reporterSlug is required/);
  });
});

describe('createReportingTools', () => {
  beforeEach(() => {
    const path = join(dataRoot, 'reporting.yaml');
    if (existsSync(path)) rmSync(path);
  });

  it('binds reporter to session userSlug and exposes list only for admin', async () => {
    const userTools = createReportingTools('carol', false);
    expect(userTools.map(t => t.name)).toEqual(['submit_report']);
    expect(userTools.map(t => t.name)).not.toContain('list_reports');

    const adminTools = createReportingTools('admin-user', true);
    expect(adminTools.map(t => t.name)).toEqual(['submit_report', 'list_reports']);

    const submit = userTools.find(t => t.name === 'submit_report')!;
    const result = await submit.execute('call-1', { text: 'please look at this', category: 'feedback' }, undefined as never);
    const details = result.details as { report: { reporter_slug: string; text: string } };
    expect(details.report.reporter_slug).toBe('carol');
    expect(details.report.text).toBe('please look at this');

    const list = adminTools.find(t => t.name === 'list_reports')!;
    const listed = await list.execute('call-2', {}, undefined as never);
    const listedDetails = listed.details as { reports: Array<{ reporter_slug: string }> };
    expect(listedDetails.reports).toHaveLength(1);
    expect(listedDetails.reports[0]?.reporter_slug).toBe('carol');
  });
});
