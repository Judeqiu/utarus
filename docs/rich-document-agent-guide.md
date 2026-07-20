# Rich document gadget — agent integration guide

| | |
|--|--|
| **Audience** | Domain authors + the LLM (via purpose / skills) |
| **Kind id** | `rich-document` (platform standard — always registered) |
| **Shipped** | Utarus ≥ **1.7.0** |
| **Architecture** | [webui-chat-widgets-rich-document-design.md](./webui-chat-widgets-rich-document-design.md) |
| **Widgets overview** | [webui-chat-widgets.md](./webui-chat-widgets.md) |

This document is the **how to use** guide. Copy the **Purpose / skill snippet** (§9) into your domain agent so the model can drive the gadget without guessing.

---

## 1. What this gadget is

`rich-document` is a **side-panel rich-text document**:

- User edits in the WebUI panel (headings, lists, bold/italic, code, auto-linked URLs).
- Body is **Markdown** in durable BinDrive state (not chat history).
- Agent opens / updates / reads it through the same widget tools as other kinds.
- **WebUI only** for interactive use. Other channels: use tool result text; never invent ` ```widget ` fences on Telegram/Slack.

**Not for:** freeform HTML reports (`post_html_report`), maps (`show_map`), or domain 3D/custom kinds.

---

## 2. Tools (framework — do not reimplement)

| Tool | When |
|------|------|
| `show_widget` | First open: create instance + seed state + emit WEB ONLY fence |
| `update_widget` | Later: full-replace `state` and/or overlay `props` (same `instanceId` + `kind`) |
| `read_widget_state` | Before rewriting after the user may have edited or **submitted** |

**Always:**

1. Call the tool first — **never invent** a ` ```widget ` fence.
2. On WebUI, paste the tool’s WEB ONLY fence **once** in the final answer.
3. Keep `instanceId` and `kind: "rich-document"` stable for the life of that document.
4. `update_widget` **full-replaces** `state.data` (no deep merge). Always `read_widget_state` if the user may have changed the doc.

---

## 3. Data model (verify this first)

### Three layers

| Layer | Durable? | Holds | Who writes |
|-------|----------|--------|------------|
| **props** | No (fence snapshot) | Chrome only | Agent |
| **state** | **Yes** (BinDrive) | Document body + comments | Agent tools **and** user Save/Submit |
| **session UI** | No | Cursor, dirty flag, comments expand/collapse | Guest only |

### `props` (chrome only)

| Field | Type | Notes |
|-------|------|--------|
| `mode` | `"edit"` \| `"view"` | Omit → edit UI |
| `placeholder` | string ≤ 200 | Empty-editor hint |
| `allowSubmit` | boolean | Default **true** (show Submit). Set `false` for notes-only docs |
| `submitLabel` | string ≤ 40 | Default `"Submit"` (e.g. `"Turn in"`) |

**Forbidden in props:** `markdown`, `content`, `html`, `format`, `comments` — tool/host **fail-fast**.

### `state` (durable document)

```json
{
  "format": "utarus-rich-document-v1",
  "markdown": "# Title\n\nBody…\n",
  "comments": [
    {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "body": "Consider a more specific title.",
      "quote": "Title",
      "author": "agent",
      "createdAt": "2026-07-20T12:00:00.000Z"
    }
  ]
}
```

| Field | Required | Rules |
|-------|----------|--------|
| `format` | **yes** | Exactly `utarus-rich-document-v1` |
| `markdown` | **yes** | String; control chars (except `\n` `\r` `\t`) rejected |
| `comments` | no | Omit or array (max 50). Empty array may be normalized away |

**Comment object**

| Field | Required | Rules |
|-------|----------|--------|
| `id` | yes | UUID shape `8-4-4-4-12` hex (RFC v4 version bits **not** required) |
| `body` | yes | Non-empty, ≤ 2000 chars |
| `quote` | no | Anchor text in the document (prefer **visible plain text**, short) |
| `author` | yes | `"agent"` or `"user"` |
| `createdAt` | yes | Parseable ISO-8601 datetime |

**Size:** UTF-8 byte length of `JSON.stringify(state.data)` ≤ **512 KiB** (`WIDGET_STATE_DATA_MAX_BYTES`).

