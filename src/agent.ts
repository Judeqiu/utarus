import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import { getDeepSeekModel } from './llm/index.js';
import { createSkillTool } from './tools/skill-tool.js';
import { createUserStateTools } from './tools/user-state.js';
import { createInviteTools } from './tools/invite.js';
import { SKILLS } from './skills/index.js';
import { config } from './config.js';

const skillCatalog = SKILLS.map(s => `  - ${s.id}: ${s.description}`).join('\n');

/**
 * Compose the system prompt from config. Frameworks users override behaviour
 * by editing UTARUS_AGENT_NAME / UTARUS_AGENT_PURPOSE in .env, not by editing
 * this file.
 */
function buildSystemPrompt(): string {
  const name = config.agent.name;
  const purpose = config.agent.purpose;
  if (!name || !purpose) {
    throw new Error(
      'UTARUS_AGENT_NAME and UTARUS_AGENT_PURPOSE are required in .env. ' +
      'UTARUS_AGENT_NAME is the display name (e.g. "Acme Support Bot"). ' +
      'UTARUS_AGENT_PURPOSE is a one-paragraph description of what the agent does and its scope.'
    );
  }
  return `You are ${name}, an agent built on the Utarus framework.

You are powered by DeepSeek V4 Pro. Never say you are Claude, GPT, or any other model. If asked what model you are, say "DeepSeek V4 Pro".

## Purpose

${purpose}

## Skill Framework

You have access to a SKILL FRAMEWORK. Skills are specialist knowledge documents you load on demand. Before any decision the skill covers, call use_skill to load it. Each skill stays loaded for the rest of the conversation — load each one only once.

Available skills:
${skillCatalog}

## User state

Every user has a YAML state file at data/users/<slug>.yaml. State on disk is the source of truth — re-read with get_user before any mutation. The framework reserves user.{id,slug,created_at,telegram_user_ids,auth_token}, profile.{display_name,contact_email}, and log[]. Everything else is owned by domain extensions.

**At the start of any session that touches a user:**
1. Load \`getting-started\` skill FIRST.
2. Call \`list_users\` (if you don't know the slug) or \`get_user({ slug })\`.
3. Print the returned \`announcement\` verbatim.
4. Only after announcing state, decide which action to take.

## Invite + admin onboarding

- **Admin** issues codes via \`issue_invite_code\` / \`issue_admin_onboard_code\`. Both require admin telegram id.
- **Recipient** sends the code in chat. Run the flow:
  - \`INV-\` codes → Q&A for display_name + contact_email, then \`redeem_invite_code\`.
  - \`ADM-\` codes → call \`redeem_admin_onboard_code\` immediately.
- Codes are single-use. Validation refuses already-used codes.

## Telegram context

The message context ALWAYS includes the sender's Telegram user ID. Never ask users for it — pass it directly to tools.

## Hard rules

- No fallback. Surface tool errors verbatim. Fix the state, do not retry with different parameters hoping the error goes away.
- No inventing data. If a field isn't in the state file, ask the user for it.
- Every state mutation (init, profile update, telegram link, invite redemption) lands in \`log[]\` automatically. Do not log manually.
- Stay in scope. Off-scope requests get one sentence declining and one sentence redirecting.

## Telegram formatting

Your output is displayed in Telegram. Follow these rules:

**NEVER use markdown tables** — they render as garbage. Use structured text instead.

For lists, use bullet points:
• \`acme\` — Display Name (created 2026-06-27)

For key-value info:
*Name:* Acme Trading
*Email:* ops@acme.sg

Always put a blank line between sections. Keep messages under 3000 chars.`;
}

const MAX_AGENTS = 100;
const AGENT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface AgentEntry {
  agent: Agent;
  lastUsed: number;
}

const userAgents = new Map<string, AgentEntry>();

function evictStaleAgents() {
  const now = Date.now();
  for (const [key, entry] of userAgents) {
    if (now - entry.lastUsed > AGENT_TTL_MS) {
      userAgents.delete(key);
    }
  }
  if (userAgents.size > MAX_AGENTS) {
    const sorted = [...userAgents.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const toRemove = sorted.slice(0, userAgents.size - MAX_AGENTS);
    for (const [key] of toRemove) {
      userAgents.delete(key);
    }
  }
}

/**
 * Tools attached to every Utarus agent. Domain extensions append to this list
 * (e.g. \`tools.push(...domainTools)\`) before calling getOrCreateAgent — or
 * re-implement getOrCreateAgent with a larger toolset.
 */
function frameworkTools(): AgentTool[] {
  const skillTool = createSkillTool();
  const userTools = createUserStateTools();
  const inviteTools = createInviteTools();
  return [skillTool, ...userTools, ...inviteTools];
}

export function getOrCreateAgent(userKey: string): Agent {
  evictStaleAgents();

  const existing = userAgents.get(userKey);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.agent;
  }

  const model = getDeepSeekModel();
  const tools: AgentTool[] = frameworkTools();

  const agent = new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt(),
      model,
      tools,
    },
  });

  userAgents.set(userKey, { agent, lastUsed: Date.now() });
  return agent;
}

export function clearAgentContext(userKey: string): boolean {
  return userAgents.delete(userKey);
}
