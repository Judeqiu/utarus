# Open web signup (framework)

When `UTARUS_OPEN_SIGNUP_ENABLED=true`, Utarus exposes:

| Path | Purpose |
|------|---------|
| `GET /signup` | Public signup page (static) |
| `GET /api/onboard/signup-config` | Branding (`agentName`, `tagline`, `enabled`) |
| `GET /api/onboard/signup-reset` | Clear session when landing on signup |
| `POST /api/onboard/signup` | `{ display_name, email, password }` → create user |

**Does not auto-login.** Response includes `redirect` (usually chat-host `/login?email=…`).

## Env

```env
UTARUS_OPEN_SIGNUP_ENABLED=true
UTARUS_PUBLIC_BASE_URL=https://chat.example.com
# Optional override after signup (default: {UTARUS_PUBLIC_BASE_URL}/login)
# UTARUS_POST_SIGNUP_REDIRECT=https://chat.example.com/login
# UTARUS_SESSION_COOKIE_DOMAIN=.example.com
# UTARUS_SIGNUP_TAGLINE=Your agent tagline.
# Show Auth token / Redeem invite tabs on /login (default: hidden)
# UTARUS_LOGIN_SHOW_ADVANCED=true
```

Opt-in is required: open registration is a product/security choice per agent.

Login shows **password only** by default, with a **Create an account** link when open signup is on.

## Domain agents

No domain code required. Enable the flag and serve `/signup` (or a signup.* host reverse-proxying the agent). Domain-specific QR/Telegram BIND routes remain agent-owned (e.g. Binary `POST /api/onboard/register`).
