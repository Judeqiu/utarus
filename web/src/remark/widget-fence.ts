/**
 * remark-widget-fence — tags ```widget code nodes for WidgetCard.
 */

import type { Plugin } from 'unified';
import type { Root, Code } from 'mdast';
import { visit } from 'unist-util-visit';
import { parseWidgetFenceBody } from '../widgets/widget-spec.js';

export const remarkWidgetFence: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, 'code', (node: Code) => {
      if (node.lang !== 'widget') return;
      const result = parseWidgetFenceBody(node.value ?? '');
      const data = (node.data ??= {});
      if (!result.ok) {
        data.hProperties = {
          'data-widget': 'error',
          'data-widget-error': result.error,
        };
        return;
      }
      const s = result.spec;
      data.hProperties = {
        'data-widget': '1',
        'data-widget-instance-id': s.instanceId,
        'data-widget-kind': s.kind,
        'data-widget-title': s.title,
        'data-widget-action': s.action,
        'data-widget-persistence': s.persistence,
      };
    });
  };
};
