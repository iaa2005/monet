/**
 * Skills Store — manages available agent skills.
 */

import { create } from 'zustand'

export interface Skill {
  name: string
  description: string
  enabled: boolean
  builtIn: boolean
}

const BUILTIN_SKILLS: Skill[] = [
  {
    name: 'code-review',
    description: 'Review code for bugs, style issues, and improvements',
    enabled: true,
    builtIn: true,
  },
  {
    name: 'refactor',
    description: 'Refactor code for better structure and readability',
    enabled: true,
    builtIn: true,
  },
  {
    name: 'explain',
    description: 'Explain how code works in detail',
    enabled: true,
    builtIn: true,
  },
  {
    name: 'test-gen',
    description: 'Generate unit tests for functions and modules',
    enabled: false,
    builtIn: true,
  },
  {
    name: 'docs',
    description: 'Generate documentation for code',
    enabled: false,
    builtIn: true,
  },
  {
    name: 'debug',
    description: 'Analyze and fix bugs',
    enabled: true,
    builtIn: true,
  },
  {
    name: 'optimize',
    description: 'Optimize code for performance',
    enabled: false,
    builtIn: true,
  },
]

interface SkillsStore {
  skills: Skill[]
  toggleSkill: (name: string) => void
  getActiveSkills: () => Skill[]
}

export const useSkillsStore = create<SkillsStore>((set, get) => ({
  skills: BUILTIN_SKILLS,

  toggleSkill: (name) => {
    set(s => ({
      skills: s.skills.map(sk =>
        sk.name === name ? { ...sk, enabled: !sk.enabled } : sk,
      ),
    }))
  },

  getActiveSkills: () => {
    return get().skills.filter(s => s.enabled)
  },
}))
