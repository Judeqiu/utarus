/**
 * Side-panel context — file previews and widget instances.
 */

import { createContext } from 'react';
import type { WidgetSpec } from './widgets/widget-spec.js';

export interface PanelFileAsset {
  type: 'file';
  url: string;
  filename: string;
  kind: string;
}

export interface PanelWidgetInstance {
  type: 'widget';
  spec: WidgetSpec;
}

export type PanelContent = PanelFileAsset | PanelWidgetInstance;

/** @deprecated — use PanelFileAsset / PanelContent */
export interface PanelAsset {
  url: string;
  filename: string;
  kind: string;
}

function panelNotReady(): never {
  throw new Error('PanelContext used outside provider — Chat must provide PanelContext');
}

export const PanelContext = createContext<(content: PanelContent | null) => void>(
  panelNotReady as (content: PanelContent | null) => void,
);

/** Back-compat alias used by AssetLink / AttachmentStrip */
export const AssetPanelContext = createContext<(asset: PanelAsset | null) => void>(
  () => {},
);

export function filePanelContent(a: PanelAsset): PanelFileAsset {
  return { type: 'file', url: a.url, filename: a.filename, kind: a.kind };
}
