/**
 * remark-card-fence — tags ```card code nodes for InfoCard / InfoCardDeck.
 */

import type { Plugin } from 'unified';
import type { Root, Code } from 'mdast';
import { visit } from 'unist-util-visit';
import { parseCardFenceBody } from '../cards/card-spec.js';

export const remarkCardFence: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, 'code', (node: Code) => {
      if (node.lang !== 'card') return;
      const result = parseCardFenceBody(node.value ?? '');
      const data = (node.data ??= {});
      if (!result.ok) {
        data.hProperties = {
          'data-card': 'error',
          'data-card-error': result.error,
        };
        return;
      }
      const s = result.spec;
      data.hProperties = {
        'data-card': '1',
        'data-card-count': String(s.cards.length),
        'data-card-layout': s.layout,
      };
    });
  };
};