**Comments ≠ document rewrite.** Annotations live in `comments`; body lives in `markdown`. User **Save** keeps comments. Export DOCX/PDF exports **body only**.

---

## 4. Minimal open (copy-paste tool args)

```json
{
  "kind": "rich-document",
  "title": "Meeting notes",
  "props": { "mode": "edit" },
  "state": {
    "format": "utarus-rich-document-v1",
    "markdown": "# Meeting notes\n\n## Agenda\n\n- Item one\n"
  }
}
```

Assignment / turn-in example:

```json
{
  "kind": "rich-document",
  "title": "Essay — draft",
  "props": {
    "mode": "edit",
    "allowSubmit": true,
    "submitLabel": "Turn in",
    "placeholder": "Write your answer here…"
  },
  "state": {
    "format": "utarus-rich-document-v1",
    "markdown": "# Your answer\n\n"
  }
}
```

View-only review (no Submit):

```json
{
  "kind": "rich-document",
  "title": "Policy (read-only)",
  "props": { "mode": "view", "allowSubmit": false },
  "state": {
    "format": "utarus-rich-document-v1",
    "markdown": "# Policy\n\n…"
  }
}
```

---

## 5. User actions the agent must understand

| User action | What happens | Agent should |
|-------------|--------------|--------------|
| **Save** | BinDrive state updates; **no** new chat card; **no** agent turn | Nothing unless they ask |
| **Submit** | Save + **chat message** with `[Widget submit — kind=… instanceId=… revision=…]` | `read_widget_state` → process (grade, feedback, next step) |
| **Quote** (select text → Quote) | Chip on next user message; quote has `source: widget`, `messageId` = **instanceId** | Edit that span **or** add a comment (see §6) |
| **Edit without Save** | Only in panel memory | Don’t assume durable until Save/Submit or you wrote state |
| **Export DOCX/PDF** | Download only | Ignore |
| **Click link** | Host confirm → open URL | Ignore |

### Submit message shape (user turn)

```
Submitted document: **Essay — draft**

[Widget submit — kind=rich-document instanceId=<uuid> revision=<n>]
Call read_widget_state with this instanceId and process the submission…
```

**Normative agent response to Submit:**

1. Parse `instanceId` from the message.  
2. `read_widget_state({ instanceId })`.  
3. Use `data.markdown` (and `data.comments` if useful).  
4. Reply with feedback; optionally `update_widget` (comments and/or markdown).  
5. **Do not invent** document content.

---

## 6. Decision trees

### 6.1 User quoted a span (chip “Document · …”)

```
User wants text changed?
  YES → read_widget_state
        replace the quoted excerpt in markdown (first occurrence unless they say otherwise)
        keep existing comments
        update_widget(full state)
        open panel soft-refreshes if already open

  NO (feedback / review only)
        → read_widget_state
          leave markdown unchanged
          append comments[] entry:
            { id: <hex-uuid>, body, quote: <exact visible text>, author: "agent", createdAt: <ISO now> }
          update_widget(full state)
```

### 6.2 User asked for a document / notes / draft

```
show_widget(kind=rich-document, title, props, state with seed markdown)
paste WEB ONLY fence once
```

### 6.3 User asked to revise something you wrote earlier

```
read_widget_state(instanceId)   // mandatory if user may have edited
update_widget(same instanceId, full new state)
```

### 6.4 Assignment / exam / “write your answer here”

```
show_widget with allowSubmit true, clear submitLabel, empty or scaffolded markdown
Wait for Submit message (or user says they are done)
read_widget_state → score / feedback
Optional: comments for rubric notes without rewriting the answer
```

---

## 7. `update_widget` patterns

**Rewrite body (keep comments):**

```json
{
  "instanceId": "<same>",
  "kind": "rich-document",
  "title": "Meeting notes",
  "props": { "mode": "edit" },
  "state": {
    "format": "utarus-rich-document-v1",
    "markdown": "# Updated title\n\n…",
    "comments": [ /* prior comments array from read, if any */ ]
  }
}
```

**Add one comment only (read first, then):**

