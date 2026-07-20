import { describe, expect, it } from 'vitest';
import { createMemoryWidgetStateStore } from '../src/widgets/state-store-bindrive.js';
import { randomUUID } from 'crypto';

describe('WidgetStateStore memory', () => {
  it('create load update conflict', async () => {
    const store = createMemoryWidgetStateStore();
    const instanceId = randomUUID();
    const ref = { backend: 'bindrive' as const, ownerSlug: 'demo', instanceId };

    const c = await store.save(ref, {
      kind: 'floor-plan-3d',
      data: { rooms: [] },
      expectedRevision: 0,
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.doc.revision).toBe(1);

    const loaded = await store.load(ref);
    expect(loaded.ok).toBe(true);

    const u = await store.save(ref, {
      kind: 'floor-plan-3d',
      data: { rooms: [{ id: 'a' }] },
      expectedRevision: 1,
    });
    expect(u.ok).toBe(true);
    if (!u.ok) return;
    expect(u.doc.revision).toBe(2);

    const conflict = await store.save(ref, {
      kind: 'floor-plan-3d',
      data: { rooms: [] },
      expectedRevision: 1,
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.code).toBe('conflict');
      expect(conflict.currentRevision).toBe(2);
    }
  });
});
