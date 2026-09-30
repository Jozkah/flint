import { describe, expect, it } from 'vitest'
import {
  SKILL_CATALOG_BUDGET_CHARS,
  setCachedSkillCatalog,
  skillCatalogBlock,
  skillSummary,
} from '../skillCatalog'
import { buildCoworkSystemPrompt } from '../coworkPrompt'
import type { SkillMeta } from '../skillStore'

type Skill = SkillMeta & { model_invocable?: boolean }

const skill = (name: string, description = 'does a thing', extra: Partial<Skill> = {}) =>
  ({
    name,
    description,
    user_invocable: true,
    model_invocable: true,
    needs: [],
    ...extra,
  }) as Skill

describe('skillCatalogBlock', () => {
  it('is empty when no skill is installed', () => {
    expect(skillCatalogBlock([])).toBe('')
    setCachedSkillCatalog(null)
    expect(skillCatalogBlock()).toBe('')
  })

  it('names each skill and tells the model to read it first', () => {
    const block = skillCatalogBlock([skill('theme-factory', 'Style artifacts with a theme')])
    expect(block).toContain('# Skills')
    expect(block).toContain('- `theme-factory`: Style artifacts with a theme')
    expect(block).toContain('`skill_read`')
    expect(block).toContain('`file` argument')
  })

  it('leaves out skills only the human may invoke, and lists plugin skills last', () => {
    const block = skillCatalogBlock([
      skill('plug:zeta', 'from a plugin', { plugin: 'plug' }),
      skill('hidden', 'user only', { model_invocable: false }),
      skill('alpha'),
    ])
    expect(block).not.toContain('hidden')
    expect(block.indexOf('`alpha`')).toBeLessThan(block.indexOf('`plug:zeta`'))
  })

  it('counts what the budget cut instead of listing it', () => {
    const many = Array.from({ length: 400 }, (_, i) => skill(`skill-${i}`, 'x'.repeat(100)))
    const block = skillCatalogBlock(many)
    expect(block.length).toBeLessThan(SKILL_CATALOG_BUDGET_CHARS + 1200)
    expect(block).toMatch(/\d+ more skills are not listed here/)
  })

  it('cuts a long description to one line', () => {
    expect(skillSummary('first line\nsecond line')).toBe('first line')
    expect(skillSummary('y'.repeat(300)).length).toBe(120)
  })
})

describe('the Cowork prompt carries the catalogue', () => {
  const base = {
    workspacePath: '/w',
    readOnlyFolder: null,
    subagentNames: [],
    skillsBlock: skillCatalogBlock([skill('deploy')]),
  }

  it('includes it when the run can read skills', () => {
    const prompt = buildCoworkSystemPrompt({ ...base, availableTools: ['read', 'skill_read'] })
    expect(prompt).toContain('- `deploy`')
  })

  it('omits it when the run cannot', () => {
    const prompt = buildCoworkSystemPrompt({ ...base, availableTools: ['read'] })
    expect(prompt).not.toContain('- `deploy`')
  })

  it('carries an active skill even when the run cannot read skills', () => {
    const prompt = buildCoworkSystemPrompt({
      ...base,
      availableTools: ['read'],
      skillActivationBlock: '# Active skills\n\n## caveman (always active)\n\nTalk terse.',
    })
    expect(prompt).toContain('## caveman (always active)')
  })
})
