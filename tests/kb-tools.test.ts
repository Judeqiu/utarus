import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const dataRoot = mkdtempSync(join(tmpdir(), 'utarus-kb-tools-'));
process.env.UTARUS_LOADED_BY_HOST = '1';
process.env.UTARUS_DATA_ROOT = dataRoot;

const { blankState, saveState } = await import('../src/state/state-file.js');
const { createKbTools } = await import('../src/tools/kb.js');
const { userKbFilePath, sharedKbFilePath } = await import('../src/kb/kb-file.js');
const {
  createKb,
  getKb,
  listKb,
  searchKb,
  updateKb,
  deleteKb,
} = await import('../src/kb/service.js');

function seedUser(slug: string): void {
  saveState(
    blankState({
      slug,
      displayName: slug,
      contactEmail: `${slug}@example.com`,
    }),
  );
}

async function runTool(
  tools: ReturnType<typeof createKbTools>,
  name: string,
  params: Record<string, unknown>,
) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool.execute('test', params as never, undefined as never);
}

describe('KB service + tools', () => {
  beforeEach(() => {
    rmSync(dataRoot, { recursive: true, force: true });
    mkdirSync(join(dataRoot, 'users'), { recursive: true });
    mkdirSync(join(dataRoot, 'kb', 'users'), { recursive: true });
  });

  afterAll(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('create private requires user; creates file', async () => {
    await expect(
      createKb({
        userSlug: 'ghost',
        isAdmin: false,
        scope: 'private',
        title: 'x',
        body: 'y',
      }),
    ).rejects.toThrow();

    seedUser('alice');
    const e = await createKb({
      userSlug: 'alice',
      isAdmin: false,
      scope: 'private',
      title: 'Pref',
      body: 'Bullet summaries please',
      tags: ['Preference'],
    });
    expect(e.tags).toEqual(['preference']);
    expect(e.scope).toBe('private');
    expect(existsSync(userKbFilePath('alice'))).toBe(true);

    const got = getKb({ userSlug: 'alice', isAdmin: false, id: e.id });
    expect(got.body).toBe('Bullet summaries please');
  });

  it('non-admin cannot create shared; admin can', async () => {
    seedUser('alice');
    seedUser('ops');
    await expect(
      createKb({
        userSlug: 'alice',
        isAdmin: false,
        scope: 'shared',
        title: 'S',
        body: 'shared body',
      }),
    ).rejects.toThrow(/admin/i);

    const e = await createKb({
      userSlug: 'ops',
      isAdmin: true,
      scope: 'shared',
      title: 'Compliance',
      body: 'Not financial advice',
      tags: ['compliance'],
    });
    expect(e.owner_slug).toBe('ops');
    expect(existsSync(sharedKbFilePath())).toBe(true);

    // any user can read shared via get/list
    seedUser('bob');
    const rows = listKb({ userSlug: 'bob', isAdmin: false, scope: 'shared' });
    expect(rows.some((r) => r.id === e.id)).toBe(true);
    expect(rows[0]!.body_preview).toBeDefined();
    expect((rows[0] as { body?: string }).body).toBeUndefined();
  });

  it('list_kb default limit and body_preview; search finds keyword', async () => {
    seedUser('alice');
    await createKb({
      userSlug: 'alice',
      isAdmin: false,
      scope: 'private',
      title: 'Acme thesis',
      body: 'Long body about Acme Corp and market structure. '.repeat(20),
      tags: ['acme'],
    });
    const listed = listKb({ userSlug: 'alice', isAdmin: false });
    expect(listed).toHaveLength(1);
    expect(listed[0]!.body_truncated).toBe(true);
    expect(listed[0]!.body_preview.length).toBeLessThanOrEqual(240);

    const found = searchKb({
      userSlug: 'alice',
      isAdmin: false,
      query: 'acme corp',
    });
    expect(found).toHaveLength(1);
  });

  it('update null clears source; omit leaves fields', async () => {
    seedUser('alice');
    const e = await createKb({
      userSlug: 'alice',
      isAdmin: false,
      scope: 'private',
      title: 'T',
      body: 'B',
      source: 'conversation',
    });
    const u1 = await updateKb({
      userSlug: 'alice',
      isAdmin: false,
      id: e.id,
      body: 'B2',
    });
    expect(u1.source).toBe('conversation');
    expect(u1.body).toBe('B2');
    const u2 = await updateKb({
      userSlug: 'alice',
      isAdmin: false,
      id: e.id,
      source: null,
    });
    expect(u2.source).toBeNull();
  });

  it('delete private; get uses same not-found wording', async () => {
    seedUser('alice');
    const e = await createKb({
      userSlug: 'alice',
      isAdmin: false,
      scope: 'private',
      title: 'T',
      body: 'B',
    });
    await deleteKb({ userSlug: 'alice', isAdmin: false, id: e.id });
    expect(() => getKb({ userSlug: 'alice', isAdmin: false, id: e.id })).toThrow(
      /not found or not accessible/,
    );
  });

  it('WebUI admin slug can create shared without user yaml; private fails', async () => {
    await expect(
      createKb({
        userSlug: 'admin',
        isAdmin: true,
        scope: 'private',
        title: 'P',
        body: 'private',
      }),
    ).rejects.toThrow();

    const e = await createKb({
      userSlug: 'admin',
      isAdmin: true,
      scope: 'shared',
      title: 'Ops note',
      body: 'Shared from web admin',
    });
    expect(e.owner_slug).toBe('admin');
  });

  it('createKbTools wires list/create for user', async () => {
    seedUser('alice');
    const tools = createKbTools('alice', false);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'create_kb',
      'delete_kb',
      'get_kb',
      'list_kb',
      'search_kb',
      'update_kb',
    ]);

    const created = await runTool(tools, 'create_kb', {
      scope: 'private',
      title: 'Hello',
      body: 'World note',
      tags: ['demo'],
    });
    expect(created.content[0]!.type).toBe('text');
    expect((created.details as { entry: { id: string } } | null)?.entry?.id).toBeTruthy();

    const listed = await runTool(tools, 'list_kb', {});
    expect((listed.details as { entries: unknown[] }).entries).toHaveLength(1);

    const denied = await runTool(tools, 'create_kb', {
      scope: 'shared',
      title: 'Nope',
      body: 'should fail',
    });
    expect(denied.details).toBeNull();
    expect(denied.content[0]!.type).toBe('text');
    expect((denied.content[0] as { text: string }).text).toMatch(/admin/i);
  });
});
