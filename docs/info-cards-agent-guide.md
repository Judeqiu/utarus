# Info cards — agent integration guide

| | |
|--|--|
| **Audience** | Domain authors + the LLM (via purpose / skills) |
| **Tool** | `show_card` (platform built-in — always available) |
| **Fence** | ` ```card ` (WebUI inline media — **not** a side-panel widget) |
| **Shipped** | Utarus ≥ **1.10.0** |
| **Architecture** | [webui-chat-info-cards-design.md](./webui-chat-info-cards-design.md) |
| **Related** | Maps: [webui-chat-maps-design.md](./webui-chat-maps-design.md) · Panel widgets: [webui-chat-widgets.md](./webui-chat-widgets.md) |

This document is the **how to use** guide. Copy the **Purpose / skill snippet** (§8) into your domain agent so the model can present cards without guessing fences.

---

## 1. What this is

**Info cards** are **inline, designed presentation surfaces** in WebUI chat:

- Portrait “poker-card” chrome: title, optional subtitle, badges, key-value fields, short body, footer.
- **One card** → static face.
- **Two or more cards (max 8)** → a deck:
  - **Expanded** when the chat column is wide enough: every face fully visible, cascaded left-to-right.
  - **Collapsed** when space is tight: stack/fan (peek + click/drag/arrows to inspect).
- **Ephemeral** — recovered from the fence in chat `text` only. **No** `instanceId`, **no** BinDrive state, **no** `update_card`.

**Not for:**

| Need | Use instead |
|------|-------------|
| Editable long document | `show_widget` kind `rich-document` |
| Interactive 3D / custom panel app | domain `show_widget` kind |
| Place / map | `show_map` |
| Full HTML report | `post_html_report` / `write_report` |
| Freeform HTML / remote images in-thread | not supported (fail-fast) |

---

## 2. Tool (framework — do not reimplement)

| Tool | When |
|------|------|
| `show_card` | Whenever structured facts benefit from a designed card or comparison deck |

**Always:**

1. Call `show_card` first — **never invent** a ` ```card ` fence.
2. On **WebUI**, paste the tool’s **WEB ONLY** fence **once** in the final answer.
3. On **Telegram / Slack**, use only the summary lines from the tool result — **never** paste the fence (it renders as an ugly code block).
4. Prefer **at most one deck fence per final answer**.

Factory: `createShowCardTool()` (parameterless). Registered next to `show_map` for every Utarus process — **no domain registration**.

---

## 3. Parameters

Pass **either** `cards` **or** single-card convenience fields — **not both**.

### 3.1 Multi-card deck

```json
{
  "cards": [
    {
      "title": "Unit 12B",
      "subtitle": "2BR · River view",
      "body": "Bright corner unit with **stable** finishes. See [details](https://example.com).",
      "fields": [
        { "label": "Price", "value": "$1.2M" },
        { "label": "Area", "value": "1,240 sqft" }
      ],
      "badges": [{ "label": "Available", "tone": "success" }],
      "footer": "Updated today",
      "accent": "#0ea5e9",
      "icon": "home"
    },
    {
      "title": "Unit 8A",
      "subtitle": "1BR · Courtyard",
      "fields": [{ "label": "Price", "value": "$980K" }],
      "badges": [{ "label": "Waitlist", "tone": "warning" }],
      "icon": "building"
    }
  ]
}
```

### 3.2 Single card (convenience)

```json
{
  "title": "Pro plan",
  "subtitle": "Monthly",
  "fields": [
    { "label": "Price", "value": "$29/mo" },
    { "label": "Tokens", "value": "2M" }
  ],
  "badges": [{ "label": "Recommended", "tone": "info" }],
  "body": "Best for daily research and longer sessions.",
  "accent": "#0F766E",
  "icon": "star"
}
```

### 3.3 Per-card fields

| Field | Required | Rules |
|-------|----------|--------|
| `title` | **yes** | Non-empty after trim; max **80** chars; no control chars |
| `subtitle` | no | Max **120**; empty string if key present → **error** |
| `body` | no | Max **800** chars; markdown **subset** only (§4) |
| `fields` | no | 1–**12** `{ label, value }` if present; **empty array → error** |
| `badges` | no | 1–**6** `{ label, tone? }` if present; **empty array → error** |
| `footer` | no | Max **160** |
| `accent` | no | Exactly `#RGB` or `#RRGGBB` (hex only; not `red`) |
| `icon` | no | Must be in the allowlist (§5) |

| Field limits | Max |
|--------------|-----|
| Field label | 40 |
| Field value | 200 |
| Badge label | 24 |
| Cards per deck | **8** |

