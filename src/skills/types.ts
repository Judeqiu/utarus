export type SkillKind = 'knowledge';

export interface Skill {
  id: string;
  name: string;
  description: string;
  kind: SkillKind;
  keywords: string[];
}

export interface LoadedSkill {
  id: string;
  name: string;
  content: string;
}
