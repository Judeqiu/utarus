# Open web signup (framework)

When `UTARUS_OPEN_SIGNUP_ENABLED=true`, Utarus exposes:

| Path | Purpose |
|------|---------|
| `GET /signup` | Signup page (framework default shell **or** domain shell) |
| `GET /signup/form.css` | Form-only styles (always framework) |
| `GET /signup/embed.js` | Mounts form into `#utarus-signup-root` |
| `GET /api/onboard/signup-config` | Branding + domain options |
| `GET /api/onboard/signup-reset` | Clear session when landing on signup |
| `POST /api/onboard/signup` | `{ display_name, email, password, reference? }` → create user |

**Does not auto-login.** Response includes `redirect` (usually chat-host `/login?email=…`).

## Architecture: domain page + framework form

```text
┌─────────────────────────────────────────────────────────┐
│  Full page (optional domain shell HTML/CSS/JS)          │
│  ┌──────────────────────┐  ┌──────────────────────────┐ │
│  │ Marketing / layout   │  │ #utarus-signup-root      │ │
│  │ (agent-owned)        │  │   └── Utarus form only   │ │
│  │                      │  │       (fields, submit)   │ │
│  └──────────────────────┘  └──────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

| Layer | Owner | What you can do |
|-------|--------|------------------|
| **Page shell** | Domain | Any layout, CSS, images, copy, scripts under `webUi.staticDir` |
| **Form section** | Utarus | Display name, email, password, validation, `POST /api/onboard/signup`, reference attribution |

Without a shell, Utarus serves a simple centered default page that still mounts the same form.

## Attribution (`reference`)

```
https://signup.example.com/signup?reference=partner-acme
```

(`?ref=` is a page-only alias; API field is `reference`.) Stored as `user.reference` when valid.

## Env

```env
UTARUS_OPEN_SIGNUP_ENABLED=true
UTARUS_PUBLIC_BASE_URL=https://chat.example.com
# UTARUS_POST_SIGNUP_REDIRECT=https://chat.example.com/login
# UTARUS_SESSION_COOKIE_DOMAIN=.example.com
# Fallback tagline when formChrome + no signupPage.tagline
# UTARUS_SIGNUP_TAGLINE=Your agent tagline.
# UTARUS_LOGIN_SHOW_ADVANCED=true
```

## Domain customization (`webUi.signupPage`)

Validated at `createFramework()` — invalid config fails fast.

### Full-page shell (recommended for product branding)

```ts
webUi: {
  agentKey: 'myagent',
  staticDir: resolve(__dirname, '../static'),
  signupPage: {
    // Relative to staticDir — becomes GET /signup
    shell: 'signup/shell.html',
    // Shell already has marketing; only mount form fields
    formChrome: false,
    submitLabel: 'Create account',
    accentColor: '#2563eb',
    footerNote: 'Already onboarded? Sign in with the same email.',
  },
},
```

**Shell requirements**

1. File exists under `webUi.staticDir` (no `..`).
2. Contains exactly one mount point:

```html
<div id="utarus-signup-root"></div>
```

3. Loads framework assets:

```html
<link rel="stylesheet" href="/signup/form.css">
<script src="/signup/embed.js" defer></script>
```

4. Domain CSS/images via `/domain-assets/<agentKey>/…` (same as other WebUI static files).

Minimal shell:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign up</title>
  <link rel="stylesheet" href="/domain-assets/myagent/signup/page.css">
  <link rel="stylesheet" href="/signup/form.css">
</head>
<body>
  <!-- your full-page decoration -->
  <main>
    <div id="utarus-signup-root"></div>
  </main>
  <script src="/signup/embed.js" defer></script>
</body>
</html>
```

Reference: **`examples/demo/static/signup/shell.html`** (split marketing + form).

### Form section copy (plain text only)

Used when `formChrome` is true (default). Never HTML — embed uses `textContent`.

| Field | Type | Purpose |
|-------|------|---------|
| `shell` | string | Relative path under `staticDir` for full-page HTML |
| `formChrome` | boolean | Include title/tagline/intro/bullets/notice in the form mount (default `true`) |
| `title` | string | Form h1 (default: agent name); also used for `document.title` |
| `tagline` | string | Subtitle; overrides `UTARUS_SIGNUP_TAGLINE` when set |
| `intro` | string[] | Paragraphs above fields |
| `bullets` | string[] | Benefit list |
| `notice` | string | Callout banner |
| `footerNote` | string | Line under sign-in link (always available) |
| `submitLabel` | string | Primary button (default: `Create account`) |
| `accentColor` | string | CSS hex for form button/links |

### Config API

`GET /api/onboard/signup-config`:

```json
{
  "enabled": true,
  "agentName": "Demo",
  "shell": true,
  "formChrome": false,
  "domainAssetsBase": "/domain-assets/demo",
  "title": "Demo",
  "tagline": "…",
  "intro": [],
  "bullets": [],
  "submitLabel": "Join Demo",
  "accentColor": "#0f766e",
  "footerNote": "…"
}
```

## Domain agents

Enable the flag and optionally set `webUi.signupPage`. Domain QR/Telegram BIND routes stay agent-owned.

Prefer a **domain shell** when product marketing needs a full layout; keep form fields on Utarus so validation and attribution stay consistent across agents.
