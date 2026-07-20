import { describe, expect, it } from 'vitest';
import {
  parseWidgetFenceBody,
  toFence,
  validateWidgetSpec,
  isAllowedWidgetEntryUrl,
  WIDGET_PROPS_MAX_BYTES,
} from '../src/widgets/widget-spec.js';
import { randomUUID } from 'crypto';

const id = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

describe('widget-spec', () => {
  it('round-trips open fence', () => {
    const spec = {
      action: 'open' as const,
      instanceId: id,
      kind: 'floor-plan-3d',
      title: 'Unit 12B',
      props: { unitLabel: '12B' },
      persistence: 'bindrive' as const,
      summary: 'demo',
    };
    const body = toFence(spec);
    const parsed = parseWidgetFenceBody(body);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.spec.instanceId).toBe(id);
      expect(parsed.spec.props).toEqual({ unitLabel: '12B' });
      expect(parsed.spec.persistence).toBe('bindrive');
    }
  });

  it('rejects multi-line props', () => {
    const body = [
      'action: open',
      `instanceId: ${id}`,
      'kind: floor-plan-3d',
      'title: X',
      'persistence: none',
      'props: {',
      '  "a": 1',
      '}',
    ].join('\n');
    const parsed = parseWidgetFenceBody(body);
    expect(parsed.ok).toBe(false);
  });

  it('rejects fields after props', () => {
    const body = [
      'action: open',
      `instanceId: ${id}`,
      'kind: floor-plan-3d',
      'title: X',
      'persistence: none',
      'props: {}',
      'title: Y',
    ].join('\n');
    const parsed = parseWidgetFenceBody(body);
    expect(parsed.ok).toBe(false);
  });

  it('validateWidgetSpec fails without action', () => {
    const r = validateWidgetSpec({
      instanceId: id,
      kind: 'html-bundle',
      title: 't',
      props: {},
      persistence: 'none',
    });
    expect(r.ok).toBe(false);
  });

  it('isAllowedWidgetEntryUrl domain-assets', () => {
    expect(
      isAllowedWidgetEntryUrl('/domain-assets/demo/widgets/x/index.html', {
        viewerSlug: 'u',
        agentKey: 'demo',
      }),
    ).toBe(true);
    expect(
      isAllowedWidgetEntryUrl('/domain-assets/other/widgets/x/index.html', {
        viewerSlug: 'u',
        agentKey: 'demo',
      }),
    ).toBe(false);
  });

  it('props size boundary', () => {
    const big = 'x'.repeat(WIDGET_PROPS_MAX_BYTES + 1);
    const r = validateWidgetSpec({
      action: 'open',
      instanceId: randomUUID(),
      kind: 'html-bundle',
      title: 't',
      props: { big },
      persistence: 'none',
      entry: '/reports/a.html',
    });
    expect(r.ok).toBe(false);
  });
});
