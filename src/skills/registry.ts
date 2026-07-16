import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Skill, LoadedSkill } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const KNOWLEDGE_DIR = resolve(__dirname, 'knowledge');

/**
 * Skill catalog. To add a new skill, drop a markdown file in
 * src/skills/knowledge/<id>.md and add an entry here. The description must be
 * specific enough that the LLM can pick the right skill from the catalog
 * alone — the LLM never sees the file content until it calls use_skill.
 */
export const SKILLS: readonly Skill[] = [
  {
    id: 'getting-started',
    name: 'Getting Started',
    description: 'Load at the START of any session that touches a user record — onboarding, looking someone up, or refreshing state. Owns the framework conventions: how state files are shaped, when to call get_user vs list_users, and the invite/admin-code flow.',
    kind: 'knowledge',
    keywords: ['user', 'onboarding', 'state', 'invite', 'admin', 'getting started', 'framework'],
  },
  {
    id: 'admin',
    name: 'Admin',
    description: 'Load when the user asks about admin operations: issuing invite codes, issuing admin onboard codes, listing codes, revoking codes, escalating privileges, or reviewing user reports / feedback in the reporting log. Defines the code patterns (INV-XXXXXXXX for invites, ADM-XXXXXXXX for admin onboard) and list_reports / data/reporting.yaml.',
    kind: 'knowledge',
    keywords: ['admin', 'invite', 'onboard', 'code', 'revoke', 'privilege', 'telegram', 'report', 'reporting', 'feedback'],
  },
];

/**
 * Domain-registered skills whose content is supplied inline (the framework
 * reads its own skills from disk; a domain ships its skill markdown in its
 * own package and registers it here).
 */
const domainSkills = new Map<string, string>();

/** Register a domain skill's markdown content so use_skill can load it. */
export function registerDomainSkill(id: string, content: string): void {
  domainSkills.set(id, content);
}

/** All skill ids (framework + registered domain). */
export function allSkillIds(): string[] {
  return [...SKILLS.map(s => s.id), ...domainSkills.keys()];
}

export function getSkill(id: string): Skill | undefined {
  return SKILLS.find(s => s.id === id);
}

export function loadSkill(id: string): LoadedSkill {
  const skill = getSkill(id);
  if (skill) {
    if (skill.kind !== 'knowledge') {
      throw new Error(`Skill "${id}" is not a knowledge skill (kind=${skill.kind})`);
    }
    const filePath = resolve(KNOWLEDGE_DIR, `${id}.md`);
    const content = readFileSync(filePath, 'utf-8');
    return { id: skill.id, name: skill.name, content };
  }

  const domainContent = domainSkills.get(id);
  if (domainContent !== undefined) {
    return { id, name: id, content: domainContent };
  }

  throw new Error(`Unknown skill "${id}". Available: ${allSkillIds().join(', ')}`);
}
