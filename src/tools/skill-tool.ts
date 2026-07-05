import { Type, type Static } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { SKILLS, loadSkill } from '../skills/index.js';
import type { Skill } from '../extension.js';

interface SkillToolDetails {
  skillId: string;
  skillName: string;
  contentLength: number;
}

/**
 * Build the use_skill tool against an explicit skill catalog so the
 * framework can inject framework + domain skills together.
 */
const paramsSchema = Type.Object({
  skill_id: Type.String({ description: 'ID of the skill to load.' }),
});

export function createSkillTool(skills?: Skill[]): AgentTool<typeof paramsSchema, SkillToolDetails | null> {
  const resolved = skills ?? SKILLS;
  const skillCatalog = resolved.map(s => `  - ${s.id}: ${s.description}`).join('\n');

  return {
    name: 'use_skill',
    label: 'Use Skill',
    description: `Load a specialist knowledge skill into your context. Load the relevant skill BEFORE you make any decision that the skill covers — the skill's frameworks will shape your output. Each skill stays in your context for the rest of the conversation; load each one only once. Available skills:\n${skillCatalog}`,
    parameters: paramsSchema,
    async execute(_id, params) {
      const { skill_id } = params as { skill_id: string };
      try {
        const loaded = loadSkill(skill_id);
        const text = `Loaded skill: ${loaded.name}\n\n${loaded.content}`;
        const details: SkillToolDetails = {
          skillId: loaded.id,
          skillName: loaded.name,
          contentLength: loaded.content.length,
        };
        const result: AgentToolResult<SkillToolDetails> = {
          content: [{ type: 'text', text }],
          details,
        };
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `❌ ${message}` }],
          details: null,
        };
      }
    },
  };
}
