import { describe, it, expect } from 'vitest';
import {
  ensureWidgetFencesInText,
  fenceBodyFromWidgetToolResult,
  widgetInstanceIdsInText,
} from '../src/webapp/chat/widget-fences.js';

const OPEN_FENCE = [
  'action: open',
  'instanceId: 51087f00-994e-47c1-b3e3-e5fae179bae2',
  'kind: rich-document',
  'title: 镜中人',
  'persistence: bindrive',
  'props: {"mode":"edit"}',
].join('\n');

const UPDATE_FENCE = [
  'action: update',
  'instanceId: 51087f00-994e-47c1-b3e3-e5fae179bae2',
  'kind: rich-document',
  'title: 镜中人 (rev)',
  'persistence: bindrive',
  'props: {"mode":"edit"}',
].join('\n');

const OTHER_OPEN = [
  'action: open',
  'instanceId: aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  'kind: rich-document',
  'title: Other',
  'persistence: bindrive',
  'props: {}',
].join('\n');

describe('widgetInstanceIdsInText', () => {
  it('returns empty for prose without fences', () => {
    expect(widgetInstanceIdsInText('剧本已经打开在侧边栏了！')).toEqual(new Set());
  });

  it('extracts instanceId from a widget fence', () => {
    const text = `hello\n\n\`\`\`widget\n${OPEN_FENCE}\n\`\`\`\n`;
    expect(widgetInstanceIdsInText(text)).toEqual(
      new Set(['51087f00-994e-47c1-b3e3-e5fae179bae2']),
    );
  });
});

describe('ensureWidgetFencesInText', () => {
  it('appends missing fence when model forgot to paste', () => {
    const text = '剧本已经打开在侧边栏了！';
    const out = ensureWidgetFencesInText(text, [OPEN_FENCE]);
    expect(out).toContain('剧本已经打开在侧边栏了！');
    expect(out).toContain('```widget');
    expect(out).toContain('instanceId: 51087f00-994e-47c1-b3e3-e5fae179bae2');
    expect(out).toContain('kind: rich-document');
  });

  it('does not duplicate when fence already present', () => {
    const text = `note\n\n\`\`\`widget\n${OPEN_FENCE}\n\`\`\`\n`;
    const out = ensureWidgetFencesInText(text, [OPEN_FENCE]);
    expect(out).toBe(text);
  });

  it('prefers last fence body for same instance when injecting', () => {
    const text = 'no fence yet';
    const out = ensureWidgetFencesInText(text, [OPEN_FENCE, UPDATE_FENCE]);
    expect(out).toContain('action: update');
    expect(out).not.toContain('action: open');
    expect((out.match(/```widget/g) ?? []).length).toBe(1);
  });

  it('injects only instances missing from text', () => {
    const text = `have one\n\n\`\`\`widget\n${OPEN_FENCE}\n\`\`\`\n`;
    const out = ensureWidgetFencesInText(text, [OPEN_FENCE, OTHER_OPEN]);
    expect(out).toContain('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    expect((out.match(/```widget/g) ?? []).length).toBe(2);
  });

  it('throws on invalid fence body (fail-fast)', () => {
    expect(() => ensureWidgetFencesInText('x', ['not-a-fence'])).toThrow(
      /invalid fence/,
    );
  });
});

describe('fenceBodyFromWidgetToolResult', () => {
  it('returns fence from tool details', () => {
    const body = fenceBodyFromWidgetToolResult('show_widget', {
      content: [{ type: 'text', text: 'ok' }],
      details: { instanceId: '51087f00-994e-47c1-b3e3-e5fae179bae2', fence: OPEN_FENCE },
    });
    expect(body).toBe(OPEN_FENCE);
  });

  it('throws when details.fence missing', () => {
    expect(() =>
      fenceBodyFromWidgetToolResult('show_widget', {
        content: [],
        details: { instanceId: 'x' },
      }),
    ).toThrow(/without details\.fence/);
  });
});
