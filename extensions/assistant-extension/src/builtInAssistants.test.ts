import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUILT_IN_ASSISTANTS, STARTER_ASSISTANTS } from './builtInAssistants'

describe('specialized built-in assistants', () => {
  it('ships the four requested assistants with unique identities and avatars', () => {
    expect(BUILT_IN_ASSISTANTS.map((assistant) => assistant.id)).toEqual([
      'quartz',
      'coal',
      'blaze',
      'redstone',
    ])
    expect(new Set(BUILT_IN_ASSISTANTS.map((assistant) => assistant.avatar)).size).toBe(4)
    expect(BUILT_IN_ASSISTANTS.every((assistant) => assistant.avatar.startsWith('/images/assistants/'))).toBe(true)
  })

  it('gives every assistant a distinct goal and behavior profile', () => {
    const prompts = BUILT_IN_ASSISTANTS.map((assistant) => assistant.instructions ?? '')
    expect(prompts[0]).toContain('research and analysis specialist')
    expect(prompts[1]).toContain('software engineering and debugging specialist')
    expect(prompts[2]).toContain('creative and product ideation specialist')
    expect(prompts[3]).toContain('systems, automation, and workflow specialist')

    const temperatures = BUILT_IN_ASSISTANTS.map(
      (assistant) => (assistant as any).parameters.temperature
    )
    expect(new Set(temperatures).size).toBe(4)
  })
})

describe('starter assistants', () => {
  const all = [...BUILT_IN_ASSISTANTS, ...STARTER_ASSISTANTS]

  it('has four starters with ids unique across all built-ins', () => {
    expect(STARTER_ASSISTANTS).toHaveLength(4)
    expect(new Set(all.map((a) => a.id)).size).toBe(all.length)
  })

  it('has the required fields and plain default tools', () => {
    for (const a of STARTER_ASSISTANTS) {
      expect(a.id).toMatch(/^[a-z-]+$/)
      expect(a.name).toBeTruthy()
      expect(a.avatar).toBeTruthy()
      expect(a.description).toBeTruthy()
      expect((a.instructions ?? '').length).toBeGreaterThan(80)
      expect((a as any).parameters.temperature).toBeGreaterThan(0)
      // same single, disabled retrieval tool as every other built-in
      expect((a as any).tools).toHaveLength(1)
      expect((a as any).tools[0].enabled).toBe(false)
    }
  })

  it('financial helper says it is not licensed advice', () => {
    const f = STARTER_ASSISTANTS.find((a) => a.id === 'emerald')!
    expect(f.instructions).toMatch(/not a licensed financial advisor/i)
  })
  it('starters use Minecraft-style image avatars that exist on disk', () => {
    const root = join(__dirname, '../../../web-app/public')
    for (const a of STARTER_ASSISTANTS) {
      expect(a.avatar.startsWith('/images/assistants/')).toBe(true)
      expect(existsSync(join(root, a.avatar))).toBe(true)
    }
  })
})