**Badge `tone` (optional):** `neutral` \| `success` \| `warning` \| `danger` \| `info`  
If omitted, the UI uses neutral chrome — the parser **does not** insert a default.

**Unknown keys** on a card or on the deck root → tool **fail-fast**.

---

## 4. Body markdown subset (fail-fast)

Allowed only:

- Paragraphs
- **Bold** (`**…**`)
- *Italic* (`*…*`)
- Inline `` `code` ``
- Links `[text](https://…)` — schemes **`http:` / `https:` only**

**Rejected** (tool returns `Invalid card: …`):

- HTML / tags (`<b>`, `a<b`, comments)
- Headings, lists, tables, images, fenced code blocks, blockquotes, hard breaks
- `javascript:`, `data:`, relative URLs without scheme

Comparisons like `price < 100` or `N<3` are OK. Write `a < b` with spaces if you need a less-than sign next to a letter.

---

## 5. Icon allowlist

Use **exact** kebab names (Lucide). Unknown icon → error.

```
building, home, map-pin, user, users, briefcase, file-text,
chart-bar, check-circle, alert-triangle, info, star, tag,
calendar, dollar-sign, layers
```

Do **not** invent names like `chart` or `dollar` — use `chart-bar` / `dollar-sign`.

---

## 6. Channels

| Channel | What to put in the final answer |
|---------|----------------------------------|
| **WebUI** | Summary (optional, helpful) **and** the WEB ONLY ` ```card ` fence once |
| **Telegram / Slack** | Summary lines only — **NEVER** paste ` ```card ` |

Tool success text shape:

```text
[Cards — use on all channels]
1. Title — subtitle
  Label: value
  [Badge]

---
WEB ONLY — paste this fence once in your final answer (do not invent fences):

```card
version: 1
layout: stack
cards: […]
```
```

---

## 7. Decision trees

### 7.1 When to use cards

```
User wants a comparison / options / status / profile / plan tier / short structured facts
  AND content is not a long editable document
  AND not a map / 3D panel
    → show_card
    → paste WEB ONLY fence on web
```

### 7.2 Single vs multi

```
One entity → convenience fields (title + …)
2–8 options to compare → cards: [ … ]
> 8 options → summarize in prose / table, or split into multiple turns (prefer ≤1 deck per answer)
```

### 7.3 Re-present later

```
No update_card / no instanceId.
Need a new presentation → call show_card again and paste a new fence.
```

---

## 8. Purpose / skill snippet (copy into domain)

```text
When structured facts benefit from designed cards (comparison, profile, status, short options):
- Call show_card — never invent a ```card fence.
- Single card: pass title (+ optional subtitle, body, fields, badges, footer, accent hex, icon).
- Multiple (2–8): pass cards: [{ title, … }, …].
- Body markdown subset only: bold, italic, inline code, http(s) links. No HTML, headings, lists, images.
- Icons only from: building, home, map-pin, user, users, briefcase, file-text, chart-bar,
  check-circle, alert-triangle, info, star, tag, calendar, dollar-sign, layers.
- Badge tone optional: neutral | success | warning | danger | info.
- Accent: #RGB or #RRGGBB only.
- WebUI: paste the WEB ONLY ```card fence once in the final answer. Prefer at most one deck per answer.
- Telegram/Slack: use only the tool summary lines — never paste the fence.
- Not for long documents (rich-document), maps (show_map), or interactive panel widgets (show_widget).
```

---

## 9. Common failures (fail-fast messages)

| Symptom | Fix |
|---------|-----|
| `pass either cards[] or single-card fields, not both` | Use only one form |
| `cards or title is required` | Provide `title` or non-empty `cards` |
| `icon must be one of: …` | Use allowlist kebab name |
| `accent must be #RGB or #RRGGBB hex` | e.g. `#0ea5e9`, not `blue` |
| `body must not contain HTML` | Strip tags; use markdown |
| `body contains disallowed markdown construct: list` | No bullets; use fields or short paragraphs |
| `body link scheme not allowed` | `https://` only |
| `fields must not be empty when present` | Omit `fields` or pass ≥1 row |
| `cards exceed max 8` | Fewer cards or split turns |

---

## 10. Domain ownership

| Layer | Owner |
|-------|--------|
| Tool `show_card`, fence grammar, SPA render, security | **Utarus** |
| When to show cards (purpose / skills) | **Domain** |
| Domain registration / staticDir | **Not required** for info cards |

**Rule:** Do not invent fences. Do not fork the SPA. Call the platform tool.

---

## 11. Demo

`examples/demo` purpose includes `show_card` usage. Login `demo` / `demo1234` and ask e.g. “Show three apartment options as cards.”
