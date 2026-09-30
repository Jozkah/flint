import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { jevSuggestSkill, workProfileAsker } from '../jev'
import { WORK_PROFILES } from '../workProfiles'

const profiles = WORK_PROFILES.map((profile) => ({
  name: profile.id,
  description: profile.description,
}))

describe('Jev work-profile routing', () => {
  beforeEach(() => invoke.mockReset())

  it('uses rerank rather than the skill-suggestion endpoint for work profiles', async () => {
    invoke.mockResolvedValue({
      order: ['review', 'execute', 'plan'],
      fallback: null,
      model: 'jev',
    })

    await expect(jevSuggestSkill('review this pull request', profiles)).resolves.toMatchObject({
      skill: 'review',
      fallback: null,
    })
    expect(invoke).toHaveBeenCalledWith('jev_rerank', {
      query: 'review this pull request',
      candidates: profiles.map((profile) => ({
        id: profile.name,
        text: `${profile.name}: ${profile.description}`,
      })),
      k: profiles.length,
    })
    expect(invoke).not.toHaveBeenCalledWith('jev_suggest_skill', expect.anything())
  })

  it('returns no automatic profile when Jev abstains so local classification can decide', async () => {
    invoke.mockResolvedValue({ order: null, fallback: 'abstained', model: 'jev' })
    await expect(jevSuggestSkill('find why this crashes', profiles)).resolves.toEqual({
      skill: null,
      probability: null,
      fallback: 'abstained',
      model: 'jev',
    })
  })

  it('keeps real skill suggestions on the skill endpoint', async () => {
    invoke.mockResolvedValue({
      skill: 'typescript',
      probability: 0.9,
      fallback: null,
      model: 'jev',
    })
    const skills = [{ name: 'typescript', description: 'TypeScript help' }]
    await jevSuggestSkill('help with this TypeScript error', skills)
    expect(invoke).toHaveBeenCalledWith('jev_suggest_skill', {
      message: 'help with this TypeScript error',
      skills,
    })
  })
})

describe('Cowork work-profile Jev gate', () => {
  beforeEach(() => invoke.mockReset())

  it('asks only when rerank is on, since jev_rerank is governed by it', () => {
    expect(workProfileAsker('off')).toBeUndefined()
    expect(workProfileAsker('shadow')).toBeUndefined()
    expect(workProfileAsker('on')).toBeTypeOf('function')
  })

  it('routes the question through jev_rerank and yields the chosen profile', async () => {
    invoke.mockResolvedValue({ order: ['debug', 'execute'], fallback: null, model: 'jev' })
    await expect(workProfileAsker('on')?.('find why this crashes', profiles)).resolves.toBe('debug')
    expect(invoke).toHaveBeenCalledWith('jev_rerank', expect.anything())
  })
})
