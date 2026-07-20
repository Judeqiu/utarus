# Side-panel widgets — domain agent integration

How a **domain agent** registers interactive side-panel widgets (e.g. 3D floor plans) and how the model should use them.

| | |
|--|--|
| **Audience** | Domain authors (Binary, Marie, Invage, demos, forks) |
| **Status** | Shipped in Utarus ≥ **1.6.0** (rich-document ≥ **1.7.0**) |
| **Architecture** | [webui-chat-widgets-design.md](./webui-chat-widgets-design.md) |
| **Rich document (agents)** | [rich-document-agent-guide.md](./rich-document-agent-guide.md) |
| **Info cards (agents)** | [info-cards-agent-guide.md](./info-cards-agent-guide.md) — inline `show_card` (not a panel widget) |
| **WebUI boot** | [webui-integration.md](./webui-integration.md) |
| **Reference demo** | [examples/demo](../examples/demo) (`floor-plan-3d`, `rich-document`, `show_card`) |

---

## 1. What the framework owns vs the domain

| Layer | Owner |
|-------|--------|
| Tools `show_widget` / `update_widget` / `read_widget_state` | **Utarus** |
| Fence grammar ` ```widget `, WidgetCard, side-panel host, strict sandbox | **Utarus** |
| Durable state store (BinDrive under `_utarus/widgets/`) + `GET/PUT /api/widgets/state/:id` | **Utarus** |
| Chat cards on agent tools **and** user “Save” | **Utarus** |
| Widget **kind** registration + static **IIFE** bundle under `staticDir` | **Domain** |
| Purpose / skill text (“when to open a floor plan”) | **Domain** |
| Kind-specific geometry / UI inside the iframe | **Domain** |

**Rule:** Do not fork the SPA. Register kinds on `DomainWebUiExtension.widgets` and ship static files. The agent calls framework tools only.

---

## 2. Minimal domain registration

```ts
// domain: extension.ts
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { DomainExtension } from 'utarus';

const __dirname = dirname(fileURLToPath(import.meta.url));
const staticDir = resolve(__dirname, '../static'); // must exist at boot

export const myExtension: DomainExtension = {
  purpose: `… When the user needs an interactive floor plan, call show_widget
with kind floor-plan-3d, title, props, and initial state; paste the WEB ONLY
\`\`\`widget fence into your final answer. Never invent fences. …`,

  tools: (userSlug, isAdmin) => [/* domain tools */],
  skills: [],

  webUi: {
    agentKey: 'myagent',           // → /domain-assets/myagent/…
    productName: 'My Agent',
    staticDir,                     // required if widgets.length > 0
    widgets: [
      {
        id: 'floor-plan-3d',       // kebab-case; not reserved (html-bundle is platform)
        label: '3D floor plan',
        runtime: 'iframe-bundle',
        entryHtml: 'widgets/floor-plan-3d/index.html', // relative to staticDir
        sandboxProfile: 'strict',  // required; only 'strict' in v1
        supportsUpdate: true,      // required
        supportsPersistence: true, // required; true ⇒ durable BinDrive state
      },
    ],
  },
};
```

### Boot validation (fail-fast)

`createFramework` throws if:

- Widget ids collide or use reserved `html-bundle`
- `supportsPersistence: true` without `supportsUpdate: true`
- `staticDir` / `entryHtml` file missing
- Required fields omitted (no silent defaults)

### Static layout

```
static/
  widgets/
    floor-plan-3d/
      index.html          # <script src="./main.js"> — NOT type="module"
      main.js             # classic IIFE bundle (deps inlined)
      vendor/…            # optional vendored libs (e.g. three.min.js)
```

Entry URL at runtime:

`/domain-assets/<agentKey>/widgets/floor-plan-3d/index.html`

Files are **world-readable** (no session auth). Do not put secrets in staticDir.

---

## 3. Tools the model should call

All tools are **framework built-ins** (available when WebUI process runs). Closed over the signed-in **user slug** (state is **user-owned** in v1).

### `show_widget` — first open

| Param | Required | Notes |
|-------|----------|--------|
| `kind` | yes | Registered id |
| `title` | yes | Panel + card title |
| `props` | yes | Plain object; small bootstrap/overlay (≤ 64 KiB) |
| `state` | if `supportsPersistence` | Initial durable document |
| `instanceId` | no | UUID; generated if omitted |
| `summary` | no | One-line card subtitle |
| `entry` | only `html-bundle` | Same-origin path allowlist |

**After success:** paste the **WEB ONLY** ` ```widget ` fence from the tool result into the final assistant message (once). Do **not** invent fences.

### `update_widget` — later turns

- Same `instanceId` + same `kind` as open  
- Pass `state` for full replace of durable data (optimistic revision)  
- Pass `props` for non-durable overlay (e.g. highlight flash)  
- At least one of `props` / `state` required  

### `read_widget_state` — inspect user edits

Returns `revision` + `data` JSON so the agent can reason about camera, rooms, etc. after the user saves.

### Cross-channel

