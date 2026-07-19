/**
 * User State File — type model.
 *
 * One YAML file per user at data/users/<slug>.yaml. This is the single source
 * of truth that the agent reads and writes turn-by-turn.
 *
 * Framework reserves the top-level keys (`user`, `profile`, `log`). Domain
 * extensions add fields under `profile` or new top-level keys of their own —
 * the load/save machinery only enforces the load-bearing shape.
 *
 * Per project rules: no fallback, no defaults. Every accessor fails fast if a
 * required field is missing — callers populate state explicitly.
 */

export interface UserIdentity {
  id: string;          // UUID
  slug: string;        // lowercase kebab-case, used as filename
  created_at: string;  // YYYY-MM-DD
  telegram_user_ids?: number[];
  slack_user_ids?: string[];
  /** Auth token for any external portal/API the user needs to reach. */
  auth_token?: string;
  /** bcrypt hash of the user's web-login password (cost 10). Optional —
   *  legacy users backfilled via scripts/backfill-passwords.mjs. A user
   *  without this field cannot authenticate via username+password. */
  password_hash?: string;
  /**
   * Beta / grandfathered users: when true and billing is on, unlimited caps,
   * no intro expiry, full paid-plan features. New signups omit this (false/absent).
   */
  beta?: boolean;
}

/**
 * Extension point. Framework reads `display_name` and `contact_email`; the
 * rest is free-form for downstream apps to define.
 */
export interface UserProfile {
  display_name: string;
  contact_email: string;
  [key: string]: unknown;
}

export interface LogEntry {
  ts: string;          // YYYY-MM-DD
  action: string;
  [key: string]: unknown;
}

export interface UserState {
  user: UserIdentity;
  profile: UserProfile;
  log: LogEntry[];
}

export interface InviteCode {
  code: string;
  created_by: number;              // admin telegram id (0 when created via web admin)
  created_by_slack?: string;       // admin slack id (when issued from Slack)
  created_via_web?: string;        // admin username (when issued from the WebUI admin console)
  created_at: string;              // YYYY-MM-DD
  comment?: string;
  used_by?: number;                // telegram id of user who redeemed
  used_by_slack?: string;          // slack id of user who redeemed
  used_at?: string;
  slug?: string;                   // user slug created from this invite
}

export interface AdminOnboardCode {
  code: string;
  created_by: number;              // admin telegram id (0 when created via web admin)
  created_by_slack?: string;
  created_via_web?: string;        // admin username (when issued from the WebUI admin console)
  created_at: string;
  comment?: string;
  used_by?: number;
  used_by_slack?: string;
  used_at?: string;
  revoked?: boolean;
  revoked_at?: string;
}

/**
 * User-submitted report / feedback entry.
 * Stored in the global append-only file data/reporting.yaml.
 * Admins read via list_reports tool or WebUI Admin → Reports.
 */
export interface UserReport {
  id: string;                      // UUID
  created_at: string;              // ISO-8601 timestamp
  reporter_slug: string;           // user slug who filed the report
  text: string;                    // report body
  category?: string;               // e.g. feedback | bug | abuse | other
}
