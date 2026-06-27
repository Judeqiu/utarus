# Admin

Admin operations on the Utarus framework: invite codes, admin onboard codes, and revocation.

## Two code types

| Pattern | Issued by | Granted to redeemer | Tools |
|---|---|---|---|
| `INV-XXXXXXXX` | Admin via `/invite` or `issue_invite_code` | A new user record (onboarding) | `issue_invite_code`, `redeem_invite_code`, `list_invite_codes` |
| `ADM-XXXXXXXX` | Admin via `/admincode` or `issue_admin_onboard_code` | Admin privileges (full bot access) | `issue_admin_onboard_code`, `redeem_admin_onboard_code`, `list_admin_onboard_codes`, `revoke_admin_onboard_code` |

## Flow

1. **Admin** issues a code → shares it out-of-band with the recipient.
2. **Recipient** sends the code in chat.
3. **Agent** validates the code, performs the grant, and confirms.

For `INV-` codes, the agent runs a short onboarding Q&A FIRST (display name + contact email), then calls `redeem_invite_code`. The `telegram_user_id` is always taken from the message context — never ask for it.

For `ADM-` codes, no Q&A — call `redeem_admin_onboard_code` immediately.

## Revocation

Admin onboard codes can be revoked BEFORE they're used. Once used, they cannot be revoked (the privilege has already been granted — to revoke the privilege itself, remove the user from `data/admin_ids.yaml`).

`revoke_admin_onboard_code` refuses:
- already-used codes (the grant has happened)
- already-revoked codes (idempotent refusal)

## Hard rules

- Invite codes are single-use. `redeem_invite_code` refuses if `used_by` is set.
- Admin codes are single-use. Same refusal.
- Custom codes must match the pattern (`INV-` or `ADM-` prefix). Auto-generated codes always do.
