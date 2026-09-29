import { describe, expect, it } from 'vitest'
import { BUILT_IN_ASSISTANTS } from './builtInAssistants'

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
