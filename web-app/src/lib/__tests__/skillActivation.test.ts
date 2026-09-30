import { beforeEach, describe, expect, it, vi } from 'vitest'

const bodies: Record<string, string> = {}
vi.mock('@/lib/skillStore', () => ({
  storeScope: { kind: 'store' },
  readSkill: vi.fn(async (_scope: unknown, name: string) => {
    if (!(name in bodies)) throw new Error('not found')
    return bodies[name]
  }),
  listSkills: vi.fn(async () => []),
}))
const suggest = vi.fn()
vi.mock('@/lib/jev', () => ({
  jevSuggestSkill: (...args: unknown[]) => suggest(...args),
  shouldAskForSkill: (t: string) => t.trim().length >= 20 && !t.startsWith('/'),
}))

import {
  ACTIVATED_SKILL_MAX_CHARS,
  clearSkillBodyCache,
  latestUserText,
  matchedTrigger,
  resolveSkillActivation,
  skillActivationBlock,
  stripFrontmatter,
} from '../skillActivation'
import type { CatalogSkill } from '../skillCatalog'
import { useSkillActivation } from '@/hooks/useSkillActivation'
import { notifySkillsChanged } from '../skillEvents'
import { useJevSettings } from '@/hooks/useJevSettings'
import { useAutomationSettings } from '@/hooks/useAutomationSettings'

const skill = (name: string, extra: Partial<CatalogSkill> = {}) =>
  ({ name, description: `${name} does things`, model_invocable: true, ...extra }) as CatalogSkill

beforeEach(() => {
  for (const k of Object.keys(bodies)) delete bodies[k]
  clearSkillBodyCache()
  suggest.mockReset()
  useSkillActivation.setState({ alwaysOn: [], alwaysOff: [] })
  useJevSettings.setState({ skillMode: 'off' })
})

describe('stripFrontmatter', () => {
  it('drops the fence and keeps the body', () => {
    expect(stripFrontmatter('---\ndescription: x\n---\nDo the thing.\n')).toBe('Do the thing.\n')
  })
  it('leaves text without frontmatter alone', () => {
    expect(stripFrontmatter('just text')).toBe('just text')
    expect(stripFrontmatter('---\nnever closed')).toBe('---\nnever closed')
  })
})

describe('matchedTrigger', () => {
  const s = skill('review', { triggers: ['review pr', 'code review'] })
  it('matches a phrase on word edges, any case', () => {
    expect(matchedTrigger(s, 'Please REVIEW PR 42')).toBe('review pr')
    expect(matchedTrigger(s, 'do a code review, thanks')).toBe('code review')
  })
  it('does not fire inside another word', () => {
    expect(matchedTrigger(skill('pr', { triggers: ['pr'] }), 'improve this')).toBeNull()
  })
  it('never fires without triggers', () => {
    expect(matchedTrigger(skill('x'), 'anything')).toBeNull()
  })
})

describe('resolveSkillActivation', () => {
  it('activates an always-on skill in every conversation', async () => {
    bodies.caveman = '---\nalways: true\n---\nTalk terse.'
    const out = await resolveSkillActivation({
      text: 'hello',
      skills: [skill('caveman', { always: true }), skill('other')],
    })
    expect(out).toEqual([{ name: 'caveman', body: 'Talk terse.', why: 'always', mode: 'body' }])
  })

  it('lets the user turn a declared always-on skill off, and another on', async () => {
    bodies.a = 'A body'
    bodies.b = 'B body'
    useSkillActivation.getState().setAlways('a', false, true)
    useSkillActivation.getState().setAlways('b', true, false)
    const out = await resolveSkillActivation({
      text: 'hi',
      skills: [skill('a', { always: true }), skill('b')],
    })
    expect(out.map((o) => o.name)).toEqual(['b'])
  })

  it('activates a skill when the request contains a trigger phrase', async () => {
    bodies.debug = 'Find the root cause first.'
    const out = await resolveSkillActivation({
      text: 'this crashes, help me debug a crash',
      skills: [skill('debug', { triggers: ['debug a crash'] }), skill('idle', { triggers: ['deploy'] })],
    })
    expect(out).toEqual([{ name: 'debug', body: 'Find the root cause first.', why: 'trigger: debug a crash', mode: 'body' }])
  })

  it('leaves out skills only the human may invoke', async () => {
    bodies.hidden = 'x'
    const out = await resolveSkillActivation({
      text: 'hi',
      skills: [skill('hidden', { always: true, model_invocable: false })],
    })
    expect(out).toEqual([])
  })

  it('asks Jev only when suggestions are on, and never for a temporary chat', async () => {
    bodies.deploy = 'Ship carefully.'
    suggest.mockResolvedValue({ skill: 'deploy', probability: 0.9, fallback: null, model: 'm' })
    const args = { text: 'please ship the release to production now', skills: [skill('deploy')] }

    expect(await resolveSkillActivation(args)).toEqual([])
    expect(suggest).not.toHaveBeenCalled()

    useJevSettings.setState({ skillMode: 'on' })
    expect(await resolveSkillActivation({ ...args, temporary: true })).toEqual([])
    expect(suggest).not.toHaveBeenCalled()

    const out = await resolveSkillActivation(args)
    expect(out).toEqual([{ name: 'deploy', body: 'Ship carefully.', why: 'jev', mode: 'body' }])
  })

  it('applies nothing on its own when the user turned automatic skills off', async () => {
    bodies.caveman = '---\nalways: true\n---\nTalk terse.'
    useAutomationSettings.setState({ activateSkills: false })
    try {
      expect(
        await resolveSkillActivation({ text: 'hello', skills: [skill('caveman', { always: true })] })
      ).toEqual([])
    } finally {
      useAutomationSettings.setState({ activateSkills: true })
    }
  })

  it('ignores a Jev answer that names no installed skill, or a failure', async () => {
    useJevSettings.setState({ skillMode: 'on' })
    const args = { text: 'please ship the release to production now', skills: [skill('deploy')] }
    suggest.mockResolvedValueOnce({ skill: 'made-up', probability: 0.9, fallback: null, model: 'm' })
    expect(await resolveSkillActivation(args)).toEqual([])
    suggest.mockRejectedValueOnce(new Error('offline'))
    expect(await resolveSkillActivation(args)).toEqual([])
  })
})

