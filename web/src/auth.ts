/**
 * Auth helpers — session cookie lives on /api requests, the client just
 * needs to know whether it's logged in (via GET /api/chat/agent) and how
 * to log out.
 */

import type { AgentStatus, SessionUser } from './types.js';

const SESSION_KEY = 'utarus_session_user';

export function setStoredSession(user: SessionUser): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(user));
}

export function getStoredSession(): SessionUser | null {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as SessionUser;
    if (v && (v.type === 'user' || v.type === 'admin') && typeof v.slug === 'string') {
      return v;
    }
  } catch {
    // fallthrough
  }
  return null;
}

export function clearStoredSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

/**
 * Validate the session by hitting the agent status endpoint. 401 → not logged in.
 */
export async function fetchAgentStatus(signal?: AbortSignal): Promise<AgentStatus> {
  const res = await fetch('/api/chat/agent', {
    method: 'GET',
    credentials: 'include',
    signal,
  });
  if (res.status === 401) {
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    throw new Error(`Status ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as AgentStatus;
}

export async function logout(): Promise<void> {
  // The /logout endpoint clears the cookie and redirects; we just navigate.
  window.location.href = '/logout';
}
