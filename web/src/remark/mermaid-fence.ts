/**
 * remark-mermaid-fence — tags ```mermaid code nodes with data-diagram-* for DiagramEmbed.
 */

import type { Plugin } from 'unified';
import type { Root, Code } from 'mdast';
import { visit } from 'unist-util-visit';
import { parseMermaidFenceBody } from '../diagrams/diagram-spec.js';

export const remarkMermaidFence: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, 'code', (node: Code) => {
      if (node.lang !== 'mermaid') return;
      const result = parseMermaidFenceBody(node.value ?? '');
      const data = (node.data ??= {});
      if (!result.ok) {
        data.hProperties = {
          'data-diagram': 'error',
          'data-diagram-error': result.error,
        };
        return;
      }
      data.hProperties = {
        'data-diagram': '1',
      };
    });
  };
};