describe('skillActivationBlock', () => {
  it('is empty for nothing', () => {
    expect(skillActivationBlock([])).toBe('')
  })

  it('labels each skill with why it is active', () => {
    const block = skillActivationBlock([
      { name: 'caveman', body: 'Talk terse.', why: 'always', mode: 'body' },
      { name: 'debug', body: 'Root cause.', why: 'trigger: crash', mode: 'body' },
    ])
    expect(block).toContain('# Active skills')
    expect(block).toContain('## caveman (always active)')
    expect(block).toContain('## debug (activated by trigger: crash)')
    expect(block).toContain('tools, folders and')
  })

  it('cuts a long body and points at skill_read for the rest', () => {
    const block = skillActivationBlock([
      { name: 'big', body: 'x'.repeat(ACTIVATED_SKILL_MAX_CHARS + 500), why: 'always', mode: 'body' },
    ])
    expect(block).toContain('Cut for length')
    expect(block).toContain('"big"')
    expect(block.length).toBeLessThan(ACTIVATED_SKILL_MAX_CHARS + 900)
  })
})

describe('a plugin skill is never trusted into the system prompt on its own say-so', () => {
  it('ignores a plugin skill that declares always', async () => {
    bodies['plug:mode'] = 'Do as the plugin says.'
    const out = await resolveSkillActivation({
      text: 'hello',
      skills: [skill('plug:mode', { always: true, plugin: 'plug' })],
    })
    expect(out).toEqual([])
  })

  it('takes a plugin skill the user turned on, with its instructions', async () => {
    bodies['plug:mode'] = 'Do as the user chose.'
    useSkillActivation.getState().setAlways('plug:mode', true, false)
    const out = await resolveSkillActivation({
      text: 'hello',
      skills: [skill('plug:mode', { always: true, plugin: 'plug' })],
    })
    expect(out).toEqual([
      { name: 'plug:mode', body: 'Do as the user chose.', why: 'always', mode: 'body' },
    ])
  })

  it('turns the trigger of a plugin skill into a nudge to read it, not its text', async () => {
    bodies['plug:review'] = 'SECRET PLUGIN TEXT'
    const out = await resolveSkillActivation({
      text: 'please review pr 12',
      skills: [skill('plug:review', { plugin: 'plug', triggers: ['review pr'] })],
    })
    expect(out).toEqual([
      { name: 'plug:review', body: '', why: 'trigger: review pr', mode: 'nudge' },
    ])
    const block = skillActivationBlock(out)
    expect(block).toContain('# Skills that match this request')
    expect(block).toContain('`skill_read`')
    expect(block).toContain('`plug:review`')
    expect(block).not.toContain('SECRET PLUGIN TEXT')
  })
})

describe('skill instructions are not kept past an edit', () => {
  it('re-reads a body after the skills changed', async () => {
    bodies.mode = 'first version'
    const s = [skill('mode', { always: true })]
    expect((await resolveSkillActivation({ text: 'hi', skills: s }))[0].body).toBe('first version')
    bodies.mode = 'second version'
    expect((await resolveSkillActivation({ text: 'hi', skills: s }))[0].body).toBe('first version')
    notifySkillsChanged()
    expect((await resolveSkillActivation({ text: 'hi', skills: s }))[0].body).toBe('second version')
  })
})

describe('latestUserText', () => {
  it('finds the newest user message with text', () => {
    const messages = [
      { id: '1', role: 'user', parts: [{ type: 'text', text: 'first' }] },
      { id: '2', role: 'assistant', parts: [{ type: 'text', text: 'reply' }] },
      { id: '3', role: 'user', parts: [{ type: 'text', text: 'second' }, { type: 'text', text: 'line' }] },
    ]
    expect(latestUserText(messages)).toEqual({ id: '3', text: 'second\nline' })
    expect(latestUserText([])).toBeNull()
  })
})