- **WebUI:** fence → card + panel  
- **Telegram / Slack:** use tool text only; **never** paste ` ```widget ` (ugly code blocks)

---

## 4. Data model (props vs state)

| Layer | Who writes | Durable? | Where |
|-------|------------|----------|--------|
| **props** | Agent (fence / tool) | Event snapshot | Chat fence (small) |
| **state** | Agent tools **and** user (Save in panel) | **Yes** | BinDrive `data/drive/<userSlug>/_utarus/widgets/<instanceId>/state.json` |
| **session UI** | Widget JS | No | iframe memory |

- After create, **state is source of truth** for persistent kinds.  
- User **Save view** (or equivalent) → host `state_save` → store + **assistant chat card**.  
- Max `state.data` UTF-8 size: **512 KiB**. Full replace on save (no deep-merge). Revision conflicts fail-fast.

---

## 5. Guest bridge (domain bundle)

Iframe sandbox: **`allow-scripts` only** (opaque origin — no parent cookies).

Host → guest: `init` / `update` / `state_saved` / `state_error`  
Guest → host: `ready` / `error` / `state_save` / `resize`  

```js
// message shape
{ channel: 'utarus-widget', type: 'ready', instanceId: '…' }
{ channel: 'utarus-widget', type: 'state_save', instanceId, expectedRevision, data: { /* full state */ } }
```

On `init`, hydrate from `state.data` (+ `props` for chrome). Call `ready` after first paint. Do **not** call `/api/files` from the guest — host mediates state.

**ES modules (`type="module"`) are not supported** under strict sandbox in v1. Bundle as classic IIFE.

---

## 6. Platform kinds

### `html-bundle`

For static HTML already published to BinDrive/`/reports/`:

- `supportsUpdate: false`, `supportsPersistence: false`  
- Pass `entry` allowlisted path  
- No bridge / no `update_widget`  

Prefer domain kinds for interactive apps.

### `rich-document` (platform standard)

Editable Markdown document in the side panel. Always registered by Utarus (no domain `staticDir`).

```ts
// show_widget args
{
  kind: 'rich-document',
  title: 'Meeting notes',
  props: { mode: 'edit' }, // optional: mode 'edit'|'view', placeholder ≤200 chars
  state: {
    format: 'utarus-rich-document-v1',
    markdown: '# Notes\n\n- **Ship** it\n',
  },
}
```

- User edits in the panel → **Save** (or Cmd/Ctrl+S) → durable BinDrive state (revision bumps in store only)  
- **No new chat card on each Save** — documents are not versioned in history; the original open card always reloads the latest state  
- **Export** DOCX / PDF from the panel (host-mediated download; exports **current editor content**, including unsaved edits)  
- **Quote to chat**: select text in the document → floating **Quote** → chip above the composer (same path as conversation quotes; agent sees widget provenance)  
- **Comments** (optional `state.comments[]`): agent/user annotations that do **not** change `markdown`. Shape: `{ id, body, quote?, author: "agent"|"user", createdAt }`. Shown in a Comments rail; click jumps to the quoted span when found.  
- **Submit** (toolbar): saves durable state, then posts a chat turn so the agent can process the submission (`read_widget_state`). Props: `allowSubmit` (default true), `submitLabel` (default `"Submit"`). **Save** only persists (no agent turn).  
- Agent reads user edits with `read_widget_state`  
- **Never** put document body or comments in `props`  
- **Agent workflow guide:** [rich-document-agent-guide.md](./rich-document-agent-guide.md) (purpose snippet, submit/quote/comment decision trees)  
- Design: [webui-chat-widgets-rich-document-design.md](./webui-chat-widgets-rich-document-design.md)

---

## 7. Smoke checklist (domain)

1. Boot agent: no throw from `assertWidgetRegistrations`  
2. WebUI login → `GET /api/webui/manifest` includes your kind  
3. `GET /domain-assets/<agentKey>/…/index.html` → 200  
4. Chat: “open a floor plan” → tool chip `show_widget` → white **widget card** → side panel  
5. Orbit / edit → Save → new card in thread; state file under `data/drive/<slug>/_utarus/widgets/`  
6. Reopen card → state restored without re-running the agent  
7. Telegram: no ` ```widget ` in outbound (link/summary only)

---

## 8. Reference: demo floor plan

| | |
|--|--|
| Kind | `floor-plan-3d` |
| Files | `examples/demo/static/widgets/floor-plan-3d/` |
| Registration | `examples/demo/src/extension.ts` → `webUi.widgets` |
| Try | `cd examples/demo && npm run dev` → login `demo` / `demo1234` → ask for unit 12B floor plan |

Example tool args:

```json
{
  "kind": "floor-plan-3d",
  "title": "Unit 12B – 2-Bedroom Layout",
  "props": { "unitLabel": "12B", "units": "metric" },
  "state": {
    "rooms": [
      { "id": "living", "polygon": [[0,0],[5,0],[5,4],[0,4]] },
      { "id": "kitchen", "polygon": [[5,0],[8,0],[8,3],[5,3]] },
      { "id": "bed", "polygon": [[0,4],[4,4],[4,7],[0,7]] }
    ],
    "levels": 1,
    "camera": { "theta": 0.9, "phi": 0.7, "radius": 14 },
    "highlightRoomId": null
  }
}
```

---

## 9. Version / pin

Domain packages should pin **utarus ≥ 1.6.0** (or the commit that includes widgets + `web/dist`). After upgrade, rebuild the domain process so it loads the new `dist/` and SPA.
