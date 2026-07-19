/**
 * remark-map-fence — tags ```map code nodes with data-map-* for MapEmbed.
 */

import type { Plugin } from 'unified';
import type { Root, Code } from 'mdast';
import { visit } from 'unist-util-visit';
import { parseMapFenceBody } from '../maps/map-spec.js';

export const remarkMapFence: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, 'code', (node: Code) => {
      if (node.lang !== 'map') return;
      const result = parseMapFenceBody(node.value ?? '');
      const data = (node.data ??= {});
      if (!result.ok) {
        data.hProperties = {
          'data-map': 'error',
          'data-map-error': result.error,
        };
        return;
      }
      const s = result.spec;
      const h: Record<string, string> = {
        'data-map': '1',
        'data-map-mode': s.mode,
      };
      if (s.query !== undefined) h['data-map-query'] = s.query;
      if (s.lat !== undefined) h['data-map-lat'] = String(s.lat);
      if (s.lng !== undefined) h['data-map-lng'] = String(s.lng);
      if (s.zoom !== undefined) h['data-map-zoom'] = String(s.zoom);
      if (s.label !== undefined) h['data-map-label'] = s.label;
      data.hProperties = h;
    });
  };
};
