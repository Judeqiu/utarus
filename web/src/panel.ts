/**
 * Side-panel context — components deep in the markdown tree (AssetLink) or in
 * attachment cards call `open(asset)` to show the report in the right-hand
 * panel instead of navigating away. Provided by the Chat page.
 */

import { createContext } from 'react';

export interface PanelAsset {
  url: string;
  filename: string;
  kind: string;
}

export const AssetPanelContext = createContext<(asset: PanelAsset | null) => void>(
  () => {},
);