```json
{
  "instanceId": "<same>",
  "kind": "rich-document",
  "title": "Meeting notes",
  "props": {},
  "state": {
    "format": "utarus-rich-document-v1",
    "markdown": "<unchanged from read>",
    "comments": [
      /* ...existing */,
      {
        "id": "11111111-2222-3333-4444-555555555555",
        "body": "This claim needs a source.",
        "quote": "Revenue grew 12%",
        "author": "agent",
        "createdAt": "2026-07-20T15:30:00.000Z"
      }
    ]
  }
}
```

**Clear comments:** omit `comments` or pass `[]` after a full replace that drops them (only when intentional).

---

## 8. UX the panel provides (so you can explain it)

| UI | Purpose |
|----|---------|
| Toolbar (B / I / H1 / lists / code / …) | Formatting in **edit** mode |
| **Save** | Persist without agent |
| **Submit** | Persist + agent turn |
| **Export** DOCX / PDF | Download current body (including unsaved editor text) |
| **Quote** (on selection) | Attach span to next chat message |
| **Comments** rail | Expand/collapse strip; click comment → try to select `quote` in the doc |
| Bottom **status bar** | `saved · rev N`, `submitted · rev N`, errors |
| Auto-links | Type/paste `https://…` → link; click → host “Open external?” |

Agent **`update_widget`** on an open instance **soft-refreshes** the panel (no need for the user to click a new card). `show_widget` / first `open` auto-opens the panel on WebUI.

---

## 9. Purpose / skill snippet (paste into domain agent)

Use this (or a shortened version) in `DomainExtension.purpose` or a skill so the model knows the gadget:

```text
## Rich document side panel (platform kind `rich-document`)

When the user needs an editable document, notes, draft, essay, or structured answer:
1. Call show_widget with kind `rich-document`, a short title, props chrome only, and state:
   { "format": "utarus-rich-document-v1", "markdown": "…" }
2. Paste the WEB ONLY ```widget fence from the tool once into your final answer (WebUI only).
3. Never put body or comments in props. Never invent fences.

Tools: show_widget (first open), update_widget (full state replace, same instanceId),
read_widget_state (before rewrite after user edits/submits).

User Save = persist only. User Submit = persist + chat message with
[Widget submit — kind=rich-document instanceId=… revision=…] — then you MUST
read_widget_state and process the submission.

User quote chip from the document: edit that markdown span OR append state.comments
{ id (hex UUID), body, quote, author: "agent", createdAt: ISO } without changing markdown.

Comments are annotations (Comments rail). Markdown is the document. Prefer short
plain-text quote anchors that appear in the body.

Props: mode edit|view, placeholder, allowSubmit, submitLabel.
Cross-channel: never paste ```widget on Telegram/Slack.
```

---

## 10. Domain author checklist

- [ ] Utarus ≥ **1.7.0** (platform kind + assets).  
- [ ] Install builds `platform-widgets` (`prepare` / `npm run build:platform-widgets`).  
- [ ] Boot: manifest includes `rich-document`; `GET /platform-assets/widgets/rich-document/index.html` → 200.  
- [ ] Purpose/skills include §9 snippet (or equivalent).  
- [ ] Product flows choose Save-only vs Submit (assignments → Submit).  
- [ ] No domain registration of id `rich-document` (reserved).  

**No SPA fork.** No custom state paths. Use framework tools only.

---

## 11. Anti-patterns (fail-fast or broken UX)

| Don’t | Do |
|-------|-----|
| Put markdown in `props` | Put body in `state.markdown` |
| Invent widget fences | Call `show_widget` / `update_widget` |
| `update_widget` without read after user edit | `read_widget_state` first |
| Deep-merge state in your head | Full replace of `state` object |
| RFC-only UUID anxiety for comments | Any `8-4-4-4-12` hex id |
| Long markdown in `quote` | Short visible plain text |
| Treat Save as “send to agent” | Use **Submit** for agent processing |
| Paste ` ```widget ` on Telegram | Link/summary from tool text only |

---

## 12. Quick reference — tool call sequence

**Open once**

```
show_widget → paste fence → (user edits) → …
```

**User submitted**

```
read_widget_state(instanceId) → reason → optional update_widget → final answer
```

**User quoted + “improve this”**

```
read_widget_state → patch markdown → update_widget
```

**User quoted + “what do you think?”**

```
read_widget_state → append comment → update_widget → explain in chat
```

---

*End of rich-document agent guide.*
